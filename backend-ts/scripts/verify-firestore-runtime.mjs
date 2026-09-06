import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { openApplicationRepository } from "../src/storage/open-repository.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { boundedOperation } from "../src/core/bounded-operation.js";
import { buildApp } from "../src/http/app.js";
import { toolSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { exactBridgeName, bridgeTransportSchema } from "../src/tools/erpbridge-contract.js";
import { capabilityContractHash, admissionAuthorizer, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { requestRuntimeApproval, runtimeApprovalPolicyHash, consumeRuntimeApproval } from "../src/runner/runtime-approvals.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../src/core/canonical-json.js";

// Every SDK database call targets a fresh synthetic workspace in this exact
// local demo emulator. Provider/MCP transports below are explicit in-process
// fixtures, never network fallback or live-effect clients.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded demo project, fixed loopback Firestore emulator and no credential file are required");
process.env.NODE_ENV = "test";
const key = randomBytes(32).toString("base64"), namespace = { projectId, databaseId: "(default)", workspaceId: `test_${randomUUID().replaceAll("-", "")}_runtime` };
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: projectId, FIRESTORE_DATABASE_ID: namespace.databaseId,
  FIRESTORE_WORKSPACE_ID: namespace.workspaceId, STORAGE_ENCRYPTION_KEY: key, MCP_MODE: "mock", MCP_TRANSPORT: "erpbridge-mcp", MCP_TIMEOUT_MS: "10000",
  ERPBRIDGE_BASE_URL: "https://isolated.fixture.example.test", ERPBRIDGE_MCP_TOKEN: "fixture-only-not-a-real-token", ERPBRIDGE_ROLE_MAP: JSON.stringify({ "Platform Admin": "platform_admin" }), JWT_SECRET: "isolated-firestore-runtime-fixture-secret-32-bytes" });
const codec = new FirestoreRecordCodec(key, namespace), log = value => console.log(`PASS: ${value}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownedBarriers = [];
const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); const gate = { promise, release }; ownedBarriers.push(gate); return gate; };
const sequential = stringify({ name: "Firestore report", description: "Read exact fixture data", trigger: { type: "manual" }, steps: [{ id: "lookup", action: "read", parameters: { id: "{{input.id}}" } }] });
const collection = stringify({ name: "Firestore collection", description: "Bounded invoice fixture", trigger: { type: "manual" }, steps: [{ id: "lookup", action: "read", parameters: { id: "{{each.item}}" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [
  { kind: "foreach", id: "each", items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, maxItems: 3,
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup" }] }, collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "id"] } } },
  { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
] } } } });
const tool = toolSchema.parse({ tool_id: "FIXTURE-READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: ["Platform Admin"], risk_level: "low", side_effects: [],
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["platform_admin"] } });
const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "fixture-v1", rules: "fixture-v1" } }), hash: () => capabilityContractHash(tool),
  findTool: name => name === tool.name ? tool : undefined, enabledRules: () => [], findRule: () => undefined };
let repository, app, session, services, persistence;
const calls = [], models = [];
let sdkHook, modelHook;
const headers = (actor = "owner") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actor, expiresIn: 3600 })}` });
async function waitFor(reader, label) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) { const result = await reader(); if (result) return result; await delay(10); }
  throw new Error(`Synthetic runtime wait timed out: ${label}`);
}
async function start(repositoryValue) {
  repository = repositoryValue; persistence = repository.persistence;
  assert(persistence instanceof FirestoreRecordPersistence); assert.equal(persistence.readQueueDurability, "encrypted-single-writer"); assert.equal(persistence.executionCheckpointDurability, "encrypted-record-transactions/v1");
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  session = await createErpbridgeMcpSession({ baseURL: config.erpbridgeBaseURL, token: config.erpbridgeMcpToken, timeoutMs: 10_000, validator,
    admissionAuthorizer: admissionAuthorizer(repository, registries), sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {},
      listTools: async () => [{ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), _meta: { "toolplane.resourceVersion": "1.0.0", "toolplane.resourceDigest": "a".repeat(64), "io.erpbridge/allowedRoles": ["platform_admin"] } }],
      callTool: async (name, args, meta) => {
        assert.equal(name, exactBridgeName(tool)); assert.equal(args.role, "platform_admin"); assert.equal(meta["toolplane.resourceDigest"], "a".repeat(64));
        calls.push(args.id); await sdkHook?.(args); return { content: [], structuredContent: { id: args.id.toUpperCase(), token: "synthetic-remote-secret" } };
      } } });
  const providerRuntime = new ProviderRuntime(repository, executor, async (url, init) => {
    assert.equal(url, "https://provider.fixture.example.test/v1/chat/completions"); const request = JSON.parse(String(init.body)); models.push(request.model); await modelHook?.(request, init.signal);
    const node = request.messages[0].content.includes("ONE SELECTED NODE PATCH"), owner = request.messages[0].content.includes("ONE SELECTED COLLECTION PATCH"), answered = request.messages.some(message => message.role === "tool");
    if (owner) assert.deepEqual(JSON.parse(request.messages[1].content).tools, []);
    return Response.json({ choices: [{ finish_reason: node || owner || answered ? "stop" : "tool_calls", message: owner ? { content: '{"maxItems":2}' } : node ? { content: '{"description":"Reviewable fixture edit"}' } : answered ? { content: "Confirmed fixture invoice CHAT." } : {
      content: "", tool_calls: [{ id: "fixture-chat-read", type: "function", function: { name: "read", arguments: '{"id":"chat"}' } }],
    } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  providerRuntime.activate({ id: "fixture-provider", name: "Fixture provider", type: "openai_compatible", baseURL: "https://provider.fixture.example.test/v1", apiKey: "synthetic-provider-secret", model: "fixture-model-a", additionalModels: ["fixture-model-b"], temperature: 0, timeoutMs: 10_000 });
  services = { config, repository, registries, validator, executor, providerRuntime, synthesis: new SynthesisService(providerRuntime, registries, validator), erpbridgeSession: session };
  app = await buildApp(services); await app.ready();
}
async function request(method, url, payload, status, actor = "owner") {
  const reply = await app.inject({ method, url, headers: headers(actor), ...(payload === undefined ? {} : { payload }) });
  assert.equal(reply.statusCode, status, reply.body); return reply.json();
}
async function stop() {
  try { await app?.close(); } finally { try { await session?.close(); } finally { await repository?.close(); app = session = undefined; } }
}

try {
  await start(await openApplicationRepository(config));
  const timestamp = new Date().toISOString();
  await repository.mutate(state => {
    for (const id of ["owner", "other"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: timestamp };
    state.settings.unrelated = { text: "Preserved domain", private: "synthetic-domain-secret" };
    for (const [id, yaml] of [["single", sequential], ["collection", collection], ["collection_edit", collection]]) {
      state.workflows[id] = { id, name: id, description: "Synthetic fixture", owner: { id: "owner", name: "owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false };
      state.versions[id] = [];
    }
  });
  const actor = await repository.effectiveUser("owner"), observations = (await observeCapabilities({ repository, registries, session, user: actor })).observations;
  for (const observation of observations) await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: {
    observationId: observation.id, contractHash: observation.contractHash, decisionKey: "firestore-runtime-reviewed-fixture", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Synthetic SDK qualification only" } });
  for (const id of ["single", "collection"]) await request("POST", `/api/workflows/${id}/publish`, {}, 200);
  const ready = await request("GET", "/api/workflows/collection/readiness", undefined, 200); assert.equal(ready.data.can_attempt_run, true);
  const read = await request("POST", "/api/workflows/single/run", { input: { id: "single" } }, 200); assert.equal(read.data.status, "DONE"); assert.deepEqual(calls, ["single"]);
  const collectionRead = await request("POST", "/api/workflows/collection/run", { input: { rows: ["a", "b"] } }, 200);
  assert.equal(collectionRead.data.status, "DONE"); assert.deepEqual(collectionRead.data.finalOutput, ["A", "B"]); assert.deepEqual(calls, ["single", "a", "b"]);
  assert.equal(models.length, 0); log("actual Firestore application driver, reviewed publication/readiness and normal synchronous read/collection routes used exact fixture SDK calls, with zero model calls");

  const queuedPayload = { mode: "async-read", idempotencyKey: "firestore-runtime-queue-fixture-0001", input: { rows: ["queued-a", "queued-b"], private_token: "synthetic-private-input" } };
  const admitted = await request("POST", "/api/workflows/collection/run", queuedPayload, 202), queuedId = admitted.data.id;
  await waitFor(async () => { const state = await repository.snapshot(); return state.readJobs[queuedId]?.state === "FINISHED" && state.executions[queuedId]; }, "queued collection completion");
  const state = await repository.snapshot(); assert.deepEqual(state.executions[queuedId].finalOutput, ["QUEUED-A", "QUEUED-B"]); assert.equal(state.readJobs[queuedId].lease, undefined); assert.equal(state.readJobs[queuedId].inputCiphertext, undefined); assert.equal(state.readContinuations[queuedId], undefined);
  assert.equal((await request("POST", "/api/workflows/collection/run", queuedPayload, 202)).data.id, queuedId); assert.deepEqual(calls, ["single", "a", "b", "queued-a", "queued-b"]);
  const events = await request("GET", `/api/executions/${queuedId}/events?after=0&limit=100`, undefined, 200); assert(events.data.events.some(event => event.type === "iteration.action.completed"));
  assert(!JSON.stringify(events).includes("synthetic-private-input")); assert(!JSON.stringify(state.executions[queuedId]).includes("synthetic-remote-secret"));
  assert.deepEqual(state.settings.unrelated, { text: "Preserved domain", private: "synthetic-domain-secret" });
  log("normal queued collection, once-only admission, separately confirmed item answers, scoped event replay and terminal private-input/lease/cursor removal passed on actual Firestore");

  const chat = await request("POST", "/api/chat/sessions", {}, 201), chatId = chat.data.id;
  const chatPayload = { content: "Show me invoice details", model: "fixture-model-b", delivery: "async-chat", idempotencyKey: "firestore-runtime-chat-fixture-0001" };
  const chatReceipt = await request("POST", `/api/chat/sessions/${chatId}/messages`, chatPayload, 202), operationId = chatReceipt.data.operation.id;
  await waitFor(async () => { const op = (await repository.snapshot()).chatOperations[operationId]; return op && !["QUEUED", "RUNNING"].includes(op.status) && op; }, "chat answer");
  const operation = await request("GET", `/api/chat/operations/${operationId}?after=0`, undefined, 200);
  assert.equal(operation.data.operation.status, "ANSWERED"); assert.equal(operation.data.operation.attempts[0].status, "DONE"); assert.equal(operation.data.operation.attempts[0].output.structuredContent.id, "CHAT");
  assert.equal((await request("POST", `/api/chat/sessions/${chatId}/messages`, chatPayload, 202)).data.operation.id, operationId);
  assert.equal(calls.filter(id => id === "chat").length, 1); assert(models.every(model => model === "fixture-model-b"));
  assert(!JSON.stringify(operation).match(/synthetic-provider-secret|synthetic-remote-secret|inputCiphertext/));
  await request("GET", `/api/chat/operations/${operationId}`, undefined, 404, "other");
  const nodePayload = { content: "Edit this selected node", model: "fixture-model-b", delivery: "async-chat", idempotencyKey: "firestore-runtime-node-fixture-0001",
    nodeContext: { workflowId: "single", nodeId: "lookup", baseVersion: 1, baseHash: workflowContentHash(sequential) } };
  const callsBeforeNode = calls.length, nodeReceipt = await request("POST", `/api/chat/sessions/${chatId}/messages`, nodePayload, 202), nodeOperation = nodeReceipt.data.operation.id;
  await waitFor(async () => { const op = (await repository.snapshot()).chatOperations[nodeOperation]; return op && !["QUEUED", "RUNNING"].includes(op.status) && op; }, "selected node proposal");
  assert.equal((await repository.snapshot()).chatOperations[nodeOperation].status, "ANSWERED"); assert.equal(calls.length, callsBeforeNode); assert.equal((await repository.snapshot()).workflows.single.yaml, sequential);
  log("normal saved chat job used its selected model, committed one redacted SDK answer and enforced operation ACL/idempotency; selected-node chat saved a reviewable proposal without applying or dispatching");

  const ownerPayload = { content: "Limit this selected collection to two items", model: "fixture-model-b", delivery: "async-chat", idempotencyKey: "firestore-runtime-owner-fixture-0001",
    nodeContext: { workflowId: "collection_edit", nodeId: "each", baseVersion: 1, baseHash: workflowContentHash(collection) } };
  const modelsBeforeOwner = models.length, ownerOperation = (await request("POST", `/api/chat/sessions/${chatId}/messages`, ownerPayload, 202)).data.operation.id;
  await waitFor(async () => { const op = (await repository.snapshot()).chatOperations[ownerOperation]; return op && !["QUEUED", "RUNNING"].includes(op.status) && op; }, "collection owner proposal");
  const ownerState = await repository.snapshot(), ownerProposal = ownerState.chats[chatId].messages.at(-1).artifacts.proposal;
  assert.equal(ownerState.chatOperations[ownerOperation].status, "ANSWERED"); assert.deepEqual(ownerState.chatOperations[ownerOperation].attempts, []);
  assert.deepEqual(ownerProposal.command, { type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } }); assert.equal(ownerProposal.validation.passed, true);
  assert.equal(ownerState.workflows.collection_edit.yaml, collection); assert.equal(models.length, modelsBeforeOwner + 1); assert.equal(calls.length, callsBeforeNode);
  assert.equal((await request("POST", `/api/chat/sessions/${chatId}/messages`, ownerPayload, 202)).data.operation.id, ownerOperation); assert.equal(models.length, modelsBeforeOwner + 1);
  await request("GET", `/api/chat/operations/${ownerOperation}`, undefined, 404, "other");
  const applyPayload = { baseVersion: 1, baseHash: workflowContentHash(collection), proposalId: ownerProposal.id, command: ownerProposal.command };
  const applied = (await request("POST", "/api/workflows/collection_edit/commands", applyPayload, 200)).data;
  assert.equal(applied.version, 2); assert.equal(applied.canRun, false); assert.equal(applied.publishedVersion, 0);
  const originalSource = parseWorkflowYAMLStrict(collection), editedSource = parseWorkflowYAMLStrict(applied.yaml);
  assert.deepEqual(editedSource.steps, originalSource.steps); assert.deepEqual(editedSource.metadata.controlFlow.root.nodes[0], { ...originalSource.metadata.controlFlow.root.nodes[0], maxItems: 2 });
  await request("POST", "/api/workflows/collection_edit/commands", applyPayload, 409);
  assert.equal((await repository.snapshot()).chats[chatId].messages.at(-1).artifacts.proposal.status, "APPLIED"); assert.equal(calls.length, callsBeforeNode);
  log("collection-owner saved chat used its dedicated tools-free patch contract and selected model; exact explicit once-only draft apply preserved body/actions and never published or dispatched");

  const saved = await repository.snapshot(); await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).chats, saved.chats); assert.deepEqual((await repository.snapshot()).executions, saved.executions);
  assert.deepEqual((await repository.snapshot()).versions, saved.versions); assert.equal((await request("GET", `/api/chat/operations/${operationId}`, undefined, 200)).data.operation.status, "ANSWERED");
  assert.deepEqual((await repository.snapshot()).workflows.collection_edit, saved.workflows.collection_edit); assert.equal((await repository.snapshot()).chats[chatId].messages.at(-1).artifacts.proposal.status, "APPLIED");
  assert.equal(calls.length, callsBeforeNode); log("fresh application repository/HTTP worker startup preserved chats, proposals, versions and confirmed runs without replay");

  const historyReady = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.equal(historyReady.editHistory.undoDepth, 1); assert.equal(historyReady.editHistory.redoDepth, 0);
  const undoPayload = { baseVersion: historyReady.version, baseHash: historyReady.contentHash, command: { type: "undoDraft", versionId: historyReady.editHistory.undoTarget } };
  const undone = (await request("POST", "/api/workflows/collection_edit/commands", undoPayload, 200)).data;
  assert.equal(undone.version, 3); assert.equal(undone.yaml, collection); assert.equal(undone.canRun, false); assert.equal(undone.publishedVersion, 0); assert.equal(undone.editHistory.redoDepth, 1);
  await request("POST", "/api/workflows/collection_edit/commands", undoPayload, 409);
  const historyAfterUndo = await repository.snapshot(); await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).versions, historyAfterUndo.versions);
  const reopened = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.deepEqual(reopened.editHistory, undone.editHistory);
  const redone = (await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: reopened.version, baseHash: reopened.contentHash, command: { type: "redoDraft", versionId: reopened.editHistory.redoTarget } }, 200)).data;
  assert.equal(redone.version, 4); assert.equal(redone.yaml, applied.yaml); assert.equal(redone.canRun, false); assert.equal(redone.publishedVersion, 0);
  const historyQuery = `view=edit-history&baseVersion=${redone.version}&baseHash=${redone.contentHash}`;
  const history = (await request("GET", `/api/workflows/collection_edit/versions?${historyQuery}`, undefined, 200)).data;
  assert.equal(history.total, 4); assert.equal(history.entries[0].change.type, "redoDraft"); assert(!JSON.stringify(history).includes('"yaml"'));
  assert.equal(calls.length, callsBeforeNode); assert.equal(models.length, modelsBeforeOwner + 1);
  assert.equal((await repository.snapshot()).chats[chatId].messages.at(-1).artifacts.proposal.appliedVersion, 2);
  log("normal Firestore saved-history HTTP undo/restart/redo preserved exact collection content, immutable revisions and historical proposal provenance without publication, SDK dispatch or model calls");

  // Losing an edit's COMMIT acknowledgement must not be reported as "nothing
  // changed": the durable revision may exist while the old cache is fenced.
  const actualHistoryTransaction = persistence.records.db.runTransaction.bind(persistence.records.db); let lostHistoryAck = false;
  persistence.records.db.runTransaction = async (callback, options) => {
    let activated = false;
    const value = await actualHistoryTransaction(async transaction => {
      const set = transaction.set; transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath) activated = true; return set.call(this, ref, ...args); };
      try { return await callback(transaction); } finally { transaction.set = set; }
    }, options);
    if (activated && !lostHistoryAck) { lostHistoryAck = true; throw new Error("Synthetic saved-history post-COMMIT acknowledgement lost"); }
    return value;
  };
  const uncertainUndo = { baseVersion: redone.version, baseHash: redone.contentHash, command: { type: "undoDraft", versionId: redone.editHistory.undoTarget } };
  const uncertainEdit = await request("POST", "/api/workflows/collection_edit/commands", uncertainUndo, 503);
  assert(lostHistoryAck); assert.equal(uncertainEdit.meta.code, "DRAFT_SAVE_UNCONFIRMED"); assert(!uncertainEdit.message.includes("nothing was changed"));
  persistence.records.db.runTransaction = actualHistoryTransaction;
  await repository.recoverPersistenceState();
  const reconciledHistory = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.equal(reconciledHistory.version, 5); assert.equal(reconciledHistory.yaml, collection); assert.equal(reconciledHistory.editHistory.redoDepth, 1);
  await request("POST", "/api/workflows/collection_edit/commands", uncertainUndo, 409);
  assert.equal(calls.length, callsBeforeNode); assert.equal(models.length, modelsBeforeOwner + 1);
  // Storage reconciliation does not silently revive stopped dispatch workers.
  // A fresh supervised application instance is required by this runtime.
  await request("POST", "/api/workflows/collection/run", { mode: "async-read", idempotencyKey: "firestore-history-fenced-queue-0001", input: { rows: ["must-not-enter"] } }, 503);
  await stop(); await start(await openApplicationRepository(config));
  assert.equal((await repository.snapshot()).workflows.collection_edit.draftVersion, 5); assert(!calls.includes("must-not-enter"));
  log("actual post-COMMIT edit acknowledgement loss reported an unconfirmed outcome, fenced the old cache and reconciled one saved draft; repeated stale undo did not create another revision or execute anything");

  const canvasOriginal = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  const beforeCanvasVersions = (await repository.snapshot()).versions.collection_edit;
  // Deliberately move the collection after its dependent return: source and
  // bindings are preserved, but current compilation must block execution.
  const canvasMoved = (await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: canvasOriginal.version, baseHash: canvasOriginal.contentHash,
    command: { type: "moveNode", nodeId: "each", beforeNodeId: null } }, 200)).data;
  assert.equal(canvasMoved.version, 6); assert.equal(canvasMoved.canRun, false); assert.equal(canvasMoved.validation.passed, false);
  const movedSource = parseWorkflowYAMLStrict(canvasMoved.yaml), originalCanvasSource = parseWorkflowYAMLStrict(canvasOriginal.yaml);
  assert.deepEqual(movedSource.steps, originalCanvasSource.steps);
  assert.deepEqual(movedSource.metadata.controlFlow.root.nodes, [originalCanvasSource.metadata.controlFlow.root.nodes[1], originalCanvasSource.metadata.controlFlow.root.nodes[0]]);
  assert.deepEqual((await repository.snapshot()).versions.collection_edit.slice(0, beforeCanvasVersions.length), beforeCanvasVersions);
  await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: canvasMoved.version, baseHash: canvasMoved.contentHash,
    command: { type: "moveNode", nodeId: "each", beforeNodeId: "lookup", destination: { loopId: "each", scope: "body" } } }, 422);
  await stop(); await start(await openApplicationRepository(config));
  const reopenedCanvas = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.equal(reopenedCanvas.yaml, canvasMoved.yaml); assert.equal(reopenedCanvas.can_attempt_run, false); assert.equal(reopenedCanvas.validation.passed, false);
  const canvasUndo = (await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: reopenedCanvas.version, baseHash: reopenedCanvas.contentHash,
    command: { type: "undoDraft", versionId: reopenedCanvas.editHistory.undoTarget } }, 200)).data;
  assert.equal(canvasUndo.version, 7); assert.equal(canvasUndo.yaml, canvasOriginal.yaml);
  assert.equal(calls.length, callsBeforeNode); assert.equal(models.length, modelsBeforeOwner + 1); assert.equal(canvasUndo.publishedVersion, 0);
  log("normal Firestore whole-collection canvas move retained body/configuration and broken references as a blocked saved draft; restart and explicit undo preserved exact original content without publication, SDK or model calls");

  // Server-only synthetic checkpoint producer, NOT a real effect executor.
  // Decision/review/configuration requests use the ordinary authenticated API.
  const callsBeforeApproval = calls.length, modelsBeforeApproval = models.length;
  const approvalRunId = `approval_${randomUUID()}`, approvalAttemptId = `attempt_${randomUUID()}`;
  await repository.mutate(state => {
    state.roles.approval_fixture = { id: "approval_fixture", name: "Fixture approver", description: "Review only", permissions: ["execution:approve"], createdAt: new Date().toISOString() };
    state.users.reviewer = { ...state.users.owner, id: "reviewer", name: "reviewer", email: "reviewer@example.test", roleId: "approval_fixture" };
    const original = structuredClone(state.executions[read.data.id]);
    state.executions[approvalRunId] = { ...original, id: approvalRunId, status: "RUNNING", completedAt: null, failure: undefined, stepOutputs: {}, finalOutput: undefined,
      agentSummary: undefined, workflowSnapshot: { ...original.workflowSnapshot, input: { id: "approval-fixture" } }, readProgress: newReadProgress(repository) };
    state.executions[approvalRunId].readProgress.attempts.lookup = { id: approvalAttemptId, nodeId: "lookup", stepIndex: 0, status: "PREPARING", startedAt: new Date().toISOString() };
  });
  await request("PATCH", "/api/settings/rbac", { enabled: false, runtimeApprovalPolicy: { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true,
    approverRoleIds: ["approval_fixture"], ttlSeconds: 300, separationOfDuties: true } }, 200);
  const approvalBinding = await repository.readAuthoritative(state => {
    const compilation = state.executions[approvalRunId].workflowSnapshot.compilation, node = state.versions.single.findLast(item => item.artifactState === "PUBLISHED").compiledRead.plan.ir.root.nodes[0];
    const pin = node.capability.admission, revision = state.capabilityRevisions[pin.revisionId];
    return { executionId: approvalRunId, workflowId: "single", nodeId: "lookup", invocationId: approvalAttemptId, operationKey: `operation_${randomUUID()}`,
      sourceHash: compilation.sourceHash, semanticHash: compilation.semanticHash, connectionId: pin.connectionId, connectionBinding: revision.connectionBinding, capabilityId: pin.capabilityId,
      capabilityRevision: pin.revisionId, admissionVersion: pin.admissionVersion, contractHash: pin.contractHash, argumentHash: resolvedParameterHashBytes(canonicalJSONBytes({ id: "approval-fixture" })),
      requesterId: "owner", requesterRoleId: "role_admin", workerEpoch: 1, policyHash: runtimeApprovalPolicyHash(state) };
  });
  await requestRuntimeApproval(repository, approvalRunId, approvalBinding, { id: "approval-fixture" }, "Review exact synthetic read checkpoint; no effect executor");
  const approvalView = (await request("GET", `/api/executions/${approvalRunId}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.deepEqual(approvalView.arguments, { id: "approval-fixture" }); assert.equal(approvalView.canDecide, true); assert.equal(approvalView.canResume, false);
  assert.equal(approvalView.toolName, tool.name); assert.equal(approvalView.remoteToolName, exactBridgeName(tool));
  await request("GET", `/api/executions/${approvalRunId}`, undefined, 404, "reviewer"); await request("GET", `/api/executions/${approvalRunId}/logs`, undefined, 403, "reviewer");
  const approvalCommand = { approvalId: approvalView.id, baseVersion: approvalView.version, reviewHash: approvalView.reviewHash, decisionKey: "firestore-exact-approval-fixture-0001", note: "Synthetic independent review" };
  await request("POST", `/api/executions/${approvalRunId}/approve`, approvalCommand, 403, "owner");
  const approvalTransaction = persistence.records.db.runTransaction.bind(persistence.records.db); let loseApprovalACK = true;
  persistence.records.db.runTransaction = async (callback, options) => { const result = await approvalTransaction(callback, options); if (loseApprovalACK) { loseApprovalACK = false; throw new Error("Synthetic approval post-COMMIT ACK lost"); } return result; };
  try { await request("POST", `/api/executions/${approvalRunId}/approve`, approvalCommand, 503, "reviewer"); } finally { persistence.records.db.runTransaction = approvalTransaction; }
  const fencedReview = await app.inject({ method: "GET", url: `/api/executions/${approvalRunId}?view=approval`, headers: headers("reviewer") }); assert(fencedReview.statusCode >= 400);
  await repository.recoverPersistenceState();
  const approvedReview = (await request("GET", `/api/executions/${approvalRunId}?view=approval`, undefined, 200, "reviewer")).data;
  assert.equal(approvedReview.status, "BLOCKED"); assert.equal(approvedReview.runtimeApproval.state, "APPROVED"); assert.equal(approvedReview.runtimeApproval.canDecide, false);
  const approvalEvents = (await repository.snapshot()).executionEvents[approvalRunId].length;
  assert.equal((await request("POST", `/api/executions/${approvalRunId}/approve`, approvalCommand, 200, "reviewer")).data.replayed, true);
  assert.equal((await repository.snapshot()).executionEvents[approvalRunId].length, approvalEvents);
  await stop(); await start(await openApplicationRepository(config));
  assert.equal((await request("GET", `/api/executions/${approvalRunId}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval.state, "APPROVED");
  await repository.mutateExecution(approvalRunId, state => consumeRuntimeApproval(state, approvalRunId, approvalBinding, { id: "approval-fixture" }, "fixture-dispatch-intent-not-an-outbox"));
  await assert.rejects(repository.mutateExecution(approvalRunId, state => consumeRuntimeApproval(state, approvalRunId, approvalBinding, { id: "approval-fixture" }, "second-intent")));
  assert.equal(calls.length, callsBeforeApproval); assert.equal(models.length, modelsBeforeApproval);
  log("actual Firestore exact approval review/decision POST-COMMIT ACK loss, authoritative reconciliation, original-key replay, fresh restart and once-only private consumption preserved immutable review; zero additional SDK/model calls and no effect resume");

  const entered = barrier(), release = barrier(); sdkHook = async args => { if (args.id === "cancel-a") { entered.release(); await release.promise; } };
  const cancelRun = (await request("POST", "/api/workflows/collection/run", { mode: "async-read", idempotencyKey: "firestore-runtime-cancel-fixture-0001", input: { rows: ["cancel-a", "must-not-call"] } }, 202)).data.id;
  await boundedOperation(() => entered.promise, { timeoutMs: 20_000, label: "Synthetic cancellation SDK entry" }); await request("POST", `/api/executions/${cancelRun}/cancel`, {}, 202); release.release(); sdkHook = undefined;
  const cancelled = await waitFor(async () => { const current = await repository.snapshot(); return current.readJobs[cancelRun]?.state === "FINISHED" && current.executions[cancelRun]; }, "cancelled collection");
  assert.equal(cancelled.status, "CANCELLED"); assert(!calls.includes("must-not-call"));
  assert.equal(cancelled.stepOutputs["each/0/lookup"].structuredContent.id, "CANCEL-A"); log("normal cancellation retained the already-confirmed item answer and never started the next collection item");

  // Actual normal result checkpoint: inject pre/post-COMMIT ACK loss only on the
  // next metadata activation, not on unrelated read-only/lease operations.
  for (const phase of ["before", "after"]) {
    const actualTransaction = persistence.records.db.runTransaction.bind(persistence.records.db); let loseNextResult = false, lostResult = false, unavailableSignals = 0;
    const beforeIds = new Set(Object.keys((await repository.snapshot()).executions));
    const unobserve = repository.observeCommits({ committed: () => {}, unavailable: () => { unavailableSignals++; assert.throws(() => repository.assertAuthority()); } });
    persistence.records.db.runTransaction = async (callback, options) => {
      let activated = false;
      const result = await actualTransaction(async transaction => {
        const set = transaction.set; transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath && loseNextResult) activated = true; return set.call(this, ref, ...args); };
        try {
          const value = await callback(transaction);
          if (activated && loseNextResult && phase === "before") { loseNextResult = false; lostResult = true; throw new Error("Synthetic pre-COMMIT result acknowledgement lost"); }
          return value;
        } finally { transaction.set = set; }
      }, options);
      if (activated && loseNextResult && phase === "after") { loseNextResult = false; lostResult = true; throw new Error("Synthetic post-COMMIT result acknowledgement lost"); }
      return result;
    };
    const requested = `lost-result-${phase}`; sdkHook = async args => { if (args.id === requested) loseNextResult = true; };
    const uncertain = await app.inject({ method: "POST", url: "/api/workflows/collection/run", headers: headers(), payload: { input: { rows: [requested, "no-replay"] } } });
    assert(lostResult); assert(unavailableSignals >= 1); assert(!calls.includes("no-replay")); assert.equal(uncertain.statusCode, 503);
    persistence.records.db.runTransaction = actualTransaction; sdkHook = undefined; unobserve();
    // The normal runner already performs authoritative reload/reconciliation;
    // it can restore healthy storage, never the stopped controller's execution.
    await repository.recoverPersistenceState();
    const current = await repository.snapshot(), recoverable = Object.values(current.executions).find(run => !beforeIds.has(run.id));
    assert(recoverable); assert.equal(recoverable.status, "RECOVERY_REQUIRED"); assert.equal(calls.filter(id => id === requested).length, 1);
    if (phase === "after") assert.equal(recoverable.stepOutputs["each/0/lookup"].structuredContent.id, requested.toUpperCase());
    else { assert.equal(recoverable.stepOutputs?.["each/0/lookup"], undefined); assert.equal(recoverable.readProgress.attempts["each/0/lookup"].status, "UNKNOWN"); }
    await stop(); await start(await openApplicationRepository(config));
    assert.deepEqual((await repository.snapshot()).executions[recoverable.id], recoverable); assert(!calls.includes("no-replay"));
  }
  log("actual normal collection pre/post-COMMIT result lost ACKs fenced the old cache; authoritative reconciliation/restart preserved confirmed versus UNKNOWN outcomes without replay or next-item dispatch");

  // Actual writer renewal ACK loss, followed by direct broker, model and HTTP
  // attempts. No stale worker/process cache may authorize another request.
  const heldEntry = barrier(), heldRelease = barrier(); sdkHook = async args => { if (args.id === "held-owner") { heldEntry.release(); await heldRelease.promise; } };
  const heldId = (await request("POST", "/api/workflows/collection/run", { mode: "async-read", idempotencyKey: "firestore-runtime-held-owner-0001", input: { rows: ["held-owner", "no-stale-next"] } }, 202)).data.id;
  await boundedOperation(() => heldEntry.promise, { timeoutMs: 20_000, label: "Synthetic owned worker SDK entry" });
  const heldModelEntry = barrier(), heldModelRelease = barrier(); let heldModelSignal;
  modelHook = async (_request, signal) => { heldModelSignal = signal; heldModelEntry.release(); await heldModelRelease.promise; };
  const heldChat = (await request("POST", `/api/chat/sessions/${chatId}/messages`, { ...chatPayload, content: "Show pending invoice details", idempotencyKey: "firestore-runtime-held-chat-0001" }, 202)).data.operation.id;
  await boundedOperation(() => heldModelEntry.promise, { timeoutMs: 20_000, label: "Synthetic owned chat model entry" });
  const nextSession = (await request("POST", "/api/chat/sessions", {}, 201)).data.id;
  const nextChat = (await request("POST", `/api/chat/sessions/${nextSession}/messages`, { ...chatPayload, content: "Do not start the next queued chat", idempotencyKey: "firestore-runtime-next-chat-0001" }, 202)).data.operation.id;
  const beforeLoss = await repository.snapshot(); assert.equal(beforeLoss.chatOperations[heldChat].status, "RUNNING"); assert.equal(beforeLoss.chatOperations[nextChat].status, "QUEUED");
  let unavailableSignals = 0; repository.observeCommits({ committed: () => {}, unavailable: () => { unavailableSignals++; } });
  const actual = persistence.records.db.runTransaction.bind(persistence.records.db);
  persistence.records.db.runTransaction = async (callback, options) => { await actual(callback, options); throw new Error("Synthetic post-COMMIT writer renewal ACK lost"); };
  await assert.rejects(persistence.renewOwnership()); persistence.records.db.runTransaction = actual;
  const callsBeforeFence = calls.length, modelsBeforeFence = models.length; assert.equal(unavailableSignals, 1);
  assert(heldModelSignal?.aborted, "The pending chat model wait must abort immediately on storage denial");
  heldRelease.release(); heldModelRelease.release(); sdkHook = modelHook = undefined;
  await assert.rejects(dispatchReadTool(services, "owner", "read", { id: "fenced" }));
  await assert.rejects(session.callToolDirect("read", { id: "fenced" })); await assert.rejects(services.providerRuntime.queryWithTools([{ role: "user", content: "fenced" }], [], { temperature: 0 }));
  const denied = await app.inject({ method: "POST", url: "/api/workflows/single/run", headers: headers(), payload: { input: { id: "fenced" } } }); assert(denied.statusCode >= 400);
  assert.equal(calls.length, callsBeforeFence); assert.equal(models.length, modelsBeforeFence); await assert.rejects(persistence.load());
  await app.close(); app = undefined;
  const observer = FirestoreRecordStore.create(key, namespace);
  try {
    const remote = assembleFirestoreState(observer.readRecords(await observer.load()));
    assert.equal(remote.executions[heldId].readProgress.attempts["each/0/lookup"].status, "DISPATCH_INTENT"); assert.equal(remote.executions[heldId].stepOutputs?.["each/0/lookup"], undefined);
    assert.deepEqual(remote.chatOperations[heldChat], beforeLoss.chatOperations[heldChat]); assert.deepEqual(remote.chatOperations[nextChat], beforeLoss.chatOperations[nextChat]);
    assert.deepEqual(remote.chats, beforeLoss.chats); assert.equal(calls.length, callsBeforeFence); assert.equal(models.length, modelsBeforeFence);
    assert(!calls.includes("no-stale-next"));
  } finally { await observer.close(); }
  log("actual writer-renewal lost ACK synchronously denied repository observers, pending read/chat waits, broker MCP, provider fetch and normal HTTP execution; late SDK/model answers were not saved and no next item or queued chat started");
  console.log("Firestore runtime qualification complete. Synthetic actual database + in-process HTTP/MCP/model fixtures only; no cloud project, live ERP/model/email, migration, browser/load or production latency certification.");
} finally { for (const gate of ownedBarriers) gate.release(); sdkHook = modelHook = undefined; await stop(); }
