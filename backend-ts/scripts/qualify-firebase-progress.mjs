import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { setTimeout as pause } from "node:timers/promises";
import { Repository, effectiveUserFromState } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { openFirestoreProgressReader } from "../src/storage/firestore-progress-reader.js";
import { authorityFingerprint } from "../src/agent/chat-progress.js";

// Actual native HTTPS export + encrypted Firestore while an independent
// acknowledged writer remains held. Progress state transitions are synthetic,
// NOT proof of model/ERP/task execution, business schedules or cloud readiness.
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records");
assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
const session = JSON.parse(await readFile(".functions/qa-session.json", "utf8")), config = session.config;
assert.equal(session.profile, "lcwe-native-functions-qa/v1");
assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records");
assert.equal(config.APP_ENV, "test"); assert.equal(config.MCP_MODE, "mock"); assert.equal(config.MCP_TRANSPORT, "bridge-v1");
assert(!config.GENERATION_BASE_URL && !config.GENERATION_API_KEY && !config.LCWE_LOCAL_DOCKER_QA);
assert(/^test_[a-f0-9]{32}_native$/.test(config.FIRESTORE_WORKSPACE_ID));
const namespace = { projectId: config.FIRESTORE_PROJECT_ID, databaseId: config.FIRESTORE_DATABASE_ID, workspaceId: config.FIRESTORE_WORKSPACE_ID };
const storage = await FirestoreRecordPersistence.open(config.STORAGE_ENCRYPTION_KEY, namespace), repository = await Repository.open(storage);
const runId = `progress_${randomUUID()}`, chatId = `chat_${randomUUID()}`, operationId = `op_${randomUUID()}`, workflowId = `workflow_${randomUUID()}`, timestamp = new Date().toISOString();
const yaml = "name: Synthetic nonwriter builder\ntrigger:\n  type: manual\nsteps: []\n";
let requests = 0;
const actor = "progress_owner", deniedActor = "progress_other";
const token = subject => `Bearer ${jwt.sign({}, config.JWT_SECRET, { algorithm: "HS256", subject, expiresIn: 3600 })}`;
const request = async (path, subject = actor, method = "GET") => {
  requests++;
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:23675/demo-lcwe-records/asia-south1/api${path}`, { method,
    headers: { authorization: token(subject) }, signal: AbortSignal.timeout(20_000), redirect: "error" });
  const body = await response.text();
  for (const secret of [config.JWT_SECRET, config.STORAGE_ENCRYPTION_KEY, "private-fixture-input", "private-log-key"]) assert(!body.includes(secret), "Private progress evidence escaped HTTP");
  return { status: response.status, body, value: body ? JSON.parse(body) : null, headers: response.headers, durationMs: Math.round(performance.now() - started) };
};
try {
  await repository.mutate(state => {
    state.users[actor] = { id: actor, name: "Progress fixture", email: "progress@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "PF", departmentId: null, lastLoginAt: null, createdAt: timestamp };
    state.roles.progress_own = { id: "progress_own", name: "Own progress", description: "Synthetic", permissions: ["execution:read_own", "chat:use", "workflow:read_own"], createdAt: timestamp };
    state.users[deniedActor] = { ...state.users[actor], id: deniedActor, roleId: "progress_own" };
    state.workflows[workflowId] = { id: workflowId, name: "Synthetic nonwriter builder", description: "Read projection qualification only", owner: { id: actor, name: "Progress fixture" },
      assignedUserIds: [], status: "draft-unvalidated", trigger: { type: "manual" }, steps: 0, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1,
      tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false };
    state.chats[chatId] = { id: chatId, ownerId: actor, title: "Native concurrent progress", createdAt: timestamp, updatedAt: timestamp, messageCount: 1,
      messages: [{ id: "message", role: "user", text: "Synthetic progress fixture only", createdAt: timestamp }] };
    state.executions[runId] = { id: runId, workflowId: "progress_fixture", workflowName: "Synthetic committed progress", status: "RUNNING", startedAt: timestamp, completedAt: null,
      durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: actor, name: "Progress fixture" },
      readProgress: { profile: "read-progress-v1", epoch: 1, nextStepIndex: 0, lastSequence: 1, persistence: "durable", attempts: {} } };
    state.executionEvents[runId] = [{ version: 1, executionId: runId, workflowId: "progress_fixture", sequence: 1, timestamp, type: "run.started", payload: { synthetic: true } }];
    state.executionLogs[runId] = [{ id: "log", message: "Synthetic progress only", apiKey: "private-log-key" }]; state.timelines[runId] = [];
    state.chatOperations[operationId] = { version: 1, id: operationId, sessionId: chatId, actorId: actor, userMessageId: "message", status: "RUNNING", stage: "planning", epoch: 1, lastSequence: 1,
      createdAt: timestamp, updatedAt: timestamp, traceId: randomUUID(), persistence: "durable", inputCiphertext: "private-fixture-input", idempotencyScope: "synthetic",
      requestFingerprint: "a".repeat(64), connectionFingerprint: "b".repeat(64), contractFingerprint: "c".repeat(64), authorityFingerprint: authorityFingerprint(effectiveUserFromState(state, actor)), modelBinding: null, attempts: [] };
    state.chatOperationEvents[operationId] = [{ version: 1, operationId, sessionId: chatId, sequence: 1, timestamp, type: "operation.started", stage: "planning", status: "RUNNING" }];
  });
  const generationBefore = (await storage.records.db.doc(storage.records.writerGenerationPath).get()).data(), before = await repository.snapshot();
  for (const path of [`/api/executions/${runId}`, `/api/executions/${runId}/events?after=0`, `/api/executions/${runId}/logs`, `/api/executions/${runId}/timeline`,
    `/api/chat/operations/${operationId}`, `/api/chat/sessions/${chatId}/operations`, `/api/chat/sessions/${chatId}`]) {
    const response = await request(path); assert.equal(response.status, 200, response.body);
    assert.equal(response.headers.get("cache-control"), "no-store"); assert(response.headers.get("x-trace-id")); repository.assertAuthority();
  }
  assert.deepEqual(await repository.snapshot(), before, "Progress GET changed writer state");
  assert.deepEqual((await storage.records.db.doc(storage.records.writerGenerationPath).get()).data(), generationBefore, "Progress acquired a writer generation");
  // Reproduce the builder's Promise.all while this independent writer stays
  // held. Both views must retain the committed source/revision and never enter
  // the exclusive invocation runtime or turn a GET into a mutation.
  const builder = await Promise.all([request(`/api/workflows/${workflowId}`), request(`/api/workflows/${workflowId}/yaml`)]);
  for (const response of builder) { assert.equal(response.status, 200, response.body); assert.equal(response.headers.get("cache-control"), "no-store"); }
  assert.equal(builder[0].value.data.id, workflowId); assert.equal(builder[0].value.data.draftVersion, 1);
  assert.equal(builder[0].value.data.yaml, undefined); assert.equal(builder[1].value.data.yaml, yaml); assert.equal(builder[1].value.data.version, 1);
  assert.deepEqual(await repository.snapshot(), before, "Concurrent builder reads changed committed state"); repository.assertAuthority();
  assert.deepEqual((await storage.records.db.doc(storage.records.writerGenerationPath).get()).data(), generationBefore, "Builder reads acquired the exclusive writer");
  for (const suffix of ["", "/yaml"]) assert.equal((await request(`/api/workflows/${workflowId}${suffix}`, deniedActor)).status, 404);
  await repository.mutate(state => { state.workflows[workflowId].assignedUserIds = [deniedActor]; });
  for (const suffix of ["", "/yaml"]) assert.equal((await request(`/api/workflows/${workflowId}${suffix}`, deniedActor)).status, 200);
  await repository.mutate(state => { state.workflows[workflowId].assignedUserIds = []; });
  assert.equal((await request(`/api/workflows/${workflowId}/yaml`, deniedActor)).status, 404);
  assert.equal((await request(`/api/workflows/${workflowId}/yaml?view=private`)).status, 400);
  const direct = openFirestoreProgressReader({ storageDriver: "firestore-records", storageEncryptionKey: config.STORAGE_ENCRYPTION_KEY,
    firestoreProjectId: namespace.projectId, firestoreDatabaseId: namespace.databaseId, firestoreWorkspaceId: namespace.workspaceId });
  try { assert.deepEqual(await direct.snapshot(), before); } finally { await direct.close(); }
  assert.equal((await request(`/api/executions/${runId}`, deniedActor)).status, 404);
  assert.equal((await request(`/api/chat/operations/${operationId}`, deniedActor)).status, 404);
  const waiting = request(`/api/executions/${runId}/events?after=1&waitMs=8000`);
  await pause(500);
  await repository.mutate(state => {
    state.executionEvents[runId].push({ version: 1, executionId: runId, workflowId: "progress_fixture", sequence: 2, timestamp: new Date().toISOString(), type: "node.completed", payload: { synthetic: true }, nodeId: "lookup" });
    state.executions[runId].readProgress.lastSequence = 2;
  });
  const changed = await waiting; assert.equal(changed.status, 200, changed.body); assert.equal(changed.value.data.cursor, 2); assert.equal(changed.value.data.waited, true);
  const revokedWait = request(`/api/executions/${runId}/events?after=2&waitMs=8000`);
  await pause(500);
  const originalPermissions = (await repository.snapshot()).roles.role_admin.permissions;
  await repository.mutate(state => { state.roles.role_admin.permissions = []; });
  const revoked = await revokedWait; assert.equal(revoked.status, 403, revoked.body); assert(!revoked.body.includes("node.completed"));
  await repository.mutate(state => { state.roles.role_admin.permissions = originalPermissions; state.executions[runId].status = "DONE"; });
  const terminal = await request(`/api/executions/${runId}/events?after=2&waitMs=8000`); assert.equal(terminal.status, 200, terminal.body); assert.equal(terminal.value.data.waited, false); assert.equal(terminal.value.data.status, "DONE");
  const head = await request(`/api/executions/${runId}`, actor, "HEAD"); assert.equal(head.status, 200); assert.equal(head.body, "");
  assert.equal((await request(`/api/executions/${runId}/events?after=2&after=1`)).status, 400);
  // Configuration reads must work without taking authority from this writer.
  // These fake credentials are never entered into a provider/MCP runtime.
  assert.deepEqual((await repository.snapshot()).providers, {});
  await repository.mutate(state => { state.providers.progress_provider = { id: "progress_provider", name: "Synthetic catalog", type: "openai_compatible",
    baseUrl: "https://catalog.example.invalid/v1", apiKey: "private-catalog-fixture-key", model: "fixture-a", fallbackModel: "fixture-b", additionalModels: ["fixture-c"],
    active: true, temperature: 0, revision: 1 }; });
  const configuredBefore = await repository.snapshot();
  const heldCatalogs = await Promise.all(Array.from({ length: 6 }, () => request("/api/chat/models", deniedActor)));
  for (const response of heldCatalogs) {
    assert.equal(response.status, 200, response.body); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(response.value.data.models, ["fixture-a", "fixture-b", "fixture-c"]);
    assert.equal(response.value.data.binding.configurationRevision, null); assert.equal(response.value.meta.runtimeActivationConfirmed, false);
    assert(!/private-catalog-fixture-key|catalog\.example/.test(response.body));
  }
  assert.deepEqual(await repository.snapshot(), configuredBefore, "Catalog GET changed committed configuration");
  await repository.mutate(state => { state.providers.progress_provider.model = "fixture-new"; });
  assert.equal((await request("/api/chat/models", deniedActor)).value.data.binding.model, "fixture-new");
  const chatPermissions = (await repository.snapshot()).roles.progress_own.permissions;
  await repository.mutate(state => { state.roles.progress_own.permissions = []; });
  assert.equal((await request("/api/chat/models", deniedActor)).status, 403);
  await repository.mutate(state => { state.roles.progress_own.permissions = chatPermissions; state.providers.progress_provider.active = false; });
  assert.deepEqual((await request("/api/chat/models", deniedActor)).value.data, { configured: false, binding: null, models: [] });
  await repository.mutate(state => { delete state.providers.progress_provider; });
  await repository.mutate(state => { state.users[actor].status = "Suspended"; });
  assert.equal((await request(`/api/chat/operations/${operationId}`)).status, 403);
  repository.assertAuthority();
  assert.deepEqual((await storage.records.db.doc(storage.records.writerGenerationPath).get()).data(), generationBefore, "A reader changed exclusive writer generation");
  console.log(`PASS: ${requests} native read HTTP requests while an independent Firestore writer remained held; ten contracts including concurrent builder metadata/YAML and model catalog, current assignment/provider changes/revocation, committed wake, private-data filtering and unchanged writer generation. Synthetic state only; zero model/ERP/effect/task execution or deployment.`);
} finally { await repository.close(); }

// Preserve the original three six-client waves and original request timeout.
// The catalog now has a nonwriter path; these waves no longer qualify command
// admission. General writable-command contention remains a separate gate.
const waves = [];
for (let wave = 0; wave < 3; wave++) {
  const responses = await Promise.all(Array.from({ length: 6 }, () => request("/api/chat/models", "native_owner")));
  for (const response of responses) { assert.equal(response.status, 200, response.body); assert.equal(response.value.data.configured, false); }
  waves.push(responses.map(response => ({ status: response.status, durationMs: response.durationMs })));
}
await writeFile("../docs/evidence/2026-10-12/native-catalog-concurrency.json", JSON.stringify({ profile: "native-configured-catalog/v1", createdAt: new Date().toISOString(),
  heldWriterRequests: requests - 18, contracts: 10, releasedWriterWaves: waves,
  scope: "Actual native Functions/Firestore configuration reads; no general writable-command, inference, ERP, schedule, deployment or load-SLO acceptance" }, null, 2), { flag: "wx" });
console.log("PASS: eighteen overlapping native model-list reads in three unchanged six-client waves after writer release. This qualifies the configured catalog only, not general command admission, inference, cancellation during tools, production throughput or load SLOs.");
