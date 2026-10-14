import { expect, test } from "vitest";
import { stringify } from "yaml";
// @ts-expect-error Operator-only JavaScript acceptance module.
import { assertNativeRealPolicyMatrixScope, assertModelPolicyMatrixDraft } from "../scripts/native-functions-real-policy-matrix-qa.mjs";

const fixtureId = "3db85719-8f33-44a2-915d-b94a25caf836";
const base = { name: "Synthetic Departments", trigger: { type: "manual" }, steps: [
  { id: "departments", action: "qa_list_departments", parameters: {} },
] };
const operation = { ...base, steps: [...base.steps, { id: "echo", action: "qa_native_integration_echo",
  parameters: { value: "native-operation-qa-ack", fixtureId } }] };
const config = { APP_ENV: "development", LCWE_LOCAL_DOCKER_QA: "native-operation/v1", FIRESTORE_PROJECT_ID: "demo-lcwe-records",
  FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`,
  STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080",
  GOVERNANCE_URL: "http://127.0.0.1:23676/governance", GOVERNANCE_API_KEY: "x".repeat(32) };
const environment = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:23671", GCLOUD_PROJECT: "demo-lcwe-records",
  LCWE_REAL_MODEL_QA: "synthetic-docker-only", GENERATION_BASE_URL: "https://openrouter.ai/api/v1",
  GENERATION_API_KEY: "unit-test-sentinel", GENERATION_MODEL_PRIMARY: "deepseek/deepseek-v4.1-flash" };

test("scope confines acceptance to Node 22, synthetic namespace, loopback policy/ERP, and selected provider", () => {
  expect(() => assertNativeRealPolicyMatrixScope(config, environment, "v22.0.0")).not.toThrow();
  expect(() => assertNativeRealPolicyMatrixScope(config, environment, "v24.0.0")).toThrow();
  for (const patch of [
    { APP_ENV: "production" }, { LCWE_LOCAL_DOCKER_QA: "native-read/v1" },
    { FIRESTORE_PROJECT_ID: "live" }, { FIRESTORE_WORKSPACE_ID: "owner" },
    { ERPBRIDGE_BASE_URL: "https://erp.example.test" }, { GOVERNANCE_URL: "https://policy.example.test" },
    { STORAGE_ENCRYPTION_KEY: "invalid" },
  ]) expect(() => assertNativeRealPolicyMatrixScope({ ...config, ...patch }, environment, "v22.0.0")).toThrow();
  for (const patch of [
    { FIRESTORE_EMULATOR_HOST: "remote.example.test:23671" }, { GCLOUD_PROJECT: "live" },
    { GOOGLE_APPLICATION_CREDENTIALS: "owner.json" }, { LCWE_REAL_MODEL_QA: "" },
    { GENERATION_BASE_URL: "https://other.example.test/v1" }, { GENERATION_API_KEY: "" },
    { GENERATION_MODEL_PRIMARY: "other" },
  ]) expect(() => assertNativeRealPolicyMatrixScope(config, { ...environment, ...patch }, "v22.0.0")).toThrow();
});

test("only exact ordered GET and process-local echo drafts pass", () => {
  expect(assertModelPolicyMatrixDraft(stringify(base), "read", fixtureId)).toEqual({ readNodeId: "departments" });
  expect(assertModelPolicyMatrixDraft(stringify(operation), "operation", fixtureId)).toEqual({ readNodeId: "departments", echoNodeId: "echo" });
  expect(assertModelPolicyMatrixDraft(stringify({ ...base, metadata: { unresolved_requirements: [] } }), "read", fixtureId))
    .toEqual({ readNodeId: "departments" });
  expect(assertModelPolicyMatrixDraft(stringify({ ...operation, metadata: { unresolved_requirements: [] } }), "operation", fixtureId))
    .toEqual({ readNodeId: "departments", echoNodeId: "echo" });
});

test.each([{ marker: ["Missing requested outcome"] }, { marker: null }, { marker: {} }, { marker: "" }, { marker: [""] }])
("rejects unresolved requirement marker $marker", ({ marker }) => {
  for (const [kind, candidate] of [["read", base], ["operation", operation]] as const)
    expect(() => assertModelPolicyMatrixDraft(stringify({ ...candidate, metadata: { unresolved_requirements: marker } }), kind, fixtureId)).toThrow();
});

test.each([
  ["extra step", { ...operation, steps: [...operation.steps, { id: "mail", action: "send_email", parameters: {} }] }],
  ["reordered", { ...operation, steps: [...operation.steps].reverse() }],
  ["wrong value", { ...operation, steps: [operation.steps[0], { ...operation.steps[1], parameters: { value: "different", fixtureId } }] }],
  ["wrong fixture", { ...operation, steps: [operation.steps[0], { ...operation.steps[1], parameters: { value: "native-operation-qa-ack", fixtureId: "other" } }] }],
  ["extra parameter", { ...operation, steps: [operation.steps[0], { ...operation.steps[1], parameters: { value: "native-operation-qa-ack", fixtureId, other: 1 } }] }],
  ["schedule", { ...operation, trigger: { type: "schedule" } }],
  ["input override", { ...operation, trigger: { type: "manual", config: { inputSchema: {} } } }],
  ["control flow", { ...operation, metadata: { controlFlow: { root: {} } } }],
  ["extra field", { ...operation, steps: [operation.steps[0], { ...operation.steps[1], instruction: "side effect" }] }],
])("rejects model-generated %s", (_name, candidate) => {
  expect(() => assertModelPolicyMatrixDraft(stringify(candidate), "operation", fixtureId)).toThrow();
});
