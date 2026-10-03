// Explicit LOCAL workspace against the isolated Docker MockERP stack.
// Separate port/account/memory state; no production registry or real model.
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";
import { qaReviewedDefinition } from "./qualify-erpbridge-qa-read.mjs";
import { loadConfig } from "../src/config/config.ts";
import { Repository } from "../src/repository/store.ts";
import { RegistryService } from "../src/registry/service.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { McpConnectionManager } from "../src/tools/mcp-connection-runtime.ts";
import { observeCapabilities, reviewCapability } from "../src/registry/capability-admission.ts";
import { Executor } from "../src/runner/executor.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ProviderRuntime } from "../src/providers/runtime.ts";
import { hashPassword } from "../src/authn/password.ts";
import { buildApp } from "../src/http/app.ts";
import { compileReadWorkflow } from "../src/workflows/compiled-read.ts";
import { SynthesisService } from "../src/synthesis/service.ts";

export function qaWorkflowBlueprint() {
  const schema = { type: "array", items: { type: "object" } }, sequence = (...nodes) => ({ kind: "sequence", nodes });
  return { name: "LOCAL Docker Department decision", description: "Synthetic Department read through ERPBridge, only on the selected Yes path. No production data or email.",
    trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { includeDepartments: { type: "boolean" } }, required: ["includeDepartments"], additionalProperties: false } } },
    steps: [{ id: "departments", action: "qa_list_departments", description: "Read synthetic Departments · Docker ERPBridge", parameters: {} }],
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: sequence(
      { kind: "if", id: "include_departments", predicate: { kind: "ref", source: "workflowInput", path: ["includeDepartments"] }, then: sequence({ kind: "action", nodeId: "departments" }), else: sequence(),
        merge: { schema, then: { kind: "ref", source: "nodeOutput", nodeId: "departments", path: ["structuredContent", "data"] }, else: { kind: "array", items: [] } } },
      { kind: "return", id: "answer", output: { schema, value: { kind: "ref", source: "nodeOutput", nodeId: "include_departments", path: ["value"] } } },
    ) } } };
}

export function qaModelReadBlueprint(kind = "analysis") {
  if (!["analysis", "agent"].includes(kind)) throw new Error("Unsupported synthetic model node");
  const node = { id: "count", kind, description: "LOCAL fixture count · actual synthetic Department input", instruction: kind === "agent" ? "Use the offered qa_list_departments read once, then return its actual Department count as departmentCount." : "Return the number of synthetic Departments in INPUT.data as departmentCount.",
    input: "{{departments.structuredContent}}", data_class: "internal", model: "local-planning-fixture", max_input_items: 100, max_input_chars: 20000, max_output_tokens: 256,
    output_schema: { type: "object", properties: { departmentCount: { type: "integer" }, ...(kind === "agent" ? { complete: { type: "boolean" } } : {}) }, required: ["departmentCount", ...(kind === "agent" ? ["complete"] : [])], additionalProperties: false },
    ...(kind === "agent" ? { allowed_actions: ["qa_list_departments"], completion_predicate: { path: ["complete"], equals: true }, max_total_tokens: 1024, max_rounds: 2, max_tool_calls: 1, max_wall_time_ms: 10000, max_concurrency: 1 } : {}) };
  return { name: `LOCAL Docker read and ${kind}`, description: "Actual Docker synthetic GET and an in-process count fixture, no real model or effect", trigger: { type: "manual" }, steps: [qaWorkflowBlueprint().steps[0], node] };
}

export function qaModelDecisionBlueprint(kind = "analysis") {
  const blueprint = qaModelReadBlueprint(kind);
  blueprint.name = `LOCAL Docker conditional ${kind}`;
  blueprint.trigger.config = { inputSchema: { type: "object", properties: { includeCount: { type: "boolean" } }, required: ["includeCount"], additionalProperties: false } };
  blueprint.steps[1].data_class = "restricted"; // Caller-input predicate is a control dependency.
  blueprint.metadata = { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [
    { kind: "action", nodeId: "departments" }, { kind: "if", id: "include_count", predicate: { kind: "ref", source: "workflowInput", path: ["includeCount"] },
      then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "count" }] }, else: { kind: "sequence", nodes: [] } },
  ] } } };
  return blueprint;
}

export function qaPlanningResponse(request, modelReadFixture = false) {
  // This injected fetch never reaches an external provider. The real broker
  // still validates every call against the reviewed Docker tool and actor.
  const system = request.messages?.find(message => message.role === "system")?.content ?? "";
  if (modelReadFixture && system.includes("TASK: WORKFLOW DRAFT SYNTHESIS")) {
    const input = JSON.parse(request.messages?.findLast(message => message.role === "user")?.content ?? "");
    const decisionKind = ["analysis", "agent"].find(value => input.USER_REQUEST === `Create a local workflow to read synthetic Departments and conditionally count them with ${value} on the Yes path.`);
    if (decisionKind) return { choices: [{ message: { content: stringify(qaModelDecisionBlueprint(decisionKind)) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const kind = ["analysis", "agent"].find(value => input.USER_REQUEST === `Create a local workflow to read synthetic Departments and count them with ${value}.`);
    if (!kind) throw new Error("Unsupported synthetic workflow synthesis request");
    const blueprint = qaModelReadBlueprint(kind);
    const hints = input.MODEL_SOURCE_HINTS_JSON;
    const sources = hints?.profile === "model-source-hints/v1" && hints.advisoryOnly === true && hints.scope === "primary-connection-only"
      ? hints.sources?.filter(source => source.toolId === "LOCAL-QA-DEPARTMENTS-READ" && source.action === "qa_list_departments" && source.connectionId === "erpbridge-default") : [];
    blueprint.steps[1].data_class = sources?.length === 1 && sources[0].review === "REVIEWED" && ["public", "internal", "confidential", "restricted"].includes(sources[0].dataClass) ? sources[0].dataClass : "restricted";
    return { choices: [{ message: { content: stringify(blueprint) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }
  if (modelReadFixture && (system.includes("TASK: BOUNDED DATA ANALYSIS") || system.includes("TASK: BOUNDED RUNTIME ERP AGENT"))) {
    const input = JSON.parse(request.messages?.findLast(message => message.role === "user")?.content ?? "");
    const agent = system.includes("TASK: BOUNDED RUNTIME ERP AGENT");
    if ((input.INSTRUCTION ?? input.TASK) !== qaModelReadBlueprint(agent ? "agent" : "analysis").steps[1].instruction ||
        !Array.isArray(input.INPUT?.data) || input.INPUT.data.length > 100) throw new Error("Unsupported synthetic model input");
    let rows = input.INPUT.data;
    if (agent) {
      const remoteName = "qa_list_departments.rev_MS4wLjA"; // Exact pinned 1.0.0 SDK contract, not the floating alias.
      if (!request.tools?.some(tool => tool.function?.name === remoteName)) throw new Error("Synthetic agent read was not offered");
      const results = request.messages.filter(message => message.role === "tool");
      if (!results.length) return { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "local-agent-department-read", type: "function", function: { name: remoteName, arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      if (results.length !== 1 || results[0].tool_call_id !== "local-agent-department-read") throw new Error("Unsupported synthetic agent tool result");
      const result = JSON.parse(results[0].content);
      if (result.source !== "untrusted_tool_result" || result.callId !== "local-agent-department-read" || result.toolName !== "qa_list_departments" || result.status !== "SUCCEEDED" || !Array.isArray(result.data?.structuredContent?.data) || result.data.structuredContent.data.length > 100) throw new Error("Unsupported synthetic agent tool result");
      rows = result.data.structuredContent.data;
    }
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ departmentCount: rows.length,
      ...(agent ? { complete: true } : {}) }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }
  if (system.includes("ONE SELECTED NODE PATCH")) return { choices: [{ message: { content: '{"description":"Synthetic Departments reviewed in the local Docker workspace"}' } }] };
  const latest = request.messages?.findLast(message => message.role === "user");
  let currentRequest;
  try { currentRequest = JSON.parse(latest?.content ?? "").USER_REQUEST; } catch { /* Not the supported interactive request envelope. */ }
  if (currentRequest !== "List the synthetic Departments from ERPBridge.") throw new Error("LOCAL planning fixture supports only the literal synthetic Department request; no real model is configured");
  const completed = request.messages?.some(message => message.role === "tool" && message.tool_call_id === "local-department-read");
  if (request.tools?.some(tool => tool.function?.name === "qa_list_departments") && !completed)
    return { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "local-department-read", type: "function", function: { name: "qa_list_departments", arguments: "{}" } }] } }] };
  if (completed) return { choices: [{ finish_reason: "stop", message: { content: "LOCAL planning fixture: the synthetic Department rows were retrieved through Docker ERPBridge. Inspect the saved tool answer for the actual data. No production records or emails were changed." } }] };
  throw new Error("LOCAL planning fixture supports only the explicit Department read and descriptive action-node edit; no real model is configured");
}

export function qaProviderConfiguration(createdAt, modelReadFixture = false) {
  return { id: "local-planning-fixture", name: "LOCAL planning fixture · no real model", type: "openai_compatible", baseURL: "https://fixture.invalid/v1", apiKey: "fixture-only-no-network", model: "local-planning-fixture", temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://fixture.invalid", runtimeAnalysisDataClasses: modelReadFixture ? ["internal"] : [], runtimeAgentDataClasses: modelReadFixture ? ["internal"] : [], interactiveDataClasses: ["restricted"], reviewedAt: createdAt, reviewedBy: { id: "qa", name: "LOCAL synthetic-only fixture review" } } };
}

export function assertRealProviderQaConfiguration(environment) {
  if (environment.LCWE_REAL_MODEL_QA !== "synthetic-docker-only" ||
      environment.GENERATION_BASE_URL !== "https://openrouter.ai/api/v1" || !environment.GENERATION_API_KEY?.trim() ||
      environment.GENERATION_MODEL_PRIMARY !== "deepseek/deepseek-v4.1-flash")
    throw new Error("Real-model QA requires explicit synthetic-only scope and the owner-selected OpenRouter model; credentials suppressed");
}

export async function createQaWorkspace({ modelReadFixture = false, realProvider = false } = {}) {
  if (realProvider) assertRealProviderQaConfiguration(process.env);
  const token = await readQaBridgeToken();
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=qa_list_departments&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Register the fixed synthetic Department resource before starting this workspace");
  const resources = await response.json();
  if (!Array.isArray(resources) || resources.length !== 1) throw new Error("Expected one exact synthetic resource");
  const definition = qaReviewedDefinition(resources[0]), directory = await mkdtemp(resolve(tmpdir(), "lcwe-docker-workspace-"));
  const files = [resolve(directory, "tools.json"), resolve(directory, "rules.json")], repository = new Repository(null);
  let runtime, app;
  try {
    await writeFile(files[0], JSON.stringify([definition]), { flag: "wx" }); await writeFile(files[1], "[]", { flag: "wx" });
    const registries = await RegistryService.load(...files), validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
    const config = loadConfig({ APP_ENV: "development", PORT: "8082", JWT_SECRET: randomBytes(48).toString("hex"), STORAGE_DRIVER: "memory", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
      ERPBRIDGE_BASE_URL: qaBaseURL, ERPBRIDGE_MCP_TOKEN: token, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"admin"}', CORS_ORIGINS: "http://127.0.0.1:5174,http://localhost:5174" });
    const createdAt = new Date().toISOString(), yaml = stringify(qaWorkflowBlueprint()), passwordHash = await hashPassword("Local-QA-only-2026!");
    compileReadWorkflow(yaml, [definition], "Platform Admin");
    const validation = await validator.validateAndIssueToken("qa_departments", yaml, "Platform Admin");
    if (!validation.result.passed) throw new Error("Local decision draft did not pass validation");
    await repository.mutate(state => {
      state.users.qa = { id: "qa", name: "LOCAL Docker QA", email: "qa@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "QA", departmentId: null, createdAt, lastLoginAt: null };
      state.passwordHashes.qa = passwordHash;
      state.workflows.qa_departments = { id: "qa_departments", name: qaWorkflowBlueprint().name, description: "LOCAL MockERP read only · memory state · no real model", owner: { id: "qa", name: "LOCAL Docker QA" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt, updatedAt: createdAt, yaml, archived: false };
      state.versions.qa_departments = [{ version: 1, artifactState: "DRAFT", yaml }];
      state.chats.qa_chat = { id: "qa_chat", ownerId: "qa", title: "LOCAL Docker Department workspace", createdAt, updatedAt: createdAt, messageCount: 2, messages: [
        { id: "qa_request", role: "user", text: "Review the synthetic Department decision workflow in the Docker QA workspace.", createdAt },
        { id: "qa_answer", role: "assistant", text: "LOCAL QA: Docker ERPBridge is configured for one reviewed synthetic GET. This workflow is an unpublished draft. The planning model is an in-process fixture; data comes from real Docker MockERP. Publish and run explicitly. Memory state is lost on restart; no production records or email are supported.", createdAt, artifacts: { intent: "WORKFLOW", workflowId: "qa_departments", yaml, validation_passed: true, can_execute: false } },
      ] };
    });
    runtime = await McpConnectionManager.open({ repository, registries, validator, config });
    const user = await repository.effectiveUser("qa"), status = await runtime.status(user);
    await runtime.command("connect", user, { baseRevision: status.connections[0].revision, requestId: "explicit-local-workspace-connect" });
    const observed = await observeCapabilities({ repository, registries, session: runtime.session, user }), observation = observed.observations[0];
    await reviewCapability({ repository, registries, session: runtime.session, user, capabilityId: observation.capabilityId, body: {
      observationId: observation.id, contractHash: observation.contractHash, decisionKey: "explicit-local-workspace-read-review", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Operator-started LOCAL literal Department GET review; no product registry admission" } });
    const providerDiagnostics = [];
    const providerRuntime = new ProviderRuntime(repository, executor, realProvider ? async (url, init) => {
      if (String(url) !== "https://openrouter.ai/api/v1/chat/completions") throw new Error("Real-model QA refused another provider destination");
      const response = await fetch(url, init);
      const request = JSON.parse(String(init.body));
      if (request.messages[0]?.content.includes("WORKFLOW DRAFT SYNTHESIS")) {
        const body = await response.clone().json().catch(() => ({}));
        const text = body.choices?.[0]?.message?.content;
        providerDiagnostics.push({ status: response.status, finishReason: body.choices?.[0]?.finish_reason,
          candidateText: typeof text === "string" && !text.includes(process.env.GENERATION_API_KEY) ? text.slice(0, 6000) : "Response text unavailable", errorCode: body.error?.code });
      }
      return response;
    } : async (url, init) => {
      if (String(url) !== "https://fixture.invalid/v1/chat/completions") throw new Error("Local fixture cannot contact another provider");
      return Response.json(qaPlanningResponse(JSON.parse(String(init.body)), modelReadFixture));
    });
    if (!realProvider) providerRuntime.activate(qaProviderConfiguration(createdAt, modelReadFixture));
    const services = { config, repository, registries, validator, executor, providerRuntime, ...(modelReadFixture || realProvider ? { synthesis: new SynthesisService(providerRuntime, registries, validator) } : {}), mcpConnectionRuntime: runtime, get erpbridgeSession() { return runtime.session; } };
    app = await buildApp(services);
    const close = async () => { await app.close(); await runtime.stop(); await repository.close(); for (const file of files) await unlink(file); await rmdir(directory); };
    return { app, repository, services, close, providerDiagnostics };
  } catch (error) {
    await app?.close(); await runtime?.stop(); await repository.close();
    for (const file of files) await unlink(file).catch(cause => { if (cause.code !== "ENOENT") throw cause; }); await rmdir(directory);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--serve-reviewed-read") { console.error("Use --serve-reviewed-read to start the isolated Docker QA workspace, not production"); process.exitCode = 1; }
  else try {
    const workspace = await createQaWorkspace();
    try { await workspace.app.listen({ host: "127.0.0.1", port: 8082 }); }
    catch (error) { await workspace.close(); throw error; }
    console.log("LOCAL Docker QA backend 127.0.0.1:8082 · qa@example.test / Local-QA-only-2026! · memory only · planning fixture, not a real model. Existing 8081 workspace unchanged.");
    let stopping; for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping ??= workspace.close(); stopping.catch(() => { process.exitCode = 1; }); });
  } catch { console.error("Docker workspace startup was not confirmed; check the exact isolated QA stack. Credentials suppressed."); process.exitCode = 1; }
}
