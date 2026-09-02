import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { loadConfig } from "../config/config.js";
import { buildApp } from "../http/app.js";
import {
  RegistryService,
  ensureRuntimeRegistries,
} from "../registry/service.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { Repository } from "../repository/store.js";
import { Executor } from "../runner/executor.js";
import { GenericMCPTool } from "../tools/generic-mcp-tool.js";
import {
  createErpbridgeMcpSession,
  type ErpbridgeMcpSession,
} from "../tools/erpbridge-mcp-client.js";
import {
  createGovernedMCPClient,
  type GovernedMCPClient,
} from "../tools/mcp-client.js";
import { ToolRegistry } from "../tools/registry.js";
import { RegistryValidator } from "../validator/registry-validator.js";
import { hashPassword } from "../authn/password.js";
import { PostgresPersistence } from "../storage/postgres.js";
import { FirestorePersistence } from "../storage/firestore.js";
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
import { discoverTools } from "../agent/tool-discovery.js";
import { reconcileInterruptedExecutions } from "../runner/read-checkpoints.js";

// Some external SDKs (the Firestore client, the ERP Bridge MCP client) have no
// built-in connect timeout — an unresponsive dependency would otherwise hang
// startup forever with zero log output. Race every such call against a hard
// deadline so failures are fast and visible instead of silent.
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
const persistence =
  config.storageDriver === "postgres"
    ? await withTimeout(
        PostgresPersistence.open(config.databaseURL, config.storageEncryptionKey),
        STORAGE_CONNECT_TIMEOUT_MS,
        "Postgres connection",
      )
    : config.storageDriver === "firestore"
      ? await withTimeout(
          FirestorePersistence.open({
            projectId: config.firestoreProjectId!,
            ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}),
            ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}),
            ...(config.firestoreEncryptionKey ? { encryptionKey: config.firestoreEncryptionKey } : {}),
          }),
          STORAGE_CONNECT_TIMEOUT_MS,
          "Firestore connection",
        )
      : null;
console.log("[startup] Storage connected.");
const repository = await withTimeout(
  Repository.open(persistence),
  STORAGE_CONNECT_TIMEOUT_MS,
  "Repository state load",
);
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
const legacyMcp =
  config.mcpTransport === "bridge-v1"
    ? createGovernedMCPClient({
        baseURL: config.mcpBaseURL,
        timeoutMs: config.mcpTimeoutMs,
        mode: config.mcpMode,
        validator,
      })
    : null;
let erpbridgeSession: ErpbridgeMcpSession | null = null;
if (config.mcpTransport === "erpbridge-mcp") {
  try {
    erpbridgeSession = await withTimeout(
      createErpbridgeMcpSession({
        baseURL: config.erpbridgeBaseURL,
        token: config.erpbridgeMcpToken,
        timeoutMs: config.mcpTimeoutMs,
        validator,
      }),
      config.mcpTimeoutMs,
      "ERP Bridge connection",
    );
  } catch (err) {
    console.warn("[erpbridge] MCP session failed to start — ERP tools will be unavailable:", err instanceof Error ? err.message : String(err));
  }
}
/*******************************************************************************
 * Function: clientFor
 *
 * Selects the MCP client for the supplied tool definition.
 ******************************************************************************/
const clientFor = (definition: ToolDefinition): GovernedMCPClient | null =>
  erpbridgeSession !== null
    ? erpbridgeSession.clientFor(definition)
    : legacyMcp;
const toolRegistry = new ToolRegistry();
for (const definition of registries.snapshot().tools) {
  const client = clientFor(definition);
  if (client !== null)
    toolRegistry.register(new GenericMCPTool(definition.name, definition.description, client));
}
registries.onToolUpsert((definition) => {
  if (!toolRegistry.has(definition.name)) {
    const client = clientFor(definition);
    if (client !== null)
      toolRegistry.register(new GenericMCPTool(definition.name, definition.description, client));
  }
});

// Discovery may reconcile registered contracts, never invent minimally guarded
// tool definitions for live-only names. Unknown tools remain unavailable.
if (erpbridgeSession !== null) {
  try {
    const liveErpTools = await discoverTools(erpbridgeSession, registries);
    for (const definition of liveErpTools) {
      if (!toolRegistry.has(definition.name)) {
        const client = clientFor(definition);
        if (client !== null)
          toolRegistry.register(new GenericMCPTool(definition.name, definition.description, client));
      }
    }
    console.log(`[erpbridge] Reconciled ${liveErpTools.length} registered live contracts`);
  } catch (err) {
    console.warn("[erpbridge] Could not bootstrap live tools into executor:", err instanceof Error ? err.message : String(err));
  }
}

const executor = new Executor(toolRegistry, validator);
const providerRuntime = new ProviderRuntime(repository, executor);
const generationConfiguration = staticProviderConfiguration();
await providerRuntime.activateStoredOrStatic(generationConfiguration);
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
  ...(erpbridgeSession !== null ? { erpbridgeSession } : {}),
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
  await erpbridgeSession?.close();
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
