import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { startNativePolicyFixture, nativePolicyURL, nativeMatrixSynthesisPrompt } from "../scripts/native-functions-policy-qa.mjs";
let fixture;
afterEach(async () => { await fixture?.close(); fixture = undefined; vi.unstubAllEnvs(); });
const config = { LCWE_LOCAL_DOCKER_QA: "native-operation/v1", GOVERNANCE_URL: nativePolicyURL, GOVERNANCE_API_KEY: "k".repeat(32),
  ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080", FIRESTORE_PROJECT_ID: "demo-lcwe-records", FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native` };
const body = () => ({ requestId: randomUUID(), user: { id: "native_owner", role: "Platform Admin", department: null },
  intent: "CreateWorkflow", proposedActions: ["qa_list_departments", "qa_native_integration_echo"], caseContext: {} });
test("native online policy fixture enforces exact authority/action scope, outage and bounded HTTP contract", async () => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  fixture = await startNativePolicyFixture(config);
  const post = async (value, options = {}) => {
    const response = await fetch(options.url ?? nativePolicyURL, { method: "POST", headers: { authorization: `Bearer ${options.key ?? config.GOVERNANCE_API_KEY}`, connection: "close" },
      body: options.raw ?? JSON.stringify(value), signal: AbortSignal.timeout(3000) });
    await response.body?.cancel(); return response.status;
  };
  expect(await post(body())).toBe(200);
  expect(await post({ ...body(), intent: "PublishWorkflow" })).toBe(200);
  expect(await post({ ...body(), intent: "ReadJobWorker", proposedActions: ["qa_list_departments"] })).toBe(200);
  expect(await post({ ...body(), intent: "OperationJobWorker" })).toBe(200);
  expect(await post({ ...body(), intent: "ReadToolBroker" })).toBe(200);
  expect(await post(body(), { key: "wrong" })).toBe(403);
  for (const value of [{ ...body(), user: { ...body().user, id: "native_reviewer" } },
    { ...body(), user: { ...body().user, role: "admin" } }, { ...body(), proposedActions: ["send_email"] },
    { ...body(), proposedActions: [] }, { ...body(), proposedActions: ["qa_list_departments", "qa_list_departments"] },
    { ...body(), intent: "RunWorkflow" }, { ...body(), intent: "ReadJobWorker" }, { ...body(), caseContext: { bypass: true } }, { ...body(), grant: true }])
    expect(await post(value)).toBe(403);
  expect(await post(body(), { raw: "{" })).toBe(400);
  expect(await post(body(), { raw: "x".repeat(64001) })).toBe(413);
  expect(await post(body(), { url: "http://127.0.0.1:23676/other" })).toBe(404);
  fixture.setAvailable(false); expect(await post(body())).toBe(503);
  fixture.setAvailable(true); expect(await post(body())).toBe(200);
  expect(fixture.accepted).toHaveLength(6); expect(fixture.refused).toContain("UNAVAILABLE");
});
test("policy fixture refuses non-demo execution before opening a listener", async () => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "other-project");
  await expect(startNativePolicyFixture(config)).rejects.toThrow();
});

test("synthesis fixture accepts exact original prompts and rejects changes to scope and context", async () => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  fixture = await startNativePolicyFixture(config);
  const fixtureId = randomUUID();
  const read = { ...body(), intent: nativeMatrixSynthesisPrompt("read"), proposedActions: ["qa_list_departments"], caseContext: { priorMessageCount: 0 } };
  const operation = { ...body(), intent: nativeMatrixSynthesisPrompt("operation", fixtureId), caseContext: { priorMessageCount: 1 } };
  const post = async value => {
    const response = await fetch(nativePolicyURL, { method: "POST", headers: { authorization: `Bearer ${config.GOVERNANCE_API_KEY}`, connection: "close" },
      body: JSON.stringify(value), signal: AbortSignal.timeout(3000) });
    await response.body?.cancel(); return response.status;
  };
  expect(await post(read)).toBe(200); expect(await post(operation)).toBe(200);
  expect(fixture.accepted.map(value => ({ kind: value.kind, intent: value.intent }))).toEqual([
    { kind: "SynthesisWorkflow", intent: read.intent }, { kind: "SynthesisWorkflow", intent: operation.intent },
  ]);
  for (const value of [
    { ...read, intent: "Create any workflow" }, { ...read, intent: read.intent + " Send email." },
    { ...operation, intent: operation.intent.replace("native-operation-qa-ack", "different") },
    { ...operation, intent: operation.intent.replace(fixtureId, "invalid") },
    { ...operation, proposedActions: [...operation.proposedActions].reverse() },
    { ...operation, proposedActions: ["qa_list_departments"] },
    { ...read, proposedActions: ["qa_list_departments", "qa_native_integration_echo"] },
    { ...read, user: { ...read.user, id: "native_reviewer" } },
    { ...read, caseContext: {} }, { ...read, caseContext: { priorMessageCount: 0, bypass: true } },
    ...[-1, 2, 0.5, "0"].map(priorMessageCount => ({ ...read, caseContext: { priorMessageCount } })),
  ]) expect(await post(value)).toBe(403);
  expect(fixture.accepted).toHaveLength(2);
});
