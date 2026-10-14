import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { Repository } from "../src/repository/store.js";
import { ProtectedContinuationCodec } from "../src/runner/protected-continuation.js";
import { ProtectedMachine, protectedMachinePlan } from "../src/workflows/protected-machine.js";
import { compileProtectedFixtureWorkflow } from "../src/workflows/compiled-read.js";
import { protectedSimulationSource, protectedSimulationRead, protectedSimulationRole,
  fixtureSequence as seq, fixtureRef as ref, fixtureOutput as output } from "../tests/fixtures/protected-simulation.js";

// Actual SDK storage proof ONLY. No HTTP worker, published flow, model, ERP,
// approval or genuine business-failure evidence is created by this campaign.
// Never reuse/delete a namespace, flush an emulator or fall back to cloud ADC.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback demo Firestore emulator and no credential file are required");
const namespace = { projectId, databaseId: "(default)", workspaceId: `test_${randomUUID().replaceAll("-", "")}_protected_continuation` };
const key = randomBytes(32).toString("base64"), codec = new ProtectedContinuationCodec(randomBytes(32).toString("base64"));
const source = protectedSimulationSource(), group = source.metadata.controlFlow.root.nodes[0];
source.steps.pop(); source.steps[0].parameters.id = "{{each.item}}";
source.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 3,
  items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
  body: seq(group), collect: { schema: { type: "string" }, value: ref("guard", "value") } },
  { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("each", "value") } });
source.trigger.config = { inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false } };
const compiled = compileProtectedFixtureWorkflow(stringify(source), [protectedSimulationRead], protectedSimulationRole);
const plan = protectedMachinePlan(compiled.sourceHash, compiled.flow, compiled.nodes.map(node => ({ id: node.id, input: node.kind === "action" ? node.inputs : node.input })), compiled.inputSchema);
const input = { items: ["synthetic-private-A", "synthetic-private-B"] }, executionId = "fixture-run";
const context = { executionId, workflowId: "fixture-flow", epoch: 1, actorId: "fixture-actor", roleId: "role_admin", admittedRole: "Platform Admin",
  sourceHash: plan.sourceHash, semanticHash: plan.semanticHash }, identity = codec.identity(context, input);
let repository, adapter, checkpoints = 0, restores = 0;
async function open() { adapter = await FirestoreRecordPersistence.open(key, namespace); repository = await Repository.open(adapter); }
async function close() { try { await repository?.close(); } finally { repository = undefined; await adapter?.close(); adapter = undefined; } }
function evidence(state) { return { profile: "synthetic-protected-storage-evidence/v1", events: state.executionEvents[executionId] }; }
async function savedMachine() {
  const state = await repository.readAuthoritative(value => structuredClone(value));
  const snapshot = codec.decode(state.protectedContinuations[executionId], identity, codec.evidenceBinding(identity, evidence(state)));
  return new ProtectedMachine(plan, {}, snapshot);
}
const typed = point => ["merge", "return", "collection-item"].includes(point.kind) ||
  point.kind === "collection-complete" && point.outcome === "SUCCEEDED" || point.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(point.outcome);
async function checkpoint(machine, previous) {
  const point = machine.peek(), snapshot = machine.snapshot();
  await repository.mutateExecution(executionId, state => {
    if (previous) state.executionEvents[executionId].push({ version: 1, executionId, workflowId: context.workflowId,
      sequence: state.executionEvents[executionId].length + 1, timestamp: "synthetic-fixture", type: "fixture-machine-ack", payload: {
        fixtureOnly: true, nodeId: previous.nodeId, invocationId: previous.invocationId, kind: previous.kind, machineSequence: previous.sequence,
      } });
    state.protectedContinuations[executionId] = codec.encode(identity, codec.evidenceBinding(identity, evidence(state)), snapshot);
    state.executions[executionId].status = point ? "FIXTURE_CHECKPOINT" : "FIXTURE_COMPLETE";
  }); checkpoints++;
  const expected = await repository.snapshot(), revision = (await adapter.records.load()).revision;
  await close(); await open(); restores++;
  assert.deepEqual(await repository.snapshot(), expected); assert.equal((await adapter.records.load()).revision, revision);
  const restored = await savedMachine(); assert.deepEqual(restored.snapshot(), snapshot); assert.deepEqual(restored.peek(), point);
  return restored;
}
try {
  await open();
  await repository.mutate(state => {
    state.executions[executionId] = { id: executionId, workflowId: context.workflowId, workflowName: "Synthetic storage only", status: "FIXTURE_CHECKPOINT",
      startedAt: "synthetic-fixture", completedAt: null, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0,
      startedBy: { id: context.actorId, name: "Fixture" } };
    state.executionEvents[executionId] = []; state.settings.fixtureUnrelated = { answer: false };
  });
  let machine = await checkpoint(new ProtectedMachine(plan, input));
  const actions = [];
  for (let count = 0; count < 200; count++) {
    const point = machine.peek(); if (!point) break; assert.equal(point.valid, true);
    if (point.kind === "action") {
      actions.push(point.invocationId);
      if (point.invocationId === "each/0/lookup") machine.fail({ code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: point.nodeId, failedInvocationId: point.invocationId });
      else machine.accept(output(point.invocationId === "each/0/fallback" ? "First supplied handler answer" : "Second supplied body answer"));
    } else machine.accept(typed(point) ? { value: point.value } : undefined);
    machine = await checkpoint(machine, point);
  }
  assert.equal(machine.snapshot().status, "DONE"); assert.deepEqual(machine.snapshot().result, { value: ["First supplied handler answer", "Second supplied body answer"] });
  assert.deepEqual(actions, ["each/0/lookup", "each/0/fallback", "each/1/lookup", "each/1/body_next"]);
  console.log(`PASS: actual normalized Firestore ${checkpoints} acknowledged machine checkpoints and ${restores} immediate writer reopen/restores, distinct mixed-item fixture answers`);

  for (const phase of ["before", "after"]) {
    const baseline = await repository.snapshot(), revision = (await adapter.records.load()).revision;
    const saved = adapter.saveExecutionCheckpoint.bind(adapter);
    adapter.saveExecutionCheckpoint = async value => { if (phase === "after") await saved(value); throw new Error(`Synthetic ${phase}-COMMIT acknowledgement loss`); };
    await assert.rejects(repository.mutateExecution(executionId, state => {
      state.executions[executionId].status = `FIXTURE_${phase.toUpperCase()}_ACK`;
      // Same authentic private record retained in the atomic checkpoint.
    }));
    await assert.rejects(repository.readAuthoritative(() => true), /unavailable/);
    await assert.rejects(repository.mutateExecution(executionId, () => {}), /fenced/);
    adapter.saveExecutionCheckpoint = saved; await repository.recoverPersistenceState();
    const confirmed = await repository.snapshot();
    assert.equal((await adapter.records.load()).revision, revision + Number(phase === "after"));
    assert.equal(confirmed.executions[executionId].status, phase === "after" ? "FIXTURE_AFTER_ACK" : baseline.executions[executionId].status);
    assert.deepEqual(confirmed.protectedContinuations[executionId], baseline.protectedContinuations[executionId]);
    assert.deepEqual((await savedMachine()).snapshot(), machine.snapshot());
    await close(); await open(); assert.deepEqual(await repository.snapshot(), confirmed);
    console.log(`PASS: actual adapter ${phase}-COMMIT scoped acknowledgement loss retained exact encrypted continuation and denied cached use; no calls/replay`);
  }
  const beforeRemoval = await repository.snapshot();
  await repository.mutateExecution(executionId, state => { delete state.protectedContinuations[executionId]; state.executions[executionId].status = "FIXTURE_ARCHIVED"; });
  await close(); await open(); const archived = await repository.snapshot();
  assert.deepEqual(archived.protectedContinuations, {}); assert.equal(archived.executions[executionId].status, "FIXTURE_ARCHIVED");
  assert.deepEqual(archived.settings, beforeRemoval.settings); assert.deepEqual(archived.executionEvents, beforeRemoval.executionEvents);
  console.log("PASS: terminal fixture cleanup atomically removed private continuation and preserved unrelated state/evidence through reopen");
  console.log("Storage-only qualification complete: no normal worker/public admission, real fault/model/ERP/effect/email, cloud or loop dispatch certification");
} finally { await close(); }
