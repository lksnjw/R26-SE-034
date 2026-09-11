import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.js";

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

describe("workflow transport configuration", () => {
  test("defaults to two read workers, one per principal, with a bounded renewable lease", () => {
    expect(loadConfig({})).toMatchObject({ readWorkerConcurrency: 2, readWorkerPerActor: 1, readWorkerLeaseMs: 30_000 });
    expect(loadConfig({ READ_WORKER_CONCURRENCY: "8", READ_WORKER_PER_ACTOR: "2", READ_WORKER_LEASE_MS: "5000" })).toMatchObject({ readWorkerConcurrency: 8, readWorkerPerActor: 2, readWorkerLeaseMs: 5000 });
  });
  test.each([
    { READ_WORKER_CONCURRENCY: "0" }, { READ_WORKER_CONCURRENCY: "9" }, { READ_WORKER_CONCURRENCY: "1.5" },
    { READ_WORKER_PER_ACTOR: "0" }, { READ_WORKER_PER_ACTOR: "3" }, { READ_WORKER_PER_ACTOR: "NaN" },
    { READ_WORKER_LEASE_MS: "4999" }, { READ_WORKER_LEASE_MS: "300001" }, { READ_WORKER_LEASE_MS: "5000.5" },
  ])("rejects invalid read worker bounds %j", environment => { expect(() => loadConfig(environment)).toThrow(); });
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
