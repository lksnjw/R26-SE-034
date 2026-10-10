import { afterEach, expect, test, vi } from "vitest";
import { readbackTaskFixture } from "./fixtures/readback-task.js";
import { TaskRecords } from "./fixtures/bounded-read-task.js";
import { assertReadbackTaskOutbox, configureReadbackTaskDispatch, recoverReadbackTaskOutboxes } from "../src/runner/readback-task-outbox.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).reverse().map(close => close())); vi.restoreAllMocks(); });
async function fixture(options: Parameters<typeof readbackTaskFixture>[0] = {}) { const s = await readbackTaskFixture(options); closers.push(s.close); return s; }
const saved = (s: Awaited<ReturnType<typeof fixture>>, id: string) => s.repository.readAuthoritative(state => state.executions[s.id]!.operationSecret!.readbacks![id]!);

test("bounded admission queues a read-only query; execution answers without altering or resending the original action", async () => {
  const s = await fixture(), before = await s.repository.snapshot(), source = before.executions[s.id]!;
  const receipt = await s.admit(); expect(receipt).toMatchObject({ state: "QUEUED", taskDispatch: "ENQUEUED", noReplay: true, deliveryVerified: false });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect(s.sent).toHaveLength(1);
  expect(Object.keys(s.sent[0]!).sort()).toEqual(["executionId", "profile", "queryId", "taskId"]);
  const answer = await s.queue.executeTask(s.sent[0], { timeoutMs: 4000 });
  expect(answer).toMatchObject({ state: "ANSWERED", observation: { outcome: "NOT_APPLIED" }, canResume: false, deliveryVerified: false });
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.effect), exactBridgeName(s.target)]);
  const after = await s.repository.snapshot(), original = after.executions[s.id]!;
  expect(original.status).toBe("RECONCILIATION_REQUIRED"); expect(original.operationSecret!.intents).toEqual(source.operationSecret!.intents);
  expect(original.stepOutputs).toEqual(source.stepOutputs); expect(after.timelines[s.id]).toEqual(before.timelines[s.id]);
  const count = after.executionEvents[s.id]!.length;
  expect(await s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).toEqual(answer);
  expect(await s.admit()).toMatchObject({ id: receipt.id, state: "ANSWERED", replayed: true });
  expect((await s.repository.snapshot()).executionEvents[s.id]).toHaveLength(count); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const exposed = JSON.stringify(await s.history()); expect(exposed).not.toMatch(/taskDispatchSecret|bindingHash|synthetic-stable-token/);
});

test("fresh bounded owner completes the original query and never adopts the resident pump", async () => {
  const records = new TaskRecords(), a = await fixture({ records }), receipt = await a.admit(), command = a.sent[0]!;
  await a.close(); const b = await fixture({ records });
  expect(b.sdk.callTool).not.toHaveBeenCalled();
  expect(await b.queue.executeTask(command, { timeoutMs: 4000 })).toMatchObject({ id: receipt.id, state: "ANSWERED" });
  expect(b.sdk.callTool).toHaveBeenCalledOnce(); expect(b.sdk.callTool.mock.calls[0]![0]).toBe(exactBridgeName(b.target));
});

test("unsupported bounded owner cannot advertise or persist status-query admission", async () => {
  const s = await fixture({ configure: false }), before = await s.repository.snapshot();
  expect((await s.history()).canQuery).toBe(false);
  await expect(s.admit()).rejects.toMatchObject({ status: 503, meta: { code: "EXECUTION_HOST_DISPATCH_UNAVAILABLE" } });
  expect(await s.repository.snapshot()).toEqual(before); expect(s.enqueue).not.toHaveBeenCalled();
});

test("forged task envelope and altered original binding are denied before query dispatch", async () => {
  const s = await fixture(); const receipt = await s.admit();
  await expect(s.queue.executeTask({ ...s.sent[0], actorId: "admin" }, { timeoutMs: 4000 })).rejects.toThrow();
  expect(() => configureReadbackTaskDispatch(s.repository, { enqueue: s.enqueue, timeoutMs: 1000 })).toThrow();
  await s.repository.mutateExecution(s.id, state => { state.executions[s.id]!.operationSecret!.readbacks![receipt.id]!.arguments.value = "different"; });
  await expect(s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).rejects.toThrow(); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each(["actor", "admission", "target"])("changed %s blocks a queued query before the SDK and leaves the original effect untouched", async change => {
  const s = await fixture(), receipt = await s.admit();
  if (change === "target") s.target.description = "Unreviewed changed status contract";
  else await s.repository.mutate(state => {
    if (change === "actor") state.users.requester!.status = "Disabled";
    else state.capabilityAdmissions[(state.executions[s.id]!.operationSecret!.readbacks![receipt.id]!.admission.capabilityId)]!.state = "DISABLED";
  });
  const answer = await s.queue.executeTask(s.sent[0], { timeoutMs: 4000 }); expect(answer).toMatchObject({ state: "FAILED", queryOutcome: "NOT_DISPATCHED" });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("live duplicate cannot acknowledge a running claim, while timeout fences an ignored-cancellation answer", async () => {
  const s = await fixture(), receipt = await s.admit(); let release!: (value: unknown) => void;
  s.sdk.callTool.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const execution = s.queue.executeTask(s.sent[0], { timeoutMs: 200 });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).rejects.toThrow("claim is live");
  expect(await execution).toMatchObject({ state: "RECOVERY_REQUIRED", queryOutcome: "UNKNOWN" });
  release({ content: [], structuredContent: { value: "original", state: "APPLIED", settled: true, observedAt: new Date().toISOString() } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(await saved(s, receipt.id)).not.toHaveProperty("result");
  expect(await s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).toMatchObject({ state: "RECOVERY_REQUIRED" }); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each([false, true])("expired original claim with dispatchIntent=%s is recovered without a status query or original resend", async intent => {
  const s = await fixture(), receipt = await s.admit(), job = await saved(s, receipt.id);
  await s.repository.mutateExecution(s.id, state => {
    const stored = state.executions[s.id]!.operationSecret!.readbacks![receipt.id]!;
    stored.state = "RUNNING"; stored.startedAt = new Date().toISOString(); stored.lease = { id: "original-lease", workerId: "dead-original-worker", expiresAt: Date.now() - 1 };
    if (intent) stored.dispatchIntentAt = stored.startedAt;
  });
  expect(await s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).toMatchObject({ state: intent ? "RECOVERY_REQUIRED" : "FAILED" });
  const final = await saved(s, receipt.id); expect(final.epoch).toBe(job.epoch + 1); expect(final.lease).toBeUndefined(); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("queued cancellation and running cancellation never claim success or resend", async () => {
  const a = await fixture(), queued = await a.admit();
  expect(await a.queue.cancel(a.id, queued.id, a.actor)).toMatchObject({ state: "CANCELLED", queryOutcome: "NOT_DISPATCHED" });
  expect(await a.queue.executeTask(a.sent[0], { timeoutMs: 4000 })).toMatchObject({ state: "CANCELLED" }); expect(a.sdk.callTool).toHaveBeenCalledTimes(1);
  const b = await fixture(), running = await b.admit(); b.sdk.callTool.mockImplementationOnce(() => new Promise(() => {}));
  const work = b.queue.executeTask(b.sent[0], { timeoutMs: 4000 });
  await vi.waitFor(async () => expect((await saved(b, running.id)).dispatchIntentAt).toBeTruthy());
  await b.queue.cancel(b.id, running.id, b.actor);
  expect(await work).toMatchObject({ state: "RECOVERY_REQUIRED", queryOutcome: "UNKNOWN" }); expect(b.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("owner shutdown fences an ignored-cancellation SDK call and returns only a saved recovery receipt", async () => {
  const s = await fixture(), receipt = await s.admit(); s.sdk.callTool.mockImplementationOnce(() => new Promise(() => {}));
  const work = s.queue.executeTask(s.sent[0], { timeoutMs: 4000 });
  await vi.waitFor(async () => expect((await saved(s, receipt.id)).dispatchIntentAt).toBeTruthy());
  await s.queue.stop(); expect(await work).toMatchObject({ state: "RECOVERY_REQUIRED" }); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("lost queue acknowledgement recovers the same task identity without executing a query", async () => {
  const records = new TaskRecords(), captured: unknown[] = [], s = await fixture({ records, enqueue: async command => { captured.push(command); throw new Error("Synthetic queue ACK loss"); } });
  const receipt = await s.admit(); expect(receipt).toMatchObject({ taskDispatch: "PENDING" }); await s.close();
  const reopened = await fixture({ records }); expect(await recoverReadbackTaskOutboxes(reopened.repository)).toEqual({ inspected: 1, pending: 0 });
  expect(reopened.sent[0]).toEqual(captured[0]); expect(reopened.sdk.callTool).not.toHaveBeenCalled();
  expect(await reopened.queue.executeTask(reopened.sent[0], { timeoutMs: 4000 })).toMatchObject({ state: "ANSWERED" });
});

test.each(["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"])("before/after COMMIT loss at %s never invents another query or task identity", async stage => {
  for (const committed of [false, true]) {
    const records = new TaskRecords(), s = await fixture({ records });
    records.commitBeforeFailure = committed;
    records.failWhen = state => Object.values(state.executions[s.id]!.operationSecret!.readbacks ?? {}).some(job => job.taskDispatchSecret?.state === stage);
    await expect(s.admit()).rejects.toMatchObject({ status: 503 }); await s.close();
    const b = await fixture({ records }), jobs = await b.repository.read(state => Object.values(state.executions[b.id]!.operationSecret!.readbacks ?? {}));
    if (!committed && stage === "PREPARED") { expect(jobs).toHaveLength(0); expect(await recoverReadbackTaskOutboxes(b.repository)).toEqual({ inspected: 0, pending: 0 }); }
    else {
      expect(jobs).toHaveLength(1); const job = jobs[0]!, exact = assertReadbackTaskOutbox(job);
      await recoverReadbackTaskOutboxes(b.repository); expect(b.sdk.callTool).not.toHaveBeenCalled();
      const command = { profile: "readback-task-delivery/v1" as const, executionId: b.id, queryId: job.id, taskId: exact.taskId };
      expect(await b.queue.executeTask(command, { timeoutMs: 4000 })).toMatchObject({ state: "ANSWERED" }); expect(b.sdk.callTool).toHaveBeenCalledOnce();
    }
  }
});

test("terminal acknowledgement requires a complete journal and historically validated answer", async () => {
  const s = await fixture(), receipt = await s.admit(); await s.queue.executeTask(s.sent[0], { timeoutMs: 4000 });
  const events = (await s.repository.snapshot()).executionEvents[s.id]!;
  await s.repository.mutate(state => { state.executionEvents[s.id]!.pop(); });
  await expect(s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).rejects.toThrow("journal is incomplete"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  await s.repository.mutate(state => { state.executionEvents[s.id] = events;
    state.executions[s.id]!.operationSecret!.readbacks![receipt.id]!.evaluation!.outcome = "APPLIED";
  });
  await expect(s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).rejects.toThrow("classification disagrees"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  expect((await saved(s, receipt.id)).state).toBe("ANSWERED");
});

test("a mismatched readback result is failed, not presented as original completion or delivery", async () => {
  const s = await fixture(); await s.admit();
  s.sdk.callTool.mockImplementationOnce(async () => ({ content: [], structuredContent: { value: "wrong-original", state: "APPLIED", settled: true, observedAt: new Date().toISOString() } }));
  expect(await s.queue.executeTask(s.sent[0], { timeoutMs: 4000 })).toMatchObject({ state: "FAILED", queryOutcome: "UNQUALIFIED_RESULT", failure: "READBACK_RESULT_UNQUALIFIED", deliveryVerified: false });
  expect((await s.repository.snapshot()).executions[s.id]!.status).toBe("RECONCILIATION_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("late enqueue acknowledgement cannot promote the abandoned original query", async () => {
  let release!: (value: { taskId: string; outcome: "CREATED" }) => void;
  const s = await fixture({ timeoutMs: 10, enqueue: () => new Promise(resolve => { release = resolve; }) });
  const receipt = await s.admit(), job = await saved(s, receipt.id);
  expect(receipt).toMatchObject({ taskDispatch: "PENDING" }); expect(job.taskDispatchSecret!.state).toBe("ENQUEUE_INTENT");
  release({ taskId: job.taskDispatchSecret!.taskId, outcome: "CREATED" }); await new Promise<void>(resolve => setImmediate(resolve));
  expect((await saved(s, receipt.id)).taskDispatchSecret!.state).toBe("ENQUEUE_INTENT"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});
