import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { ProtectedMachine } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { ProtectedContinuationCodec } from "../src/runner/protected-continuation.js";
import { assertProtectedInvocationLedger, protectedJournalHash as hash } from "../src/repository/protected-invocation-records.js";
import { protectedInvocationFixture, protectedInvocationFixtureFailure } from "../tests/fixtures/protected-invocation.js";
import { fixtureOutput as output } from "../tests/fixtures/protected-simulation.js";

// Actual normalized database DATA qualification, never normal publication,
// worker/SDK/model/approval/fault/delivery authority. All results are supplied.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback demo emulator and no credential file are required");
const namespace = { projectId, databaseId: "(default)", workspaceId: `test_${randomUUID().replaceAll("-", "")}_protected_invocations` };
const key = randomBytes(32).toString("base64"), codec = new ProtectedContinuationCodec(randomBytes(32).toString("base64"));
let repository, adapter, checkpoints = 0, suppliedResults = 0;
async function open() { adapter = await FirestoreRecordPersistence.open(key, namespace); repository = await Repository.open(adapter); }
async function close() { try { await repository?.close(); } finally { repository = undefined; await adapter?.close(); adapter = undefined; } }
const cursorIdentity = f => codec.identity({ executionId: f.identity.executionId, workflowId: f.identity.workflowId, epoch: 1,
  actorId: f.identity.actorId, roleId: f.identity.roleId, admittedRole: f.identity.admittedRole, sourceHash: f.plan.sourceHash, semanticHash: f.plan.semanticHash }, f.input);
function evidence(ledger, id) {
  assertProtectedInvocationLedger(ledger, id);
  // Hash the COMPLETE validated records, not an unverified claimed head/count.
  return { profile: "protected-invocation-complete-data/v1", journalHash: hash(ledger), head: ledger.head, nextSequence: ledger.nextSequence, intentCount: ledger.intentCount };
}
function assign(state, f, machine, ledger, status = "FIXTURE_CHECKPOINT") {
  const identity = cursorIdentity(f), id = f.identity.executionId;
  state.executions[id].protectedInvocationSecret = ledger; state.executions[id].status = status;
  state.protectedContinuations[id] = codec.encode(identity, codec.evidenceBinding(identity, evidence(ledger, id)), machine.snapshot());
}
async function restore(f) {
  const state = await repository.readAuthoritative(value => structuredClone(value)), id = f.identity.executionId;
  const ledger = state.executions[id].protectedInvocationSecret, identity = cursorIdentity(f);
  const snapshot = codec.decode(state.protectedContinuations[id], identity, codec.evidenceBinding(identity, evidence(ledger, id)));
  const machine = new ProtectedMachine(f.plan, {}, snapshot);
  return { machine, ledger: new ProtectedInvocationLedger(f.identity, f.plan, machine, ledger) };
}
async function save(f, machine, ledger, status) {
  await repository.mutateExecution(f.identity.executionId, state => assign(state, f, machine, ledger.snapshot ? ledger.snapshot() : ledger, status)); checkpoints++;
  const expected = await repository.snapshot(), revision = (await adapter.records.load()).revision;
  await close(); await open(); assert.deepEqual(await repository.snapshot(), expected); assert.equal((await adapter.records.load()).revision, revision);
  return restore(f);
}
async function seed(f) {
  await repository.mutateExecution(f.identity.executionId, state => {
    state.executions[f.identity.executionId] = { id: f.identity.executionId, workflowId: f.identity.workflowId, workflowName: "Supplied fixture journal only",
      status: "FIXTURE_CHECKPOINT", startedAt: "synthetic", completedAt: null, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0,
      startedBy: { id: f.identity.actorId, name: "Fixture" } };
    assign(state, f, f.machine, f.ledger.snapshot());
  }); return restore(f);
}
const typed = point => ["merge", "return", "collection-item"].includes(point.kind) || point.kind === "collection-complete" && point.outcome === "SUCCEEDED" ||
  point.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(point.outcome);
async function toAction(f, active) {
  while (active.machine.peek()?.kind !== "action") {
    const point = active.machine.peek(), next = active.ledger.advance(active.machine, { kind: "accept", ...(typed(point) ? { output: { value: point.value } } : {}) });
    active = await save(f, next.machine, next.ledger);
  } return active;
}
try {
  await open(); await repository.mutate(state => { state.settings.fixtureKeep = { answer: false }; });
  const f = protectedInvocationFixture(), actions = []; let active = await seed(f);
  for (let count = 0; count < 200; count++) {
    const point = active.machine.peek(); if (!point) break; assert.equal(point.valid, true); let result = { kind: "accept" };
    if (point.kind === "action") {
      actions.push(point.invocationId); const logicalKey = active.ledger.prepare(active.machine, "read", { kind: "node" }, point.arguments, 1);
      active = await save(f, active.machine, active.ledger);
      active.ledger.dispatchIntent(active.machine, logicalKey, point.arguments, 1);
      active = await save(f, active.machine, active.ledger); suppliedResults++;
      if (point.invocationId === "each/0/lookup") {
        const fault = { code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: point.nodeId, failedInvocationId: point.invocationId }, proof = protectedInvocationFixtureFailure();
        active.ledger.acknowledgeReadError(active.machine, logicalKey, fault, proof, 1);
        result = { kind: "business-read-failure", fault, intentKey: logicalKey, businessFailureHash: hash(proof) };
      } else {
        const value = output(point.invocationId === "each/0/fallback" ? "First supplied handled answer" : "Second supplied body answer");
        active.ledger.acknowledgeOutput(active.machine, logicalKey, value, 1); result.output = value;
      }
    } else if (typed(point)) result.output = { value: point.value };
    const before = active.machine.snapshot(), next = active.ledger.advance(active.machine, result); assert.deepEqual(active.machine.snapshot(), before);
    active = await save(f, next.machine, next.ledger);
  }
  assert.equal(active.machine.snapshot().status, "DONE"); assert.deepEqual(active.machine.snapshot().result, { value: ["First supplied handled answer", "Second supplied body answer"] });
  assert.deepEqual(actions, ["each/0/lookup", "each/0/fallback", "each/1/lookup", "each/1/body_next"]);
  const records = adapter.records.readRecords(await adapter.records.load());
  const meta = records.find(row => row.path[0] === "executions" && row.path[1] === "run").value;
  assert.deepEqual(meta.protectedInvocationSecret.intents, {}); assert.deepEqual(meta.protectedInvocationSecret.receipts, {});
  assert.equal(records.filter(row => row.path[0] === "protected-invocation-intents").length, 4);
  assert.equal(records.filter(row => row.path[0] === "protected-invocation-receipts").length, active.machine.snapshot().sequence);
  console.log(`PASS: actual normalized invocation journal ${checkpoints} acknowledged stage/boundary saves and immediate writer reopens; four distinct intents, mixed-item supplied outputs and full pure history validation`);

  for (const phase of ["before", "after"]) {
    const target = protectedInvocationFixture(["A"], `ack-${phase}`); let pending = await toAction(target, await seed(target));
    const point = pending.machine.peek(), logicalKey = pending.ledger.prepare(pending.machine, "read", { kind: "node" }, point.arguments, 1);
    pending = await save(target, pending.machine, pending.ledger); pending.ledger.dispatchIntent(pending.machine, logicalKey, point.arguments, 1);
    pending = await save(target, pending.machine, pending.ledger);
    const originalMachine = pending.machine.snapshot(), originalLedger = pending.ledger.snapshot(), baseline = await repository.snapshot();
    const candidate = new ProtectedInvocationLedger(target.identity, target.plan, pending.machine, originalLedger), value = output("Supplied result before uncertain save");
    candidate.acknowledgeOutput(pending.machine, logicalKey, value, 1); suppliedResults++;
    const next = candidate.advance(pending.machine, { kind: "accept", output: value });
    const actualSave = adapter.saveExecutionCheckpoint.bind(adapter);
    adapter.saveExecutionCheckpoint = async checkpoint => { if (phase === "after") await actualSave(checkpoint); throw new Error(`Synthetic ${phase}-COMMIT ACK loss`); };
    await assert.rejects(repository.mutateExecution(target.identity.executionId, state => assign(state, target, next.machine, next.ledger, "FIXTURE_UNCONFIRMED_RESULT")));
    assert.deepEqual(pending.machine.snapshot(), originalMachine); assert.deepEqual(pending.ledger.snapshot(), originalLedger);
    assert.deepEqual(await repository.snapshot(), baseline); await assert.rejects(repository.readAuthoritative(() => true), /unavailable/);
    adapter.saveExecutionCheckpoint = actualSave; await repository.recoverPersistenceState(); const restored = await restore(target);
    assert.deepEqual(restored.machine.snapshot(), phase === "after" ? next.machine.snapshot() : originalMachine);
    assert.equal(restored.ledger.snapshot().intents[logicalKey].state, phase === "after" ? "ACKNOWLEDGED" : "DISPATCH_INTENT");
    const confirmed = await repository.snapshot(); await close(); await open(); assert.deepEqual(await repository.snapshot(), confirmed);
    if (phase === "before") {
      assert.throws(() => restored.ledger.prepare(restored.machine, "read", { kind: "node" }, point.arguments, 2));
      assert.throws(() => restored.ledger.advance(restored.machine, { kind: "accept", output: value }));
      restored.ledger.unknown(restored.machine, logicalKey, 1);
      const stopped = await save(target, restored.machine, restored.ledger, "FIXTURE_RECOVERY_REQUIRED");
      assert.equal(stopped.ledger.snapshot().state, "RECOVERY_REQUIRED");
      assert.throws(() => stopped.ledger.acknowledgeOutput(stopped.machine, logicalKey, output("Late"), 1));
    }
    console.log(`PASS: actual ${phase}-COMMIT result ACK loss atomically retained exact journal/cursor, fenced cached use and performed no dependent call or replay`);
  }
  const final = await repository.snapshot(); assert.deepEqual(final.settings.fixtureKeep, { answer: false });
  assert.equal(suppliedResults, 6);
  console.log("Invocation storage qualification complete: six supplied fixture outcomes, zero actual SDK/model/effect calls; not normal loop publication/worker, real fault or production acceptance");
} finally { await close(); }
