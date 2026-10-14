import { expect, test } from "vitest";
import { Repository, initialState, restoreState, type Execution, type PersistenceBackend } from "../src/repository/store.js";
import { applyExecutionCheckpoint, type ExecutionCheckpoint } from "../src/repository/execution-transaction.js";
import { splitRuntimeState, assembleRuntimeState, checkpointRecords, executionRecordScope } from "../src/storage/execution-record-layout.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { ProtectedContinuationCodec } from "../src/runner/protected-continuation.js";
import { assertProtectedContinuation } from "../src/repository/protected-continuation-record.js";
import { ProtectedMachine, protectedMachinePlan } from "../src/workflows/protected-machine.js";
import { withoutSecretFields } from "../src/redact/secrets.js";

const run = (id = "run-a"): Execution => ({ id, workflowId: "flow", workflowName: "Fixture", status: "RUNNING", startedAt: "now",
  completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "owner", name: "Owner" } });
const plan = protectedMachinePlan(`sha256:${"a".repeat(64)}`, { kind: "sequence", nodes: [{ kind: "action", nodeId: "read" }] },
  [{ id: "read", input: { kind: "ref", source: "workflowInput", path: [] } }]);
function fixture(id = "run-a") {
  const codec = new ProtectedContinuationCodec("synthetic-server-binding-key-of-at-least-32-bytes"), input = { id: "private-fixture" };
  const identity = codec.identity({ executionId: id, workflowId: "flow", epoch: 1, actorId: "owner", roleId: "role", admittedRole: "Platform Admin",
    sourceHash: plan.sourceHash, semanticHash: plan.semanticHash }, input);
  const machine = new ProtectedMachine(plan, input); machine.peek();
  const evidence = codec.evidenceBinding(identity, { records: [], lastSequence: 0 });
  return { codec, input, machine, identity, evidence, record: codec.encode(identity, evidence, machine.snapshot()) };
}
class Records implements PersistenceBackend {
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  payload: Uint8Array | null = null; checkpoints: ExecutionCheckpoint[] = []; failure: "before" | "after" | null = null;
  async load() { return this.payload; }
  async save(payload: Uint8Array) { this.payload = Buffer.from(payload); }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint) {
    if (this.failure === "before") throw new Error("Synthetic pre-COMMIT loss");
    const state = restoreState(this.payload!);
    // Exercise the same canonical normalized shape, without pretending this
    // in-memory adapter is the actual Firestore SDK.
    const next = assembleFirestoreState(splitFirestoreState(applyExecutionCheckpoint(state, checkpoint)));
    this.payload = Buffer.from(JSON.stringify(next)); this.checkpoints.push(structuredClone(checkpoint));
    if (this.failure === "after") throw new Error("Synthetic post-COMMIT ACK loss");
  }
  async probe() {} async close() {}
}
async function setup() {
  const storage = new Records(), repository = await Repository.open(storage);
  await repository.mutate(state => { state.executions["run-a"] = run(); state.executions["run-b"] = run("run-b"); state.executionEvents["run-a"] = [];
    state.settings.keep = { value: false }; state.auditLogs.push({ id: "previous" }); });
  return { storage, repository };
}

test("scoped acknowledged save/reopen preserves the exact encrypted pending machine and removes it atomically", async () => {
  const { repository, storage } = await setup(), f = fixture(), before = await repository.snapshot();
  await repository.mutateExecution("run-a", state => {
    state.protectedContinuations["run-a"] = f.record;
    state.executionEvents["run-a"]!.push({ version: 1, executionId: "run-a", workflowId: "flow", sequence: 1, timestamp: "now", type: "fixture-checkpoint", payload: {} });
    state.auditLogs.push({ id: "checkpoint" });
  });
  const reopened = await Repository.open(storage), state = await reopened.snapshot();
  expect(state.executions["run-b"]).toEqual(before.executions["run-b"]); expect(state.settings).toEqual(before.settings);
  expect(state.protectedContinuations["run-a"]).toEqual(f.record); expect(state.readContinuations).toEqual({});
  expect(new ProtectedMachine(plan, {}, f.codec.decode(state.protectedContinuations["run-a"]!, f.identity, f.evidence)).peek()).toEqual(f.machine.peek());
  const records = checkpointRecords(storage.checkpoints[0]!);
  expect(records.find(row => row.path[0] === "protectedContinuations")?.path).toEqual(["protectedContinuations", "run-a"]);
  expect(records.filter(row => row.path[0] !== "auditLogs" && row.path[0] !== "audit-entry").every(row => executionRecordScope(row) === "run-a")).toBe(true);
  expect(JSON.stringify(state.executions["run-a"])).not.toContain(f.record.ciphertext);
  await reopened.mutateExecution("run-a", current => { delete current.protectedContinuations["run-a"]; current.executions["run-a"]!.status = "DONE"; });
  const terminal = await Repository.open(storage).then(value => value.snapshot());
  expect(terminal.protectedContinuations).toEqual({}); expect(terminal.executions["run-a"]!.status).toBe("DONE");
});

test.each(["before", "after"] as const)("%s-COMMIT uncertainty fences cached use until authoritative reload", async phase => {
  const { repository, storage } = await setup(), f = fixture(); storage.failure = phase;
  await expect(repository.mutateExecution("run-a", state => { state.protectedContinuations["run-a"] = f.record; state.executions["run-a"]!.status = "FIXTURE_PENDING"; })).rejects.toThrow();
  expect((await repository.snapshot()).protectedContinuations).toEqual({});
  await expect(repository.readAuthoritative(state => state.protectedContinuations["run-a"])).rejects.toThrow(/unavailable/);
  await expect(repository.mutateExecution("run-a", () => {})).rejects.toThrow(/fenced/);
  storage.failure = null; await repository.recoverPersistenceState();
  const confirmed = await repository.readAuthoritative(state => ({ record: state.protectedContinuations["run-a"], status: state.executions["run-a"]!.status }));
  expect(confirmed).toEqual(phase === "after" ? { record: f.record, status: "FIXTURE_PENDING" } : { record: undefined, status: "RUNNING" });
  // No worker, ERP client or automatic machine advancement exists here.
  expect(f.machine.peek()).toEqual(f.machine.snapshot().pending);
  expect(f.machine.snapshot().sequence).toBe(0);
});

test.each(["other-run", "wrong-id", "legacy-profile", "extra-grant", "plaintext", "noncanonical", "too-large", "orphan", "dual-profile"])("invalid %s scoped storage is rejected without a partial commit", async damage => {
  const { repository, storage } = await setup(), f = fixture(), before = await repository.snapshot();
  const changed: any = structuredClone(f.record);
  if (damage === "wrong-id") changed.executionId = "run-b";
  if (damage === "legacy-profile") changed.profile = "read-continuation/v1";
  if (damage === "extra-grant") changed.approved = true;
  if (damage === "plaintext") changed.ciphertext = "raw private input";
  if (damage === "noncanonical") changed.ciphertext += "\n";
  if (damage === "too-large") changed.ciphertext = "A".repeat(5_400_001);
  await expect(repository.mutateExecution("run-a", state => {
    state.protectedContinuations[damage === "other-run" ? "run-b" : "run-a"] = changed;
    if (damage === "orphan") delete state.executions["run-a"];
    if (damage === "dual-profile") state.readContinuations["run-a"] = { profile: "read-continuation/v1", executionId: "run-a", ciphertext: "historical" };
  })).rejects.toThrow();
  expect(await repository.snapshot()).toEqual(before); expect(storage.checkpoints).toEqual([]);
});

test("normalized runtime and Firestore layouts keep the new cursor outside execution/domain root and retain legacy layout identity", () => {
  const state = initialState(), f = fixture(); state.executions["run-a"] = run(); state.protectedContinuations["run-a"] = f.record;
  for (const [split, assemble] of [[splitRuntimeState, assembleRuntimeState], [splitFirestoreState, assembleFirestoreState]] as const) {
    const records = split(state); expect(assemble(records)).toEqual(state);
    expect(records.filter(row => row.path[0] === "protectedContinuations")).toHaveLength(1);
    expect(records.some(row => row.path[0] === "domain" && row.path[1] === "protectedContinuations")).toBe(false);
    expect(records.find(row => row.path[0] === "executions")?.value).not.toHaveProperty("protectedContinuations");
    expect(() => assemble(records.filter(row => row.path[0] !== "executions"))).toThrow(/Orphan/);
    expect(() => assemble([...records, records.find(row => row.path[0] === "protectedContinuations")!])).toThrow(/Duplicate|duplicate/);
  }
  delete state.protectedContinuations["run-a"];
  const historical = { ...state } as any; delete historical.protectedContinuations;
  const restored = restoreState(Buffer.from(JSON.stringify(historical)));
  expect(restored.protectedContinuations).toEqual({});
  expect(splitRuntimeState(restored).some(row => row.path[0] === "protectedContinuations")).toBe(false);
  expect((splitRuntimeState(restored).find(row => row.path[0] === "root")!.value as any).protectedContinuations).toBeUndefined();
});

test.each([null, [], "raw"])("malformed private map %j is never silently reset during restore", value => {
  const state: any = initialState(); state.protectedContinuations = value;
  expect(() => restoreState(Buffer.from(JSON.stringify(state)))).toThrow(/protected continuation map/);
});
test("cross-profile/orphan restore and direct scoped record construction fail closed", () => {
  const state = initialState(), f = fixture(); state.protectedContinuations["run-a"] = f.record;
  expect(() => restoreState(Buffer.from(JSON.stringify(state)))).toThrow(/Orphan/);
  expect(() => checkpointRecords({ executionId: "run-a", protectedContinuation: f.record, auditStart: 0, auditAppend: [] })).toThrow(/Orphan/);
  state.executions["run-a"] = run(); state.readContinuations["run-a"] = { profile: "read-continuation/v1", executionId: "run-a", ciphertext: "historical" };
  expect(() => restoreState(Buffer.from(JSON.stringify(state)))).toThrow(/Conflicting/);
  expect(() => splitRuntimeState(state)).toThrow(/Conflicting/);
  expect(() => checkpointRecords({ executionId: "run-a", execution: run(), protectedContinuation: f.record, continuation: state.readContinuations["run-a"]!, auditStart: 0, auditAppend: [] })).toThrow(/Conflicting/);
  expect(() => assertProtectedContinuation(f.record, "run-b")).toThrow(/identity/);
});
test("public secret projection strips private maps and nested ciphertext without dropping readable answers", () => {
  const f = fixture();
  expect(withoutSecretFields({ protectedContinuations: { "run-a": f.record }, readContinuations: { historical: {} },
    nested: { ciphertext: f.record.ciphertext, answer: "Readable" }, value: 0 })).toEqual({ nested: { answer: "Readable" }, value: 0 });
});
