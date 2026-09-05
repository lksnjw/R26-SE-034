import { describe, expect, test } from "vitest";
import { Repository, type Execution, type PersistenceBackend } from "../src/repository/store.js";
import { applyExecutionCheckpoint, type ExecutionCheckpoint } from "../src/repository/execution-transaction.js";

const run = (id = "run-one"): Execution => ({ id, workflowId: "wf", workflowName: "Test", status: "RUNNING", startedAt: "2026-10-05T00:00:00Z", completedAt: null, durationMs: 0,
  tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: "owner", name: "Owner" } });

class Records implements PersistenceBackend {
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  payload: Uint8Array | null = null; checkpoints: ExecutionCheckpoint[] = []; saves = 0; fail: "before" | "after" | null = null;
  async load() { return this.payload; }
  async save(payload: Uint8Array) { this.saves++; this.payload = Buffer.from(payload); }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint) {
    if (this.fail === "before") throw new Error("lost save");
    const state = JSON.parse(Buffer.from(this.payload!).toString("utf8"));
    this.payload = Buffer.from(JSON.stringify(applyExecutionCheckpoint(state, checkpoint))); this.checkpoints.push(checkpoint);
    if (this.fail === "after") throw new Error("lost acknowledgement");
  }
  async probe() {} async close() {}
}

async function setup(persistence: PersistenceBackend | null = null) {
  const repo = await Repository.open(persistence);
  await repo.mutate(state => { state.executions["run-one"] = run(); state.executions["run-two"] = run("run-two"); state.timelines["run-one"] = []; state.executionEvents["run-one"] = [];
    state.settings.example = { deep: { value: 42 } }; state.auditLogs.push({ id: "old-audit", deep: { value: 1 } }); });
  return repo;
}

describe("scoped execution checkpoints", () => {
  test("commits only copied run evidence and appended audit entries through the record capability", async () => {
    const persistence = new Records(), repo = await setup(persistence), saves = persistence.saves;
    await repo.mutateExecution("run-one", state => {
      expect(state.settings.example).toEqual({ deep: { value: 42 } }); expect(Object.keys(state.executions)).toEqual(["run-two", "run-one"]);
      state.executions["run-one"]!.status = "DONE"; state.timelines["run-one"]!.push({ id: "answer", output: { value: 0 } });
      state.auditLogs.push({ id: "new-audit" }); expect(state.auditLogs.at(-1)!.id).toBe("new-audit");
      expect([...state.auditLogs].map(value => value.id)).toEqual(["old-audit", "new-audit"]);
    });
    expect(persistence.saves).toBe(saves); expect(persistence.checkpoints).toHaveLength(1);
    const snapshot = await repo.snapshot(); expect(snapshot.executions["run-one"]!.status).toBe("DONE"); expect(snapshot.executions["run-two"]!.status).toBe("RUNNING"); expect(snapshot.auditLogs).toHaveLength(2);
    expect(await Repository.open(persistence).then(value => value.snapshot())).toEqual(snapshot);
  });
  test.each([
    (state: any) => { state.settings.example.deep.value = 0; },
    (state: any) => { state.settings = {}; },
    (state: any) => { state.executions["run-two"].status = "DONE"; },
    (state: any) => { delete state.executions["run-two"]; },
    (state: any) => { state.timelines["run-two"] = []; },
    (state: any) => { state.readContinuations["run-two"] = {}; },
    (state: any) => { Object.getOwnPropertyDescriptor(state.settings, "example")!.value.deep.value = 0; },
    (state: any) => { Object.getOwnPropertyDescriptor(state.executions, "run-two")!.value.status = "DONE"; },
    (state: any) => { state.auditLogs[0].deep.value = 0; },
    (state: any) => { state.auditLogs[0] = {}; },
    (state: any) => { state.auditLogs.length = 0; },
    (state: any) => { Object.defineProperty(state.executions, "run-one", { value: {} }); },
    (state: any) => { Object.setPrototypeOf(state.settings, {}); },
  ])("denies unrelated writes without publishing any partial selected-run mutation (%#)", async mutation => {
    const repo = await setup(), before = await repo.snapshot();
    await expect(repo.mutateExecution("run-one", state => { state.executions["run-one"]!.status = "DONE"; mutation(state); })).rejects.toThrow(); expect(await repo.snapshot()).toEqual(before);
  });
  test("returned or retained writable objects cannot mutate committed state after the callback", async () => {
    const repo = await setup(); let retained!: Execution;
    const returned = await repo.mutateExecution("run-one", state => { retained = state.executions["run-one"]!; return retained; });
    retained.status = "FAILED"; returned.status = "FAILED"; expect((await repo.snapshot()).executions["run-one"]!.status).toBe("RUNNING");
  });
  test.each(["before", "after"] as const)("fences uncertain %s-save outcomes until authoritative reload", async phase => {
    const persistence = new Records(), repo = await setup(persistence); persistence.fail = phase;
    await expect(repo.mutateExecution("run-one", state => { state.executions["run-one"]!.status = "DONE"; })).rejects.toThrow();
    expect((await repo.snapshot()).executions["run-one"]!.status).toBe("RUNNING");
    await expect(repo.readAuthoritative(() => true)).rejects.toThrow("unavailable");
    await expect(repo.mutateExecution("run-one", () => {})).rejects.toThrow("fenced"); await expect(repo.mutate(() => {})).rejects.toThrow("uncertain");
    await repo.recoverPersistenceState(); expect((await repo.snapshot()).executions["run-one"]!.status).toBe(phase === "after" ? "DONE" : "RUNNING");
  });
  test("legacy durable backend retains aggregate persistence instead of claiming record support", async () => {
    const persistence = new Records(); Object.defineProperty(persistence, "executionCheckpointDurability", { value: undefined }); const repo = await setup(persistence), saves = persistence.saves;
    await repo.mutateExecution("run-one", state => { state.executions["run-one"]!.status = "DONE"; }); expect(persistence.saves).toBe(saves + 1); expect(persistence.checkpoints).toHaveLength(0);
  });
  test("holds current authority and mutation lock until durable acknowledgement", async () => {
    const persistence = new Records(), repo = await setup(persistence), original = persistence.saveExecutionCheckpoint.bind(persistence);
    let entered!: () => void, release!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    persistence.saveExecutionCheckpoint = async checkpoint => { entered(); await wait; await original(checkpoint); };
    const checkpoint = repo.mutateExecution("run-one", state => { state.executions["run-one"]!.status = "DONE"; }); await ready;
    let revoked = false; const revocation = repo.mutate(state => { revoked = true; state.settings.revoked = true; }); await Promise.resolve(); expect(revoked).toBe(false);
    release(); await Promise.all([checkpoint, revocation]); expect(revoked).toBe(true);
  });
  test("validates exact execution/job identities and evidence array types", async () => {
    const repo = await setup();
    await expect(repo.mutateExecution("run-one", state => { state.executions["run-one"]!.id = "other"; })).rejects.toThrow("identity");
    await expect(repo.mutateExecution("run-one", state => { state.timelines["run-one"] = {} as never; })).rejects.toThrow("array");
    await expect(repo.mutateExecution("run-one", state => { state.readContinuations["run-one"] = { profile: "read-continuation/v1", executionId: "other", ciphertext: "private" }; })).rejects.toThrow("identity");
  });
  test("persists the private continuation atomically with its run and removes it in the same terminal checkpoint", async () => {
    const persistence = new Records(), repo = await setup(persistence);
    await repo.mutateExecution("run-one", state => { state.readContinuations["run-one"] = { profile: "read-continuation/v1", executionId: "run-one", ciphertext: "encrypted-private-cursor" }; });
    expect((await Repository.open(persistence).then(value => value.snapshot())).readContinuations["run-one"]).toMatchObject({ ciphertext: "encrypted-private-cursor" });
    await repo.mutateExecution("run-one", state => { delete state.readContinuations["run-one"]; state.executions["run-one"]!.status = "DONE"; });
    const state = await Repository.open(persistence).then(value => value.snapshot()); expect(state.readContinuations).toEqual({}); expect(state.executions["run-one"]!.status).toBe("DONE");
  });
  test("never evaluates or deep-clones unrelated stored objects during an in-memory checkpoint", async () => {
    const repo = await setup(); let unrelatedReads = 0;
    await repo.mutate(state => { Object.defineProperty(state.settings, "unrelated", { enumerable: true, configurable: true, get: () => { unrelatedReads++; return { value: 1 }; } }); });
    await repo.mutateExecution("run-one", state => { state.executions["run-one"]!.status = "DONE"; }); expect(unrelatedReads).toBe(0);
  });
  test.each(["__proto__", "constructor", "toString"])("selected execution key %s remains an own record rather than an inherited member", async id => {
    const repo = await setup(); await repo.mutateExecution(id, state => { state.executions[id] = run(id); state.timelines[id] = []; });
    const snapshot = await repo.snapshot(); expect(Object.hasOwn(snapshot.executions, id)).toBe(true); expect(snapshot.executions[id]!.id).toBe(id); expect(snapshot.executions["run-one"]!.status).toBe("RUNNING");
  });
});
