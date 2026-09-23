import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { loadConfig } from "../config/config.js";
import { buildApp } from "../http/app.js";
import {
  RegistryService,
  ensureRuntimeRegistries,
} from "../registry/service.js";
import { Repository } from "../repository/store.js";
import { Executor } from "../runner/executor.js";
import { McpConnectionManager } from "../tools/mcp-connection-runtime.js";
import { createGovernedMCPClient } from "../tools/mcp-client.js";
import { createExecutorToolBoundary } from "../tools/executor-tool-boundary.js";
import { RegistryValidator } from "../validator/registry-validator.js";
import { hashPassword } from "../authn/password.js";
import { openApplicationRepository } from "../storage/open-repository.js";
import {
  ProviderRuntime,
  type RuntimeProviderConfiguration,
} from "../providers/runtime.js";
import { SynthesisService } from "../synthesis/service.js";
import { GovernanceAdapter } from "../governance/adapter.js";
import { GovernanceService } from "../governance/service.js";
import { GovernedValidationGate } from "../governance/gate.js";
import { LlmPolicyFallback } from "../governance/llm-fallback.js";
import { PolicyGateClient } from "../governance/policy-gate-client.js";
import { reconcileInterruptedExecutions } from "../runner/read-checkpoints.js";

// Repository startup owns its deadline and disposes late storage resources.
// ERPBridge now owns its initialization deadline and cleanup inside its adapter.
/*******************************************************************************
 * Function: withTimeout
 *
 * Rejects an operation if it does not finish within the time limit.
 ******************************************************************************/
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

const root = process.cwd();
const config = loadConfig(process.env, root);
await ensureRuntimeRegistries({
  toolPath: config.toolRegistryPath,
  rulePath: config.ruleRegistryPath,
  frozenToolPath: resolve(
    root,
    "fixtures/parity/http/runtime/all_tools_master_registry.json",
  ),
  frozenRulePath: resolve(
    root,
    "fixtures/parity/http/runtime/all_rules_master_registry.json",
  ),
});
await ensureRuntimeContext(
  resolve(root, "fixtures/parity/http/runtime/registry_context.md"),
  resolve(dirname(config.toolRegistryPath), "registry_context.md"),
);
const registries = await RegistryService.load(
  config.toolRegistryPath,
  config.ruleRegistryPath,
);
console.log(`[startup] Registries loaded — connecting to ${config.storageDriver} storage...`);
const STORAGE_CONNECT_TIMEOUT_MS = 30_000;
const repository = await openApplicationRepository(config, STORAGE_CONNECT_TIMEOUT_MS);
console.log("[startup] Repository state loaded.");
await withTimeout(
  bootstrapAdministrator(repository, config.platformAdminEmail, config.platformAdminPassword),
  STORAGE_CONNECT_TIMEOUT_MS,
  "Administrator bootstrap",
);
console.log("[startup] Administrator bootstrapped.");
await withTimeout(
  reconcileInterruptedExecutions(repository),
  STORAGE_CONNECT_TIMEOUT_MS,
  "Execution reconciliation",
);
console.log("[startup] Executions reconciled.");
const validator = new RegistryValidator(registries, repository);
const { requireProductionAdmissionProfile } = await import("../registry/capability-admission.js");
requireProductionAdmissionProfile(config);
const legacyMcp =
  config.mcpTransport === "bridge-v1"
    ? createGovernedMCPClient({
        baseURL: config.mcpBaseURL,
        timeoutMs: config.mcpTimeoutMs,
        mode: config.mcpMode,
        validator,
      })
    : null;
const mcpConnectionRuntime = await McpConnectionManager.open({ config, repository, registries, validator });
const executorTools = createExecutorToolBoundary({ transport: config.mcpTransport, tools: registries, legacyClient: legacyMcp });
const executor = new Executor(executorTools.registry, validator);
const providerRuntime = new ProviderRuntime(repository, executor);
const generationConfiguration = staticProviderConfiguration();
await providerRuntime.activateStoredOrStatic(generationConfiguration, config.generationTimeoutMs ?? 30_000);
const governancePrimary =
  (config.governanceURL ?? "") === ""
    ? null
    : new GovernanceAdapter({
        url: config.governanceURL!,
        apiKey: config.governanceAPIKey ?? "",
        timeoutMs: config.governanceTimeoutMs ?? 10_000,
        source: "primary",
      });
const governanceSecondary =
  (config.governanceSecondaryURL ?? "") === ""
    ? null
    : new GovernanceAdapter({
        url: config.governanceSecondaryURL!,
        apiKey: config.governanceAPIKey ?? "",
        timeoutMs: config.governanceTimeoutMs ?? 10_000,
        source: "secondary",
      });
const governanceLlmFallback = new LlmPolicyFallback({
  openrouterApiKey: config.governanceFallbackLlmApiKey,
  model: config.governanceFallbackLlmModel,
  policyPath: config.governanceFallbackPolicyPath,
  timeoutMs: config.governanceFallbackLlmTimeoutMs,
});
const governance = new GovernanceService(
  governancePrimary,
  governanceSecondary,
  config.governanceCacheTTLms ?? 0,
  registries,
  repository,
  governanceLlmFallback,
);
await governance.initialize();
const policyGateClient =
  (config.policyGateURL ?? "") !== "" && (config.policyGateAPIKey ?? "") !== ""
    ? new PolicyGateClient({
        url: config.policyGateURL!,
        apiKey: config.policyGateAPIKey!,
        timeoutMs: config.policyGateTimeoutMs,
      })
    : null;
const validationGate = new GovernedValidationGate(
  governance,
  validator,
  registries,
  repository,
  policyGateClient,
);
const synthesis = new SynthesisService(
  providerRuntime,
  registries,
  validator,
  validationGate,
);
const app = await buildApp({
  config,
  repository,
  registries,
  validator,
  validationGate,
  executor,
  providerRuntime,
  synthesis,
  contextAvailable: true,
  mcpConnectionRuntime,
  get erpbridgeSession() { return mcpConnectionRuntime.session; },
});
let shuttingDown = false;
// The legacy scheduler uses a fabricated admin identity and no durable lease,
// immutable publication binding or transaction recovery. Do not dispatch it.
/*******************************************************************************
 * Function: shutdown
 *
 * Closes application services during process shutdown.
 ******************************************************************************/
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  executorTools.close();
  try { await mcpConnectionRuntime.stop(); }
  catch { console.warn("[erpbridge] MCP cleanup could not be confirmed; continuing shutdown without replay"); }
  await repository.close();
  // Explicit exit so lingering async handles (Firestore listeners, timers) don't keep the
  // process alive after the HTTP port is closed — prevents EADDRINUSE on --watch restarts.
  process.exit(0);
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
await app.listen({ host: "0.0.0.0", port: config.port });
console.log("[scheduler] Legacy cron dispatch disabled; safe service-principal scheduler is required");

/*******************************************************************************
 * Function: bootstrapAdministrator
 *
 * Creates or updates the bootstrap administrator from startup configuration.
 ******************************************************************************/
async function bootstrapAdministrator(
  repository: Repository,
  email: string,
  password: string,
): Promise<void> {
  const existing = await repository.read((state) =>
    Object.values(state.users).find(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    ),
  );
  const passwordHash = await hashPassword(password);
  if (existing !== undefined) {
    // Always sync the password from .env so a restart picks up credential changes.
    await repository.mutate((state) => { state.passwordHashes[String(existing.id)] = passwordHash; });
    return;
  }
  await repository.mutate((state) => {
    state.counter += 1;
    const id = `usr_${state.counter}_admin`;
    state.users[id] = {
      id,
      name: "Platform Admin",
      email: email.toLowerCase(),
      roleId: "role_admin",
      permissionOverrides: [],
      status: "Active",
      initials: "PA",
      departmentId: null,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    };
    state.passwordHashes[id] = passwordHash;
  });
}

/*******************************************************************************
 * Function: ensureRuntimeContext
 *
 * Copies the initial registry context when no runtime copy exists.
 ******************************************************************************/
async function ensureRuntimeContext(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/*******************************************************************************
 * Function: staticProviderConfiguration
 *
 * Builds provider settings from application configuration when configured.
 ******************************************************************************/
function staticProviderConfiguration(): RuntimeProviderConfiguration | null {
  const baseURL = config.generationBaseURL ?? "";
  if (baseURL === "") return null;
  return {
    id: "provider_static",
    name: "Environment provider",
    type: "openai_compatible",
    baseURL,
    apiKey: config.generationAPIKey ?? "",
    model: config.generationModelPrimary ?? "",
    fallbackModel: config.generationModelFallback ?? "",
    temperature: config.generationTemperature ?? 0,
    timeoutMs: config.generationTimeoutMs ?? 30_000,
  };
}

// Production scheduling will be implemented with durable occurrences, leases,
// explicit service principals and the same governed dispatch boundary.
