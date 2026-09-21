import assert from "node:assert/strict";
import { stringify } from "yaml";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { parseReadControlFlow, protectedNodes } from "../src/workflows/read-control-flow.js";

// Real emulator persistence/normal authenticated API qualification only.
// No model fixture, handler execution, effect or production grant is created.
export async function verifyFirestoreProtectedDrafts({ request, repository: getRepository, restart, calls, models, log }) {
  const workflowId = "protected_draft_edit", endpoint = `/api/workflows/${workflowId}`;
  const source = stringify({ name: "Protected saved draft", description: "Grouped employee/document fixture reads", trigger: { type: "manual" },
    steps: ["employee", "documents", "after"].map(id => ({ id, action: "read", parameters: { id } })), metadata: { ownerNotes: "preserve exact definitions" } });
  await getRepository().mutate(state => {
    state.workflows[workflowId] = { ...structuredClone(state.workflows.collection_edit), id: workflowId, name: "Protected saved draft", yaml: source,
      draftVersion: 1, publishedVersion: 0, canRun: false, steps: 3 };
    state.versions[workflowId] = [];
  });
  const initial = await getRepository().snapshot(), callsBefore = calls.length, modelsBefore = models.length;
  const output = { schema: { type: "string" }, success: { kind: "ref", source: "nodeOutput", nodeId: "documents", path: ["structuredContent", "id"] },
    handled: { kind: "ref", source: "nodeOutput", nodeId: "group", path: ["error", "code"] } };
  const command = { type: "wrapProtected", nodeIds: ["employee", "documents"], protectedId: "group", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output };
  let ready = (await request("POST", `${endpoint}/commands`, { baseVersion: 1, baseHash: workflowContentHash(source), command }, 200)).data;
  assert.equal(ready.version, 2); assert.equal(ready.canRun, false);
  assert.deepEqual(parseWorkflowYAMLStrict(ready.yaml).steps, parseWorkflowYAMLStrict(source).steps);
  assert.equal(parseReadControlFlow(parseWorkflowYAMLStrict(ready.yaml).metadata.controlFlow).schemaVersion, "read-control-flow/v4");
  const scope = yaml => protectedNodes(parseReadControlFlow(parseWorkflowYAMLStrict(yaml).metadata.controlFlow).root)[0];
  assert.deepEqual(scope(ready.yaml).body.nodes, [{ kind: "action", nodeId: "employee" }, { kind: "action", nodeId: "documents" }]);
  await request("POST", `${endpoint}/commands`, { baseVersion: 1, baseHash: workflowContentHash(source), command }, 409);
  ready = (await request("POST", `${endpoint}/commands`, { baseVersion: ready.version, baseHash: ready.contentHash, command: {
    type: "addNode", node: { id: "fallback", action: "read", parameters: { id: "{{group.error.code}}" } }, beforeNodeId: null,
    destination: { protectedId: "group", scope: "handler" } } }, 200)).data;
  const exact = ready.yaml, historical = structuredClone((await getRepository().snapshot()).versions[workflowId]);
  await restart();
  ready = (await request("GET", `${endpoint}/readiness`, undefined, 200)).data;
  assert.equal(ready.yaml, exact); assert.equal(ready.can_attempt_run, false); assert.equal(ready.canRun, false); assert.equal(ready.publishedVersion, 0);
  assert.equal(ready.authoring.executionProfile, "protected-draft-runtime-pending");
  assert.deepEqual(scope(ready.yaml).handler.nodes, [{ kind: "action", nodeId: "fallback" }]);
  await request("POST", `${endpoint}/publish`, { baseVersion: ready.version, baseHash: ready.contentHash }, 422);
  await request("POST", `${endpoint}/run`, { mode: "async-operation", input: {}, idempotencyKey: "protected-draft-must-not-run-0001" }, 409);
  const undo = (await request("POST", `${endpoint}/commands`, { baseVersion: ready.version, baseHash: ready.contentHash, command: { type: "undoDraft", versionId: ready.editHistory.undoTarget } }, 200)).data;
  assert.deepEqual(scope(undo.yaml).handler.nodes, []);
  await restart();
  ready = (await request("GET", `${endpoint}/readiness`, undefined, 200)).data;
  ready = (await request("POST", `${endpoint}/commands`, { baseVersion: ready.version, baseHash: ready.contentHash, command: { type: "redoDraft", versionId: ready.editHistory.redoTarget } }, 200)).data;
  assert.equal(ready.yaml, exact); assert.deepEqual((await getRepository().snapshot()).versions[workflowId].slice(0, historical.length), historical);

  const update = { baseVersion: ready.version, baseHash: ready.contentHash, command: { type: "updateProtected", nodeId: "group",
    patch: { output: { ...output, success: { kind: "literal", value: "explicit reviewed draft value" } } } } };
  const persistence = getRepository().persistence, original = persistence.records.db.runTransaction.bind(persistence.records.db);
  let lost = false;
  persistence.records.db.runTransaction = async (callback, options) => {
    let committedHead = false;
    const result = await original(async transaction => {
      const set = transaction.set;
      transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath) committedHead = true; return set.call(this, ref, ...args); };
      try { return await callback(transaction); } finally { transaction.set = set; }
    }, options);
    if (committedHead && !lost) { lost = true; throw new Error("Synthetic protected draft post-COMMIT ACK loss"); }
    return result;
  };
  try {
    const uncertain = await request("POST", `${endpoint}/commands`, update, 503);
    assert(lost); assert.equal(uncertain.meta.code, "DRAFT_SAVE_UNCONFIRMED"); assert(!uncertain.message.includes("nothing was changed"));
  } finally { persistence.records.db.runTransaction = original; }
  await getRepository().recoverPersistenceState(); await restart();
  const reconciled = (await request("GET", `${endpoint}/readiness`, undefined, 200)).data;
  assert.equal(reconciled.version, update.baseVersion + 1); assert.equal(reconciled.can_attempt_run, false);
  assert.deepEqual(scope(reconciled.yaml).output.success, update.command.patch.output.success);
  assert.deepEqual(scope(reconciled.yaml).body, scope(exact).body); assert.deepEqual(scope(reconciled.yaml).handler, scope(exact).handler);
  assert.equal((await getRepository().snapshot()).versions[workflowId].filter(value => value.version === reconciled.version).length, 1);
  await request("POST", `${endpoint}/commands`, update, 409);
  assert.deepEqual((await getRepository().snapshot()).executions, initial.executions);
  assert.equal((await getRepository().snapshot()).schedules[`schedule-${workflowId}`], undefined);
  assert.equal(calls.length, callsBefore); assert.equal(models.length, modelsBefore);
  log("actual Firestore protected body/handler wrap, saved edit, restart, undo/redo and post-COMMIT save ACK loss preserved exact ownership and immutable versions; stale replay, publication and run were denied with zero model/SDK/effect calls");
}
