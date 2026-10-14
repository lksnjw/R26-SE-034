import { describe, expect, test } from "vitest";
import { isMcpConfigured, loadConfig, parseAdditionalModelIds } from "../src/config/config.js";

const erpbridgeEnvironment = {
  APP_ENV: "test",
  MCP_TRANSPORT: "erpbridge-mcp",
  ERPBRIDGE_BASE_URL: "https://erpbridge.example.test",
  ERPBRIDGE_MCP_TOKEN: "scoped-token",
  ERPBRIDGE_ROLE_MAP: JSON.stringify({
    "Workflow Builder": "workflow_builder",
    Client: "client",
  }),
};

const firestoreRecordsEnvironment = { APP_ENV: "test", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: "demo-lcwe-records", FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "fixture_workspace", STORAGE_ENCRYPTION_KEY: "k".repeat(32) };
const productionEnvironment = {
  APP_ENV: "production", JWT_SECRET: "j".repeat(32), PLATFORM_ADMIN_EMAIL: "admin@example.com", PLATFORM_ADMIN_PASSWORD: "p".repeat(20),
  STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: "lcwe-production", FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "production_workspace", STORAGE_ENCRYPTION_KEY: "k".repeat(32),
  MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp", ERPBRIDGE_CONNECTIONS_JSON: JSON.stringify([
    { id: "finance", baseURL: "https://erpbridge.example.com", tokenEnv: "FINANCE_ERP_TOKEN", roleMap: { "Platform Admin": "finance_admin" } },
  ]), ERPBRIDGE_PRIMARY_CONNECTION_ID: "finance", FINANCE_ERP_TOKEN: "production-secret-reference-value", CORS_ORIGINS: "https://workspace.example.com",
};

test("additional environment models retain exact Qwen IDs without changing primary or backup", () => {
  const config = loadConfig({ APP_ENV: "test", GENERATION_BASE_URL: "https://openrouter.ai/api/v1", GENERATION_API_KEY: "fixture-only",
    GENERATION_MODEL_PRIMARY: "deepseek/deepseek-v4.1-flash", GENERATION_MODEL_FALLBACK: "owner-backup",
    GENERATION_ADDITIONAL_MODELS: " qwen/qwen3.7-plus, qwen/qwen3.8-flash,qwen/qwen3.7-plus " });
  expect(config).toMatchObject({ generationModelPrimary: "deepseek/deepseek-v4.1-flash", generationModelFallback: "owner-backup",
    generationAdditionalModels: ["qwen/qwen3.7-plus", "qwen/qwen3.8-flash"] });
  expect(parseAdditionalModelIds(undefined)).toEqual([]); expect(parseAdditionalModelIds(" ")).toEqual([]);
});

test.each(["model:latest", "one,,two", "one,", "bad model", "a".repeat(257), Array.from({ length: 65 }, (_, index) => `model-${index}`).join(","), "a".repeat(16449)])(
  "additional environment models reject unsafe or unbounded catalog %#", value => {
    expect(() => parseAdditionalModelIds(value)).toThrow(/GENERATION_ADDITIONAL_MODELS/);
  });

test("additional choices do not manufacture an unconfigured provider", () => {
  expect(() => loadConfig({ GENERATION_ADDITIONAL_MODELS: "qwen/qwen3.8-flash" })).toThrow(/GENERATION_BASE_URL/);
  expect(loadConfig({}).generationAdditionalModels).toEqual([]);
});

test("Functions admission waits longer by default and accepts a bounded explicit demo budget", () => {
  expect(loadConfig({}).functionsWriterAdmissionTimeoutMs).toBe(30_000);
  expect(loadConfig({ FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: "60000" }).functionsWriterAdmissionTimeoutMs).toBe(60_000);
  expect(loadConfig({ FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: "5000" }).functionsWriterAdmissionTimeoutMs).toBe(5000);
});
test.each(["0", "999", "60001", "1.5", "NaN", "Infinity", "-1"])("rejects unsafe admission wait %s", value => {
  expect(() => loadConfig({ FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: value })).toThrow(/FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS/);
});
test("normalized Firestore requires an explicit namespace and one valid private-input/record key; defaults stay memory", () => {
  expect(loadConfig(firestoreRecordsEnvironment)).toMatchObject({ storageDriver: "firestore-records", firestoreProjectId: "demo-lcwe-records", firestoreDatabaseId: "(default)", firestoreWorkspaceId: "fixture_workspace" });
  expect(loadConfig({}).storageDriver).toBe("memory"); expect(loadConfig({ STORAGE_DRIVER: "firestore", FIRESTORE_PROJECT_ID: "demo-lcwe-records" }).storageDriver).toBe("firestore");
});
test.each(["FIRESTORE_PROJECT_ID", "FIRESTORE_DATABASE_ID", "FIRESTORE_WORKSPACE_ID", "STORAGE_ENCRYPTION_KEY"])("normalized Firestore rejects missing %s rather than selecting defaults", field => {
  expect(() => loadConfig({ ...firestoreRecordsEnvironment, [field]: "" })).toThrow();
});
test.each([{ FIRESTORE_WORKSPACE_ID: "workspace/escape" }, { FIRESTORE_DATABASE_ID: "db/escape" }, { STORAGE_ENCRYPTION_KEY: "short" }, { FIRESTORE_ENCRYPTION_KEY: "z".repeat(32) }])("normalized Firestore rejects unsafe scope/key %j", environment => {
  expect(() => loadConfig({ ...firestoreRecordsEnvironment, ...environment })).toThrow();
});

describe("production release configuration", () => {
  test("external bootstrap avoids distributing administrator passwords without weakening runtime checks", () => {
    const env = { ...productionEnvironment }; delete (env as Record<string, unknown>).PLATFORM_ADMIN_PASSWORD;
    delete (env as Record<string, unknown>).PLATFORM_ADMIN_EMAIL;
    expect(loadConfig(env, process.cwd(), { administratorBootstrap: "external" }).environment).toBe("production");
    expect(() => loadConfig(env)).toThrow(/PLATFORM_ADMIN_PASSWORD/);
    for (const patch of [{ JWT_SECRET: "short" }, { STORAGE_DRIVER: "memory" }, { MCP_MODE: "mock" }, { FIRESTORE_KEY_FILE: "key.json" }])
      expect(() => loadConfig({ ...env, ...patch }, process.cwd(), { administratorBootstrap: "external" })).toThrow();
    expect(() => loadConfig(env, process.cwd(), { administratorBootstrap: "request-controlled" as never })).toThrow("bootstrap policy");
  });
  test("accepts the selected Firestore and modern ERPBridge release boundary without legacy MCP_BASE_URL", () => {
    const config = loadConfig(productionEnvironment);
    expect(config).toMatchObject({ environment: "production", storageDriver: "firestore-records", mcpTransport: "erpbridge-mcp", corsOrigins: ["https://workspace.example.com"] });
    expect(isMcpConfigured(config)).toBe(true);
  });

  test.each([
    { storageDriver: "memory", requirements: {} },
    { storageDriver: "postgres-records", requirements: { DATABASE_URL: "postgres://db.example.com/lcwe", STORAGE_ENCRYPTION_KEY: "k".repeat(32) } },
    { storageDriver: "firestore", requirements: {} },
  ])("refuses unqualified production storage $storageDriver", ({ storageDriver, requirements }) => {
    expect(() => loadConfig({ ...productionEnvironment, ...requirements, STORAGE_DRIVER: storageDriver })).toThrow(/firestore-records/);
  });

  test.each([
    { patch: { APP_ENV: "Production" }, message: /APP_ENV/ },
    { patch: { JWT_SECRET: "sixteen-characters" }, message: /32 bytes/ },
    { patch: { PLATFORM_ADMIN_EMAIL: "admin@example.test" }, message: /PLATFORM_ADMIN_EMAIL/ },
    { patch: { PLATFORM_ADMIN_PASSWORD: "short" }, message: /16 bytes/ },
    { patch: { FIRESTORE_KEY_FILE: "service-account.json" }, message: /workload identity/ },
    { patch: { FIRESTORE_KEY_JSON: "{}" }, message: /workload identity/ },
    { patch: { CORS_ORIGINS: "http://localhost:5173" }, message: /HTTPS/ },
    { patch: { CORS_ORIGINS: "https://workspace.example.com/path" }, message: /exact HTTPS origins/ },
    { patch: { MCP_TRANSPORT: "bridge-v1", MCP_BASE_URL: "https://legacy.example.com" }, message: /reviewed remote ERPBridge/ },
    { patch: { GENERATION_BASE_URL: "http://models.example.com/v1", GENERATION_API_KEY: "key", GENERATION_MODEL_PRIMARY: "provider/model-2026-10-07" }, message: /HTTPS/ },
    { patch: { POLICY_GATE_URL: "https://user:pass@policy.example.com/evaluate" }, message: /credential-free/ },
  ])("refuses unsafe production release binding %#", ({ patch, message }) => {
    expect(() => loadConfig({ ...productionEnvironment, ...patch })).toThrow(message);
  });
});

describe("workflow transport configuration", () => {
  test("defaults to two backend job workers, one per principal, with a bounded renewable lease", () => {
    expect(loadConfig({})).toMatchObject({ readWorkerConcurrency: 2, readWorkerPerActor: 1, readWorkerLeaseMs: 30_000 });
    expect(loadConfig({ BACKEND_WORKER_CONCURRENCY: "4", READ_WORKER_PER_ACTOR: "2" })).toMatchObject({ readWorkerConcurrency: 4, readWorkerPerActor: 2 });
    expect(loadConfig({ READ_WORKER_CONCURRENCY: "8", READ_WORKER_PER_ACTOR: "2", READ_WORKER_LEASE_MS: "5000" })).toMatchObject({ readWorkerConcurrency: 8, readWorkerPerActor: 2, readWorkerLeaseMs: 5000 });
  });
  test.each([
    { BACKEND_WORKER_CONCURRENCY: "0" }, { BACKEND_WORKER_CONCURRENCY: "9" }, { BACKEND_WORKER_CONCURRENCY: "1.5" },
    { READ_WORKER_CONCURRENCY: "0" }, { READ_WORKER_CONCURRENCY: "9" }, { READ_WORKER_CONCURRENCY: "1.5" },
    { READ_WORKER_PER_ACTOR: "0" }, { READ_WORKER_PER_ACTOR: "3" }, { READ_WORKER_PER_ACTOR: "NaN" },
    { READ_WORKER_LEASE_MS: "4999" }, { READ_WORKER_LEASE_MS: "300001" }, { READ_WORKER_LEASE_MS: "5000.5" },
  ])("rejects invalid read worker bounds %j", environment => { expect(() => loadConfig(environment)).toThrow(); });
  test("rejects conflicting current and legacy worker settings", () => {
    expect(() => loadConfig({ BACKEND_WORKER_CONCURRENCY: "4", READ_WORKER_CONCURRENCY: "2" })).toThrow(/must match/);
  });
  test("keeps the bridge-v1 transport as the default", () => {
    expect(loadConfig({}).mcpTransport).toBe("bridge-v1");
  });

  test("loads an authenticated ERPBridge transport and strict role map", () => {
    const config = loadConfig(erpbridgeEnvironment);

    expect(config).toMatchObject({
      mcpTransport: "erpbridge-mcp",
      erpbridgeBaseURL: "https://erpbridge.example.test",
      erpbridgeMcpToken: "scoped-token",
      erpbridgeMcpTokenReference: "ERPBRIDGE_MCP_TOKEN",
      erpbridgePrimaryConnectionId: "erpbridge-default",
      erpbridgeRoleMap: {
        "Workflow Builder": "workflow_builder",
        Client: "client",
      },
    });
    expect(config.erpbridgeConnections).toEqual([expect.objectContaining({ id: "erpbridge-default", primary: true, tokenReference: "ERPBRIDGE_MCP_TOKEN" })]);
    expect(isMcpConfigured(config)).toBe(true);
  });

  test("supports selecting the token from a named environment variable", () => {
    const config = loadConfig({
      ...erpbridgeEnvironment,
      ERPBRIDGE_MCP_TOKEN: "",
      ERPBRIDGE_MCP_TOKEN_ENV: "WORKFLOW_ERP_TOKEN",
      WORKFLOW_ERP_TOKEN: "selected-token",
    });

    expect(config.erpbridgeMcpToken).toBe("selected-token"); expect(config.erpbridgeMcpTokenReference).toBe("WORKFLOW_ERP_TOKEN");
  });

  test("loads up to eight backend-owned connections from named secret references with one explicit primary", () => {
    const config = loadConfig({ APP_ENV: "test", MCP_TRANSPORT: "erpbridge-mcp", ERPBRIDGE_PRIMARY_CONNECTION_ID: "finance",
      ERPBRIDGE_CONNECTIONS_JSON: JSON.stringify([
        { id: "finance", baseURL: "https://finance.example.test", tokenEnv: "FINANCE_ERP_TOKEN", roleMap: { "Platform Admin": "finance_admin" } },
        { id: "hr", baseURL: "https://hr.example.test", tokenEnv: "HR_ERP_TOKEN", roleMap: { Client: "hr_reader" } },
      ]), FINANCE_ERP_TOKEN: "finance-private", HR_ERP_TOKEN: "hr-private" });
    expect(config.erpbridgePrimaryConnectionId).toBe("finance");
    expect(config.erpbridgeConnections).toEqual([
      { id: "finance", baseURL: "https://finance.example.test", mcpToken: "finance-private", tokenReference: "FINANCE_ERP_TOKEN", roleMap: { "Platform Admin": "finance_admin" }, primary: true },
      { id: "hr", baseURL: "https://hr.example.test", mcpToken: "hr-private", tokenReference: "HR_ERP_TOKEN", roleMap: { Client: "hr_reader" }, primary: false },
    ]);
    expect(config.erpbridgeBaseURL).toBe("https://finance.example.test"); expect(config.erpbridgeMcpToken).toBe("finance-private");
  });

  test.each([
    { name: "missing primary", patch: { ERPBRIDGE_PRIMARY_CONNECTION_ID: "" } },
    { name: "unknown primary", patch: { ERPBRIDGE_PRIMARY_CONNECTION_ID: "unknown" } },
    { name: "missing referenced token", patch: { HR_ERP_TOKEN: "" } },
    { name: "mixed legacy configuration", patch: { ERPBRIDGE_BASE_URL: "https://legacy.example.test" } },
  ])("rejects unsafe multi-connection configuration: $name", ({ patch }) => {
    const base = { APP_ENV: "test", MCP_TRANSPORT: "erpbridge-mcp", ERPBRIDGE_PRIMARY_CONNECTION_ID: "finance",
      ERPBRIDGE_CONNECTIONS_JSON: JSON.stringify([
        { id: "finance", baseURL: "https://finance.example.test", tokenEnv: "FINANCE_ERP_TOKEN", roleMap: { "Platform Admin": "finance_admin" } },
        { id: "hr", baseURL: "https://hr.example.test", tokenEnv: "HR_ERP_TOKEN", roleMap: { Client: "hr_reader" } },
      ]), FINANCE_ERP_TOKEN: "finance-private", HR_ERP_TOKEN: "hr-private" };
    expect(() => loadConfig({ ...base, ...patch })).toThrow();
  });

  test("rejects an ambiguous direct token and token environment selector", () => {
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_MCP_TOKEN_ENV: "WORKFLOW_ERP_TOKEN",
        WORKFLOW_ERP_TOKEN: "selected-token",
      }),
    ).toThrow(/exactly one/);
  });

  test("requires an ERPBridge endpoint, token, and role map", () => {
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_BASE_URL: "" }),
    ).toThrow(/ERPBRIDGE_BASE_URL/);
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_MCP_TOKEN: "" }),
    ).toThrow(/ERPBRIDGE_MCP_TOKEN/);
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_ROLE_MAP: "{}" }),
    ).toThrow(/ERPBRIDGE_ROLE_MAP/);
  });

  test("requires HTTPS outside development", () => {
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_BASE_URL: "http://erpbridge.example.test",
      }),
    ).toThrow(/HTTPS/);
    expect(
      loadConfig({
        ...erpbridgeEnvironment,
        APP_ENV: "development",
        ERPBRIDGE_BASE_URL: "http://localhost:9090",
      }).erpbridgeBaseURL,
    ).toBe("http://localhost:9090");
  });

  test("rejects invalid transport and role-map entries", () => {
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, MCP_TRANSPORT: "unknown" }),
    ).toThrow(/MCP_TRANSPORT/);
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_ROLE_MAP: "not-json" }),
    ).toThrow(/JSON/);
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_ROLE_MAP: JSON.stringify({ Unknown: "unknown" }),
      }),
    ).toThrow(/unrecognized local role/);
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_ROLE_MAP: JSON.stringify({ Client: "" }),
      }),
    ).toThrow(/nonblank/);
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_ROLE_MAP: JSON.stringify({
          Client: "same",
          "Workflow Builder": "same",
        }),
      }),
    ).toThrow(/duplicate/);
  });
  test.each(["Admin", "role with spaces", "1role", "a".repeat(65), "role/escape"])("rejects invalid verified bridge role %s", (role) => {
    expect(() => loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_ROLE_MAP: JSON.stringify({ Client: role }) })).toThrow(/role format/);
  });
});

describe("data-transformation pipeline gateway configuration", () => {
  test("loads a server-only pipeline origin, credential, and bounded timeout", () => {
    expect(loadConfig({
      APP_ENV: "development",
      PIPELINE_API_BASE_URL: "http://localhost:8000",
      PIPELINE_API_KEY: "pipeline-service-secret",
      PIPELINE_TIMEOUT_MS: "45000",
    })).toMatchObject({
      pipelineAPIBaseURL: "http://localhost:8000",
      pipelineAPIKey: "pipeline-service-secret",
      pipelineTimeoutMs: 45000,
    });
  });

  test.each([
    { PIPELINE_API_BASE_URL: "http://localhost:8000" },
    { PIPELINE_API_KEY: "pipeline-service-secret" },
  ])("requires the pipeline endpoint and credential together %#", environment => {
    expect(() => loadConfig(environment)).toThrow(/configured together/);
  });

  test.each(["999", "300001", "1.5", "NaN"])("rejects an unsafe pipeline timeout: %s", value => {
    expect(() => loadConfig({ PIPELINE_TIMEOUT_MS: value })).toThrow(/PIPELINE_TIMEOUT_MS/);
  });

  test("requires HTTPS for the production pipeline service", () => {
    expect(() => loadConfig({
      ...productionEnvironment,
      PIPELINE_API_BASE_URL: "http://pipeline.example.test",
      PIPELINE_API_KEY: "pipeline-service-secret",
    })).toThrow(/HTTPS/);
  });
});
