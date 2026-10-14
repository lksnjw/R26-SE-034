import { expect, test } from "vitest";
// @ts-expect-error JavaScript operator qualification, not an application module.
import { assertNativeDurabilityScope, nativeWorkspaceCheckpoint } from "../scripts/native-workspace-durability-qa.mjs";

const config = { FIRESTORE_PROJECT_ID: "demo-lcwe-records", FIRESTORE_DATABASE_ID: "(default)",
  FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`, STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  LCWE_LOCAL_DOCKER_QA: "native-read/v1", ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080" };
const env = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:23671", GCLOUD_PROJECT: "demo-lcwe-records" };
const references = { workflowId: "wf_test", chatId: "chat_test", executionId: "run-test" };
const state = () => ({
  workflows: { wf_test: { chatSessionId: "chat_test", draftVersion: 2, publishedVersion: 2, yaml: "fixture source" } },
  versions: { wf_test: [{ version: 2, artifactState: "PUBLISHED", yaml: "fixture source" }] },
  chats: { chat_test: { selectedModel: "local-alternate-fixture", messages: [{ artifacts: { proposal: { status: "APPLIED", appliedVersion: 2 } } }] } },
  executions: { "run-test": { workflowId: "wf_test", status: "DONE", workflowSnapshot: { version: 2, yaml: "fixture source" },
    stepOutputs: { departments: { structuredContent: { data: Array.from({ length: 8 }, (_, id) => ({ id })) } } },
    finalOutput: { structuredContent: { departmentCount: 8 } } } },
  executionEvents: { "run-test": [{ sequence: 1, type: "run.completed" }] },
  timelines: { "run-test": [{ nodeId: "departments", status: "DONE" }] },
});

test("native durable reopen accepts only the declared isolated emulator scope", () => {
  expect(() => assertNativeDurabilityScope(config, env)).not.toThrow();
});
test.each([
  [{ FIRESTORE_PROJECT_ID: "owner-project" }, {}], [{ FIRESTORE_DATABASE_ID: "owner" }, {}],
  [{ FIRESTORE_WORKSPACE_ID: "owner" }, {}], [{ LCWE_LOCAL_DOCKER_QA: "native-operation/v1" }, {}],
  [{ ERPBRIDGE_BASE_URL: "https://remote.example.test" }, {}], [{ STORAGE_ENCRYPTION_KEY: "bad" }, {}],
  [{}, { FIRESTORE_EMULATOR_HOST: "remote.example.test:23671" }], [{}, { GCLOUD_PROJECT: "owner-project" }],
  [{}, { GOOGLE_APPLICATION_CREDENTIALS: "owner-file.json" }],
])("native durable reopen refuses configuration outside its isolated scope: %j", (configPatch, envPatch) => {
  expect(() => assertNativeDurabilityScope({ ...config, ...configPatch }, { ...env, ...envPatch })).toThrow();
});

test("checkpoint exposes only known identity/count/version fields and content hashes, never saved prose or credentials", () => {
  const saved = state();
  Object.assign(saved.workflows.wf_test, { privateMarkerSecret: "PRIVATE-fixture-marker" });
  const value = nativeWorkspaceCheckpoint(saved, references);
  expect(value).toMatchObject({ ...references, profile: "native-workspace-durability/v1", draftVersion: 2, publishedVersion: 2,
    status: "DONE", selectedModel: "local-alternate-fixture", savedRows: 8, analysisCount: 8 });
  expect(JSON.stringify(value)).not.toContain("PRIVATE-fixture-marker"); expect(JSON.stringify(value)).not.toContain("fixture source");
  for (const [key, hash] of Object.entries(value)) if (key.endsWith("Hash")) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(nativeWorkspaceCheckpoint(structuredClone(saved), references)).toEqual(value);
});

test.each(["workflow", "versions", "model", "chat", "snapshot", "outputs", "events", "timeline"])("durable comparison detects a changed %s", key => {
  const saved = state(), expected = nativeWorkspaceCheckpoint(saved, references);
  if (key === "workflow") saved.workflows.wf_test.yaml += " changed";
  if (key === "versions") saved.versions.wf_test[0]!.yaml += " changed";
  if (key === "chat") Object.assign(saved.chats.chat_test.messages[0]!, { text: "changed" });
  if (key === "snapshot") saved.executions["run-test"].workflowSnapshot.yaml += " changed";
  if (key === "outputs") saved.executions["run-test"].stepOutputs.departments.structuredContent.data[0]!.id = 99;
  if (key === "events") saved.executionEvents["run-test"][0]!.sequence = 2;
  if (key === "timeline") saved.timelines["run-test"][0]!.status = "FAILED";
  if (key === "model") saved.chats.chat_test.selectedModel = "local-planning-fixture";
  if (key === "model") expect(() => nativeWorkspaceCheckpoint(saved, references)).toThrow();
  else expect(nativeWorkspaceCheckpoint(saved, references)).not.toEqual(expected);
});

test.each(["missing", "wrong-link", "draft", "publication", "running", "rows", "analysis", "proposal"])("checkpoint refuses incomplete or mismatched saved evidence: %s", key => {
  const saved = state();
  if (key === "missing") delete (saved.workflows as Record<string, unknown>).wf_test;
  if (key === "wrong-link") saved.workflows.wf_test.chatSessionId = "other";
  if (key === "draft") saved.workflows.wf_test.draftVersion = 1;
  if (key === "publication") saved.workflows.wf_test.publishedVersion = 0;
  if (key === "running") saved.executions["run-test"].status = "RUNNING";
  if (key === "rows") saved.executions["run-test"].stepOutputs.departments.structuredContent.data.pop();
  if (key === "analysis") saved.executions["run-test"].finalOutput.structuredContent.departmentCount = 7;
  if (key === "proposal") saved.chats.chat_test.messages[0]!.artifacts.proposal.status = "PROPOSED";
  expect(() => nativeWorkspaceCheckpoint(saved, references)).toThrow();
});
