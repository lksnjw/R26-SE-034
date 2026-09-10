import { createHash, randomBytes } from "node:crypto";
import type { AnalysisProvider, AnalysisResponse, ProviderInvocationContext } from "../analysisprovider/types.js";
import type { Repository, StoredRecord } from "../repository/store.js";
import type { Executor } from "../runner/executor.js";
import { isGenerationFallbackEligible, OpenAICompatibleClient, OpenAICompatibleError } from "./openai-compatible.js";
import type { QueryMessage, QueryOptions, QueryToolDefinition, QueryTurnResult } from "../analysisprovider/query-types.js";
import { generationPromptHash } from "../prompts/contracts.js";

export const ANALYSIS_PROMPT_VERSION = "prompt/analysis/v2";
export const CANDIDATE_PROMPT_VERSION = "prompt/candidate/v7";

export type RuntimeProviderConfiguration = {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  apiKey: string;
  model: string;
  fallbackModel?: string;
  additionalModels?: string[];
  temperature: number;
  timeoutMs: number;
};

export class ProviderRuntime {
  #provider: ProvenanceAnalysisProvider | null = null;
  #rawClient: OpenAICompatibleClient | null = null;
  #configuration: RuntimeProviderConfiguration | null = null;
  #revision = "";

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a ProviderRuntime instance with its required state.
   ******************************************************************************/
  constructor(readonly repository: Repository, readonly executor: Executor, readonly fetchImplementation?: typeof fetch) {}

  private authorityGuardedFetch(): typeof fetch {
    const assertAuthority = this.repository.assertAuthority.bind(this.repository), send = this.fetchImplementation ?? fetch;
    return (input, init) => { assertAuthority(); return send(input, init); };
  }

  /*******************************************************************************
   * Function: configured
   *
   * Reports whether a provider is active in the runtime.
   ******************************************************************************/
  get configured(): boolean { return this.#provider !== null; }
  /*******************************************************************************
   * Function: configuration
   *
   * Returns a copy of the active provider configuration.
   ******************************************************************************/
  get configuration(): RuntimeProviderConfiguration | null { return this.#configuration === null ? null : structuredClone(this.#configuration); }

  get binding(): { providerId: string; providerName: string; model: string; configurationRevision: string } | null {
    return this.#configuration === null ? null : { providerId: this.#configuration.id, providerName: this.#configuration.name,
      model: this.#configuration.model, configurationRevision: this.#revision };
  }

  catalog(): { configured: boolean; binding: ProviderRuntime["binding"]; models: string[] } {
    return { configured: this.configured, binding: this.binding, models: this.#configuration === null ? [] : configuredModels(this.#configuration) };
  }

  /** Capture clients, credentials, configuration and model once. Never installs
   * the selected chat model into the global executor or administration default. */
  snapshot(requestedModel?: string): ProviderRuntime {
    if (this.#configuration === null || this.#provider === null) throw new Error("Provider is not configured");
    const selected = requestedModel?.trim() || this.#configuration.model;
    if (!configuredModels(this.#configuration).includes(selected)) throw new Error("Requested model is not in the configured model catalog");
    const scoped = new ProviderRuntime(this.repository, this.executor, this.fetchImplementation);
    scoped.#configuration = structuredClone({ ...this.#configuration, model: selected });
    scoped.#provider = this.#provider;
    scoped.#rawClient = this.#rawClient;
    scoped.#revision = this.#revision;
    return scoped;
  }

  /** Restore authenticated private worker configuration without activating it
   * globally. The caller owns input authentication and job/actor fencing. */
  restoreCaptured(configuration: RuntimeProviderConfiguration, revision: string): ProviderRuntime {
    validateRuntimeProviderConfiguration(configuration);
    if (!/^[a-f0-9]{32}$/.test(revision)) throw new Error("Invalid captured provider revision");
    const scoped = new ProviderRuntime(this.repository, this.executor, this.fetchImplementation);
    scoped.#configuration = structuredClone(configuration);
    scoped.#rawClient = new OpenAICompatibleClient({ ...configuration, fetchImplementation: scoped.authorityGuardedFetch() });
    scoped.#provider = new ProvenanceAnalysisProvider(scoped.#rawClient, this.repository, structuredClone(configuration), revision);
    scoped.#revision = revision;
    return scoped;
  }

  /*******************************************************************************
   * Function: activate
   *
   * Validates provider settings and installs the configured runtime clients.
   ******************************************************************************/
  activate(configuration: RuntimeProviderConfiguration): void {
    validateRuntimeProviderConfiguration(configuration);
    const rawClient = new OpenAICompatibleClient({ baseURL: configuration.baseURL, apiKey: configuration.apiKey, model: configuration.model, temperature: configuration.temperature, timeoutMs: configuration.timeoutMs, fetchImplementation: this.authorityGuardedFetch() });
    const revision = randomBytes(16).toString("hex");
    const provider = new ProvenanceAnalysisProvider(rawClient, this.repository, structuredClone(configuration), revision);
    this.#rawClient = rawClient;
    this.#provider = provider;
    this.#configuration = structuredClone(configuration);
    this.#revision = revision;
    this.executor.setAnalysisProvider(provider, configuration.model);
  }

  /*******************************************************************************
   * Function: activateStoredOrStatic
   *
   * Activates a stored provider or falls back to static configuration.
   ******************************************************************************/
  async activateStoredOrStatic(staticConfiguration: RuntimeProviderConfiguration | null): Promise<void> {
    const stored = await this.repository.read((state) => {
      const active = Object.values(state.providers).filter((item) => item.active === true);
      if (active.length > 1) throw new Error("Multiple active provider records require configuration repair");
      return active[0] ?? null;
    });
    if (stored !== null) this.activate(providerConfigurationFromRecord(stored));
    else if (staticConfiguration !== null) this.activate(staticConfiguration);
  }

  /*******************************************************************************
   * Function: generate
   *
   * Generates text with the active provider and prompt-version metadata.
   ******************************************************************************/
  async generate(prompt: string, promptTemplateVersion: string, signal?: AbortSignal, model = ""): Promise<AnalysisResponse> {
    if (this.#provider === null) throw new Error("LLM provider is not configured");
    const selected = model.trim() || this.#configuration!.model;
    if (!configuredModels(this.#configuration!).includes(selected)) throw new Error("Requested model is not in the configured model catalog");
    return this.#provider.generate(prompt, selected, signal, { promptTemplateVersion });
  }

  /*******************************************************************************
   * Function: generateCandidate
   *
   * Generates and validates a candidate, trying the fallback model when
   * eligible.
   ******************************************************************************/
  async generateCandidate(prompt: string, promptTemplateVersion: string, validateResponse: (response: AnalysisResponse) => void, signal?: AbortSignal, provenance: Omit<ProviderInvocationContext, "promptTemplateVersion" | "fallbackUsed"> = {}): Promise<AnalysisResponse> {
    if (this.#provider === null || this.#configuration === null) throw new Error("LLM provider is not configured");
    const provider = this.#provider;
    const models = [this.#configuration.model, this.#configuration.fallbackModel ?? ""].filter((value, index, all) => value.trim() !== "" && all.indexOf(value) === index);
    let lastError: unknown = new Error("generation did not run");
    for (const [index, model] of models.entries()) {
      try {
        return await provider.generateValidated(prompt, model, signal, { promptTemplateVersion, fallbackUsed: index > 0, ...provenance }, validateResponse);
      } catch (error) {
        lastError = error;
        if (index === 0 && models.length > 1 && isGenerationFallbackEligible(error)) continue;
        throw new Error(`Generation attempt failed for model ${JSON.stringify(model)}: ${errorText(error)}`);
      }
    }
    throw new Error(`All generation attempts failed: ${errorText(lastError)}`);
  }

  /*******************************************************************************
   * Function: queryWithTools
   *
   * Delegates tool-enabled chat completion to the active raw provider client.
   ******************************************************************************/
  async queryWithTools(messages: QueryMessage[], tools: QueryToolDefinition[], options: QueryOptions): Promise<QueryTurnResult> {
    if (this.#rawClient === null || this.#configuration === null) throw new Error("LLM provider is not configured");
    const client = this.#rawClient, configuration = structuredClone(this.#configuration), revision = this.#revision;
    const model = options.model?.trim() || configuration.model;
    if (!configuredModels(configuration).includes(model)) throw new Error("Requested model is not in the configured model catalog");
    const started = performance.now();
    const promptSha256 = `sha256:${createHash("sha256").update(JSON.stringify({ messages, tools })).digest("hex")}`;
    const record = async (status: "SUCCEEDED" | "FAILED", turn?: QueryTurnResult) => this.repository.mutate((state) => {
      const id = `inv_${randomBytes(8).toString("hex")}`;
      state.invocationProvenance[id] = { id, promptTemplateVersion: options.promptTemplateVersion ?? "prompt/query/v2", promptSha256,
        provider: configuration.type, providerId: configuration.id, configurationRevision: revision, model,
        inputTokens: turn?.inputTokens ?? 0, outputTokens: turn?.outputTokens ?? 0, measured: turn?.measured === true,
        latencyMs: elapsed(started), temperature: configuration.temperature, fallbackUsed: false, status, createdAt: new Date().toISOString(), ...options.context };
    });
    let turn;
    try { turn = await client.queryWithTools(messages, tools, { ...options, model }); }
    catch (error) { await record("FAILED"); throw error; }
    await record("SUCCEEDED", turn);
    return { ...turn, model, provider: configuration.type, configurationRevision: revision };
  }

  /*******************************************************************************
   * Function: test
   *
   * Tests a provider configuration with a small completion request.
   ******************************************************************************/
  async test(configuration: RuntimeProviderConfiguration, signal?: AbortSignal): Promise<AnalysisResponse> {
    validateRuntimeProviderConfiguration(configuration);
    const provider = new ProvenanceAnalysisProvider(createProviderClient(configuration, this.fetchImplementation), this.repository, configuration);
    return provider.generate("Reply with exactly OK.", configuration.model, signal, { promptTemplateVersion: "prompt/provider-test/v1" });
  }
}

export class ProvenanceAnalysisProvider implements AnalysisProvider {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a ProvenanceAnalysisProvider instance with its required state.
   ******************************************************************************/
  constructor(readonly inner: AnalysisProvider, readonly repository: Repository, readonly configuration: RuntimeProviderConfiguration, readonly revision = randomBytes(16).toString("hex")) {}

  /*******************************************************************************
   * Function: generate
   *
   * Generates text through the provenance-recording provider wrapper.
   ******************************************************************************/
  async generate(prompt: string, model: string, signal?: AbortSignal, context?: ProviderInvocationContext): Promise<AnalysisResponse> {
    return this.generateValidated(prompt, model, signal, context, () => undefined);
  }

  /*******************************************************************************
   * Function: generateValidated
   *
   * Generates a response, validates it, and records invocation provenance.
   ******************************************************************************/
  async generateValidated(prompt: string, model: string, signal: AbortSignal | undefined, context: ProviderInvocationContext | undefined, validateResponse: (response: AnalysisResponse) => void): Promise<AnalysisResponse> {
    const started = performance.now();
    const selectedModel = model.trim() === "" ? this.configuration.model : model;
    const promptTemplateVersion = context?.promptTemplateVersion ?? ANALYSIS_PROMPT_VERSION;
    try {
      const response = await this.inner.generate(prompt, selectedModel, signal, context);
      try { validateResponse(response); }
      catch (error) { throw error instanceof OpenAICompatibleError ? error : new OpenAICompatibleError(`Generated response was malformed: ${errorText(error)}`, "malformed"); }
      await this.record(prompt, promptTemplateVersion, response.provider, response.model, response.inputTokens, response.outputTokens, response.measured, elapsed(started), context?.fallbackUsed === true, "SUCCEEDED", context);
      return response;
    } catch (error) {
      await this.record(prompt, promptTemplateVersion, this.configuration.type, selectedModel, 0, 0, false, elapsed(started), context?.fallbackUsed === true, "FAILED", context);
      throw error;
    }
  }

  /*******************************************************************************
   * Function: record
   *
   * Stores provider invocation usage, timing, status, and prompt metadata.
   ******************************************************************************/
  private async record(prompt: string, promptTemplateVersion: string, provider: string, model: string, inputTokens: number, outputTokens: number, measured: boolean, latencyMs: number, fallbackUsed: boolean, status: "SUCCEEDED" | "FAILED", context?: ProviderInvocationContext): Promise<void> {
    await this.repository.mutate((state) => {
      const id = `inv_${randomBytes(8).toString("hex")}`;
      state.invocationProvenance[id] = {
        id,
        promptTemplateVersion,
        promptSha256: generationPromptHash(prompt, promptTemplateVersion),
        provider,
        providerId: this.configuration.id,
        configurationRevision: this.revision,
        model,
        inputTokens,
        outputTokens,
        measured,
        latencyMs,
        temperature: this.configuration.temperature,
        fallbackUsed,
        status,
        createdAt: new Date().toISOString(),
        ...(context?.traceId === undefined ? {} : { traceId: context.traceId }),
        ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...(context?.messageId === undefined ? {} : { messageId: context.messageId }),
        ...(context?.candidateId === undefined ? {} : { candidateId: context.candidateId }),
        ...(context?.workflowId === undefined ? {} : { workflowId: context.workflowId }),
        ...(context?.executionId === undefined ? {} : { executionId: context.executionId }),
        ...(context?.actor === undefined ? {} : { actor: context.actor }),
      };
    });
  }
}

/*******************************************************************************
 * Function: providerConfigurationFromRecord
 *
 * Converts a stored provider record into runtime configuration.
 ******************************************************************************/
export function providerConfigurationFromRecord(record: StoredRecord, timeoutMs = 60_000): RuntimeProviderConfiguration {
  return {
    id: stringValue(record.id),
    name: stringValue(record.name),
    type: stringValue(record.type),
    baseURL: stringValue(record.baseUrl),
    apiKey: stringValue(record.apiKey),
    model: stringValue(record.model),
    fallbackModel: stringValue(record.fallbackModel),
    additionalModels: Array.isArray(record.additionalModels) ? record.additionalModels.filter((value): value is string => typeof value === "string") : [],
    temperature: finiteNumber(record.temperature, 0),
    timeoutMs,
  };
}

/*******************************************************************************
 * Function: validateRuntimeProviderConfiguration
 *
 * Rejects incomplete or unsupported runtime provider settings.
 ******************************************************************************/
export function validateRuntimeProviderConfiguration(configuration: RuntimeProviderConfiguration): void {
  if (configuration.type !== "openai_compatible") throw new Error(`Unsupported configured provider type ${JSON.stringify(configuration.type)}`);
  if (configuration.baseURL.trim() === "") throw new Error("OpenAI-compatible base URL is required");
  if (configuration.apiKey.trim() === "") throw new Error("OpenAI-compatible API key is required");
  if (configuration.model.trim() === "") throw new Error("OpenAI-compatible model is required");
  if (configuration.model.includes(":latest") || (configuration.fallbackModel ?? "").includes(":latest")) throw new Error("OpenAI-compatible model IDs must be pinned and cannot use :latest");
  if (configuredModels(configuration).some((model) => model.length > 256 || model.includes(":latest"))) throw new Error("Configured model IDs must be bounded and pinned");
  if (!Number.isFinite(configuration.temperature)) throw new Error("OpenAI-compatible temperature must be finite");
  if (!Number.isInteger(configuration.timeoutMs) || configuration.timeoutMs <= 0) throw new Error("OpenAI-compatible timeout must be a positive integer");
}

/*******************************************************************************
 * Function: createProviderClient
 *
 * Creates an OpenAI-compatible client from runtime configuration.
 ******************************************************************************/
function createProviderClient(configuration: RuntimeProviderConfiguration, fetchImplementation?: typeof fetch): AnalysisProvider {
  return new OpenAICompatibleClient({ baseURL: configuration.baseURL, apiKey: configuration.apiKey, model: configuration.model, temperature: configuration.temperature, timeoutMs: configuration.timeoutMs, ...(fetchImplementation === undefined ? {} : { fetchImplementation }) });
}

function configuredModels(configuration: RuntimeProviderConfiguration): string[] {
  return [...new Set([configuration.model, configuration.fallbackModel ?? "", ...(configuration.additionalModels ?? [])].map((value) => value.trim()).filter(Boolean))];
}

/*******************************************************************************
 * Function: elapsed
 *
 * Returns nonnegative elapsed milliseconds with fractional precision.
 ******************************************************************************/
function elapsed(started: number): number { return Math.max(0, Math.round((performance.now() - started) * 1000) / 1000); }
/*******************************************************************************
 * Function: stringValue
 *
 * Returns a string value or an empty string for other types.
 ******************************************************************************/
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
/*******************************************************************************
 * Function: finiteNumber
 *
 * Returns a finite number or the supplied fallback.
 ******************************************************************************/
function finiteNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
