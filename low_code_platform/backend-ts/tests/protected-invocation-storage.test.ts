import { expect, test } from "vitest";
import { Repository, initialState, restoreState, type Execution, type PersistenceBackend } from "../src/repository/store.js";
import { applyExecutionCheckpoint, type ExecutionCheckpoint } from "../src/repository/execution-transaction.js";
import { splitRuntimeState, assembleRuntimeState, checkpointRecords } from "../src/storage/execution-record-layout.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { ProtectedMachine, protectedMachinePlan } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { ProtectedContinuationCodec } from "../src/runner/protected-continuation.js";
import { protectedJournalHash as hash } from "../src/repository/protected-invocation-records.js";
import { withoutSecretFields } from "../src/redact/secrets.js";

const plan = protectedMachinePlan(`sha256:${"a".repeat(64)}`, { kind: "sequence", nodes: [{ kind: "action", nodeId: "read" }] },
  [{ id: "read", input: { kind: "ref", source: "workflowInput", path: [] } }]);
function fixture() {
  const input = { id: "synthetic-private" }, machine = new ProtectedMachine(plan, input); machine.peek();
  const identity = { executionId: "run", workflowId: "flow", actorId: "owner", roleId: "role_admin", admittedRole: "Platform Admin", sourceHash: plan.sourceHash,
    operationHash: `sha256:${"b".repeat(64)}`, machineHash: plan.semanticHash, inputHash: hash(input) };
  const ledger = new ProtectedInvocationLedger(identity, plan, machine), key = ledger.prepare(machine, "read", { kind: "node" }, input, 1);
  ledger.dispatchIntent(machine, key, input, 1); ledger.acknowledgeOutput(machine, key, { answer: "Readable" }, 1);
  const next = ledger.advance(machine, { kind: "accept", output: { answer: "Readable" } });
  const codec = new ProtectedContinuationCodec("synthetic-server-key-at-least-32-bytes"), cursorIdentity = codec.identity({ executionId: "run", workflowId: "flow", epoch: 1,
    actorId: "owner", roleId: "role_admin", admittedRole: "Platform Admin", sourceHash: plan.sourceHash, semanticHash: plan.semanticHash }, input);
  const continuation = codec.encode(cursorIdentity, codec.evidenceBinding(cursorIdentity, next.ledger), next.machine.snapshot());
  const execution: Execution = { id: "run", workflowId: "flow", workflowName: "Fixture", status: "FIXTURE_CHECKPOINT", startedAt: "now", completedAt: null,
    durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "owner", name: "Owner" }, protectedInvocationSecret: next.ledger };
  return { ...next, identity, plan, input, codec, cursorIdentity, continuation, execution, key };
}
class Records implements PersistenceBackend {
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  payload: Uint8Array | null = null; failure: "before" | "after" | null = null;
  async load() { return this.payload; }
  async save(payload: Uint8Array) { this.payload = Buffer.from(payload); }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint) {
    if (this.failure === "before") throw new Error("Synthetic pre-COMMIT loss");
    this.payload = Buffer.from(JSON.stringify(assembleFirestoreState(splitFirestoreState(applyExecutionCheckpoint(restoreState(this.payload!), checkpoint)))));
    if (this.failure === "after") throw new Error("Synthetic post-COMMIT ACK loss");
  }
  async probe() {} async close() {}
}

test("private intents/receipts normalize separately and reassemble exact cursor-bound data", () => {
  const f = fixture(), state = initialState(); state.executions.run = f.execution; state.protectedContinuations.run = f.continuation;
  for (const [split, assemble] of [[splitRuntimeState, assembleRuntimeState], [splitFirestoreState, assembleFirestoreState]] as const) {
    const records = split(state); expect(assemble(records)).toEqual(state);
    expect(records.find(row => row.path[0] === "executions")!.value).toMatchObject({ protectedInvocationSecret: { intents: {}, receipts: {} } });
    expect(records.filter(row => row.path[0] === "protected-invocation-intents")).toHaveLength(1);
    expect(records.filter(row => row.path[0] === "protected-invocation-receipts")).toHaveLength(1);
    const opened = assemble(records), ledger = opened.executions.run!.protectedInvocationSecret!;
    const snapshot = f.codec.decode(opened.protectedContinuations.run!, f.cursorIdentity, f.codec.evidenceBinding(f.cursorIdentity, ledger));
    expect(new ProtectedInvocationLedger(f.identity, plan, new ProtectedMachine(plan, {}, snapshot), ledger).snapshot()).toEqual(f.ledger);
  }
  const rows = checkpointRecords({ executionId: "run", execution: f.execution, protectedContinuation: f.continuation, auditStart: 0, auditAppend: [] });
  expect(rows.some(row => row.path[0] === "protected-invocation-intents")).toBe(true);
});
test.each(["missing-intent", "missing-receipt", "duplicate", "foreign-execution", "foreign-actor", "foreign-workflow", "hidden-embedded", "changed-head", "legacy-journal"])("damaged %s normalized records fail closed", damage => {
  const f = fixture(), state = initialState(); state.executions.run = f.execution;
  let records = structuredClone(splitRuntimeState(state)); const meta = records.find(row => row.path[0] === "executions")!.value as Execution;
  if (damage === "missing-intent") records = records.filter(row => row.path[0] !== "protected-invocation-intents");
  if (damage === "missing-receipt") records = records.filter(row => row.path[0] !== "protected-invocation-receipts");
  if (damage === "duplicate") records.push(records.find(row => row.path[0] === "protected-invocation-receipts")!);
  if (damage === "foreign-execution") meta.protectedInvocationSecret!.identity.executionId = "foreign";
  if (damage === "foreign-actor") meta.protectedInvocationSecret!.identity.actorId = "foreign";
  if (damage === "foreign-workflow") meta.protectedInvocationSecret!.identity.workflowId = "foreign";
  if (damage === "hidden-embedded") meta.protectedInvocationSecret!.intents = f.ledger.intents;
  if (damage === "changed-head") meta.protectedInvocationSecret!.head = `sha256:${"c".repeat(64)}`;
  if (damage === "legacy-journal") meta.operationSecret = {} as never;
  expect(() => assembleRuntimeState(records)).toThrow();
});
test.each(["before", "after"] as const)("%s-COMMIT result save never exposes a partially advanced ledger/cursor", async phase => {
  const f = fixture(), storage = new Records(), repository = await Repository.open(storage);
  await repository.mutate(state => { const { protectedInvocationSecret: _private, ...original } = f.execution; state.executions.run = original; });
  const original = await repository.snapshot(); storage.failure = phase;
  await expect(repository.mutateExecution("run", state => { state.executions.run!.protectedInvocationSecret = f.ledger; state.protectedContinuations.run = f.continuation; })).rejects.toThrow();
  expect(await repository.snapshot()).toEqual(original); await expect(repository.readAuthoritative(() => true)).rejects.toThrow(/unavailable/);
  storage.failure = null; await repository.recoverPersistenceState();
  const recovered = await repository.snapshot();
  if (phase === "after") { expect(recovered.executions.run!.protectedInvocationSecret).toEqual(f.ledger); expect(recovered.protectedContinuations.run).toEqual(f.continuation); }
  else expect(recovered).toEqual(original);
});
test("cross-run writes, foreign actor journals and public exposure are denied", async () => {
  const f = fixture(), repository = await Repository.open(null); await repository.mutate(state => { state.executions.run = f.execution; });
  const before = await repository.snapshot();
  await expect(repository.mutateExecution("run", state => { state.executions.other = { ...f.execution, id: "other" }; })).rejects.toThrow();
  await expect(repository.mutateExecution("run", state => { state.executions.run!.protectedInvocationSecret!.identity.actorId = "foreign"; })).rejects.toThrow();
  expect(await repository.snapshot()).toEqual(before);
  expect(withoutSecretFields(f.execution)).not.toHaveProperty("protectedInvocationSecret");
});

test.each(["source", "input", "operation"])("original execution %s binding cannot substitute a private journal", damage => {
  const f = fixture(), state = initialState();
  f.execution.workflowSnapshot = { version: 1, contentHash: plan.sourceHash, registryHash: "synthetic", yaml: "synthetic", input: f.input, executionProfile: "sequential-operation-v1" };
  if (damage === "source") f.execution.workflowSnapshot.contentHash = `sha256:${"c".repeat(64)}`;
  if (damage === "input") f.execution.workflowSnapshot.input = { id: "foreign-item" };
  if (damage === "operation") f.execution.workflowSnapshot.operationCompilation = { semanticHash: `sha256:${"c".repeat(64)}` } as never;
  state.executions.run = f.execution;
  expect(() => splitRuntimeState(state)).toThrow(/foreign execution\/source/);
});

test("cursor authentication binds complete intent data, not only unchanged receipt head and counts", () => {
  const f = fixture(), changed = structuredClone(f.ledger);
  changed.intents[f.key]!.epoch++;
  expect(changed.head).toBe(f.ledger.head); expect(changed.intentCount).toBe(f.ledger.intentCount);
  expect(() => f.codec.decode(f.continuation, f.cursorIdentity, f.codec.evidenceBinding(f.cursorIdentity, changed))).toThrow();
});
