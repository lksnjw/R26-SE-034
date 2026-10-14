import { afterEach, expect, test, vi } from "vitest";
import { loadFunctionConfig } from "../src/firebase/config.js";

afterEach(() => vi.unstubAllEnvs());
const production = { APP_ENV: "production", API_BASE_PATH: "/api", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: "production-workspace",
  FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "workspace", STORAGE_ENCRYPTION_KEY: "k".repeat(32), JWT_SECRET: "j".repeat(32),
  MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp", ERPBRIDGE_BASE_URL: "https://erp.example.com", ERPBRIDGE_MCP_TOKEN: "synthetic-reference-only",
  ERPBRIDGE_ROLE_MAP: JSON.stringify({ "Platform Admin": "admin" }), CORS_ORIGINS: "https://workspace.example.com" };
test("Functions config is production-valid without administrator bootstrap credentials", () => {
  expect(loadFunctionConfig(JSON.stringify(production), process.cwd())).toMatchObject({ environment: "production", storageDriver: "firestore-records" });
});
test("the invocation secret accepts a longer bounded admission wait without changing storage or credentials", () => {
  expect(loadFunctionConfig(JSON.stringify({ ...production, FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: "60000" }), process.cwd()).functionsWriterAdmissionTimeoutMs).toBe(60000);
  expect(() => loadFunctionConfig(JSON.stringify({ ...production, FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: "0" }), process.cwd())).toThrow(/FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS/);
});
test.each([null, [], { ...production, JWT_SECRET: 1 }, { ...production, PLATFORM_ADMIN_PASSWORD: "unused" }, { ...production, FIRESTORE_KEY_JSON: "{}" },
  { ...production, FIRESTORE_KEY_FILE: "key.json" }, { ...production, API_BASE_PATH: "/other" }, { ...production, STORAGE_DRIVER: "memory" },
  { ...production, APP_ENV: "development" }, { ...production, TOOL_REGISTRY_PATH: "../../outside.json" }, { ...production, RULE_REGISTRY_PATH: "configs/runtime/nested/rules.json" }])
  ("Functions config rejects unsupported binding %#", value => { expect(() => loadFunctionConfig(JSON.stringify(value), process.cwd())).toThrow(); });

test("Functions cannot silently select an unpackaged governance policy", () => {
  expect(() => loadFunctionConfig(JSON.stringify({ ...production, GOVERNANCE_FALLBACK_POLICY_PATH: "outside/policy.json" }), process.cwd())).toThrow("packaged release-managed");
});
test("guarded test config cannot be used outside the exact local emulator", () => {
  const env = { ...production, APP_ENV: "test", MCP_MODE: "mock", FIRESTORE_PROJECT_ID: "demo-lcwe-records" };
  expect(() => loadFunctionConfig(JSON.stringify(env), process.cwd())).toThrow("guarded");
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  expect(loadFunctionConfig(JSON.stringify(env), process.cwd()).environment).toBe("test");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "key.json"); expect(() => loadFunctionConfig(JSON.stringify(env), process.cwd())).toThrow("guarded");
});
test("oversized secret and malformed JSON are rejected", () => {
  expect(() => loadFunctionConfig("x".repeat(64_001), process.cwd())).toThrow(); expect(() => loadFunctionConfig("{", process.cwd())).toThrow();
});

test("local Docker qualification requires the exact emulator and isolated connector, never a production HTTP exception", () => {
  const local = { ...production, APP_ENV: "development", LCWE_LOCAL_DOCKER_QA: "native-read/v1", FIRESTORE_PROJECT_ID: "demo-lcwe-records",
    FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`, ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080" };
  expect(() => loadFunctionConfig(JSON.stringify(local), process.cwd())).toThrow("guarded");
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  expect(loadFunctionConfig(JSON.stringify(local), process.cwd()).environment).toBe("development");
  expect(loadFunctionConfig(JSON.stringify({ ...local, LCWE_LOCAL_DOCKER_QA: "native-operation/v1" }), process.cwd()).environment).toBe("development");
  expect(loadFunctionConfig(JSON.stringify({ ...local, LCWE_LOCAL_DOCKER_QA: "native-scale/v1" }), process.cwd()).environment).toBe("development");
  for (const overrides of [{ APP_ENV: "production" }, { LCWE_LOCAL_DOCKER_QA: "other" }, { FIRESTORE_WORKSPACE_ID: "owner" },
    { ERPBRIDGE_BASE_URL: "http://127.0.0.1:18081" }, { ERPBRIDGE_BASE_URL: "https://remote.example.test" },
    { GENERATION_BASE_URL: "https://model.example.test", GENERATION_MODEL_PRIMARY: "model" }, { GOVERNANCE_URL: "https://policy.example.test" }])
    expect(() => loadFunctionConfig(JSON.stringify({ ...local, ...overrides }), process.cwd())).toThrow();
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "owner-key.json"); expect(() => loadFunctionConfig(JSON.stringify(local), process.cwd())).toThrow("guarded");
});

test("native operation policy fixture allows only its exact loopback binding under the demo guards", () => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  const env = { ...production, APP_ENV: "development", LCWE_LOCAL_DOCKER_QA: "native-operation/v1", FIRESTORE_PROJECT_ID: "demo-lcwe-records",
    FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`, ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080",
    GOVERNANCE_URL: "http://127.0.0.1:23676/governance", GOVERNANCE_API_KEY: "synthetic-policy-fixture-only", GOVERNANCE_CACHE_TTL_MS: "300000" };
  expect(loadFunctionConfig(JSON.stringify(env), process.cwd()).governanceURL).toBe(env.GOVERNANCE_URL);
  for (const overrides of [{ APP_ENV: "production" }, { LCWE_LOCAL_DOCKER_QA: "native-read/v1" },
    { GOVERNANCE_URL: "http://127.0.0.1:23677/governance" }, { GOVERNANCE_URL: "http://localhost:23676/governance" },
    { GOVERNANCE_URL: "http://127.0.0.1:23676/other" }, { GOVERNANCE_URL: "https://policy.example.test" },
    { GOVERNANCE_URL: `${env.GOVERNANCE_URL}?bypass=true` }, { GOVERNANCE_SECONDARY_URL: env.GOVERNANCE_URL },
    { POLICY_GATE_URL: env.GOVERNANCE_URL }, { FIRESTORE_PROJECT_ID: "production-workspace" }])
    expect(() => loadFunctionConfig(JSON.stringify({ ...env, ...overrides }), process.cwd())).toThrow();
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "key.json"); expect(() => loadFunctionConfig(JSON.stringify(env), process.cwd())).toThrow("guarded");
});
