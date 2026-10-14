import { afterEach, expect, test, vi } from "vitest";
import { workflowLifecycleFixture } from "./fixtures/workflow-lifecycle.js";
import { TaskRecords } from "./fixtures/bounded-read-task.js";
import { advanceWorkflowLifecycle } from "../src/runner/workflow-lifecycle.js";
import { workflowScheduleRunner } from "../src/runner/workflow-schedules.js";
import { assertWorkflowLifecycleScope, configureWorkflowLifecycle, withWorkflowLifecycleScope, type WorkflowLifecycleScope } from "../src/runner/workflow-lifecycle-host.js";
import { operationTaskReceipt } from "../src/runner/operation-task-outbox.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).reverse().map(close => close())); vi.restoreAllMocks(); });
async function setup(options: Parameters<typeof workflowLifecycleFixture>[0] = {}) { const s = await workflowLifecycleFixture(options); closers.push(s.close); return s; }
async function due(s: Awaited<ReturnType<typeof setup>>, overrides: Record<string, unknown> = {}) {
  const saved = await s.save("scheduled", overrides); expect(saved.statusCode, saved.body).toBe(200); return Date.parse(saved.json().data.nextRunAt);
}
test("bounded schedule activation still refuses a task-only composition before any mutation", async () => {
  const s = await setup({ lifecycle: false }), before = await s.repository.snapshot();
  const refused = await s.save(); expect(refused.statusCode).toBe(503); expect(await s.repository.snapshot()).toEqual(before); expect(s.enqueue).not.toHaveBeenCalled();
  configureWorkflowLifecycle(s.repository); expect((await s.save()).statusCode).toBe(200);
  await expect(workflowScheduleRunner(s.services).runDue()).rejects.toMatchObject({ status: 503 });
});
test.each(["daily", "weekly", "monthly"])("%s bounded recurrence admits one original window/task and never calls tools", async cadence => {
  const s = await setup(), nowMs = await due(s, { profile: "workflow-calendar-schedule-command/v2", cadence, reportingPeriod: `previous-calendar-${cadence === "daily" ? "day" : cadence === "weekly" ? "week" : "month"}`,
    ...(cadence === "weekly" ? { dayOfWeek: 1 } : cadence === "monthly" ? { dayOfMonth: 1 } : {}) });
  const result = await advanceWorkflowLifecycle(s.services, { nowMs }); expect(result).toMatchObject({ admitted: 1, skipped: 0, blocked: 0, pending: 0, expired: 0, toolsDispatched: false });
  const state = await s.repository.snapshot(), occurrence = Object.values(state.scheduleOccurrences)[0]!, run = state.executions[occurrence.executionId!]!;
  expect(occurrence.state).toBe("ADMITTED"); expect(run.status).toBe("PENDING"); expect(run.scheduleSource?.reportWindow).toEqual(occurrence.reportWindow);
  expect(run.workflowSnapshot!.input).toEqual({ reportStartAt: occurrence.reportWindow!.startAt, reportEndAt: occurrence.reportWindow!.endAt });
  expect(s.sent).toHaveLength(1); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const before = await s.repository.snapshot(); expect((await advanceWorkflowLifecycle(s.services, { nowMs })).admitted).toBe(0);
  expect(await s.repository.snapshot()).toEqual(before); expect(s.sent).toHaveLength(1);
});
test("scheduled task reads proven coverage, stops at independent approval, then acknowledges one reviewed effect", async () => {
  const s = await setup(), nowMs = await due(s); await advanceWorkflowLifecycle(s.services, { nowMs });
  const command = s.sent[0]!, id = command.executionId; await s.queue.executeTask(command, { timeoutMs: 3000 });
  const waiting = (await s.repository.snapshot()).executions[id]!;
  expect(waiting.status).toBe("AWAITING_APPROVAL"); expect(waiting.stepOutputs).toHaveProperty("lookupReport"); expect(s.sdk.callTool).toHaveBeenCalledOnce();
  const review = await s.approvalCommand(id), approval = structuredClone(waiting.runtimeApprovalSecret!.records[review.approvalId]);
  expect((await s.approve(id, review, "requester")).statusCode).toBe(403); expect(s.sent).toHaveLength(1);
  expect((await s.approve(id, review)).statusCode).toBe(200); await s.queue.executeTask(s.sent[1]!, { timeoutMs: 3000 });
  const completed = (await s.repository.snapshot()).executions[id]!; expect(completed.status).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  expect(completed.runtimeApprovalSecret!.records[review.approvalId]!.expiresAt).toBe(approval!.expiresAt);
});
test.each(["publication", "principal", "pause", "archive"])("%s drift cannot admit a new scheduled task", async reason => {
  const s = await setup(), nowMs = await due(s);
  await s.repository.mutate(state => {
    if (reason === "publication") state.workflows.scheduled!.yaml += "\n# changed";
    if (reason === "principal") state.users.requester!.status = "Suspended";
    if (reason === "pause") { state.schedules["schedule-scheduled"]!.state = "PAUSED"; state.schedules["schedule-scheduled"]!.nextRunAt = null; }
    if (reason === "archive") state.workflows.scheduled!.archived = true;
  });
  const result = await advanceWorkflowLifecycle(s.services, { nowMs }); expect(result.admitted).toBe(0); expect(s.sent).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});
test("misfire SKIP records a nonexecuted occurrence while FIRE_ONCE keeps its original report interval", async () => {
  const s = await setup(), original = await due(s, { misfirePolicy: "SKIP", misfireGraceSeconds: 60 });
  const skipped = await advanceWorkflowLifecycle(s.services, { nowMs: original + 3_600_000 }); expect(skipped.skipped).toBe(1); expect(s.sent).toHaveLength(0);
  const next = await due(s, { misfirePolicy: "FIRE_ONCE" });
  await advanceWorkflowLifecycle(s.services, { nowMs: next + 3_600_000 });
  const state = await s.repository.snapshot(), occurrence = Object.values(state.scheduleOccurrences).find(value => value.state === "ADMITTED")!;
  expect(occurrence.scheduledFor).toBe(new Date(next).toISOString()); expect(state.executions[occurrence.executionId!]!.scheduleSource?.reportWindow).toEqual(occurrence.reportWindow);
});
test.each([false, true])("lost occurrence-link commit committed=%s recovers the original admitted run without a second enqueue", async committed => {
  const records = new TaskRecords(), a = await setup({ records }), nowMs = await due(a);
  records.commitBeforeFailure = committed; records.failWhen = state => Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTED");
  await expect(advanceWorkflowLifecycle(a.services, { nowMs })).rejects.toThrow(); const originalCommand = a.sent[0]!;
  await a.close(); const b = await setup({ records }); await advanceWorkflowLifecycle(b.services, { nowMs });
  const state = await b.repository.snapshot(), occurrence = Object.values(state.scheduleOccurrences)[0]!;
  expect(occurrence).toMatchObject({ state: "ADMITTED", executionId: originalCommand.executionId });
  expect(Object.values(state.executions).filter(value => value.scheduleSource)).toHaveLength(1); expect(b.enqueue).not.toHaveBeenCalled(); expect(b.sdk.callTool).not.toHaveBeenCalled();
});
test("expiry preserves the original review/answers and duplicate WAIT receipt without dispatch", async () => {
  const s = await setup(), nowMs = await due(s); await advanceWorkflowLifecycle(s.services, { nowMs });
  const command = s.sent[0]!, id = command.executionId; await s.queue.executeTask(command, { timeoutMs: 3000 });
  const waiting = (await s.repository.snapshot()).executions[id]!, approval = structuredClone(waiting.runtimeApprovalSecret!.records[waiting.runtimeApprovalSecret!.activeId]!);
  const result = await advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(approval.expiresAt) }); expect(result.expired).toBe(1);
  const state = await s.repository.snapshot(), expired = state.executions[id]!;
  expect(expired).toMatchObject({ status: "FAILED", failure: { failureCategory: "RUNTIME_APPROVAL_EXPIRED" } });
  expect(expired.runtimeApprovalSecret!.records[approval.id]).toEqual(approval); expect(expired.stepOutputs).toEqual(waiting.stepOutputs);
  expect(operationTaskReceipt(state, expired, command).milestone).toBe("AWAITING_APPROVAL");
  const before = await s.repository.snapshot(); expect((await advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(approval.expiresAt) })).expired).toBe(0);
  expect(await s.repository.snapshot()).toEqual(before); expect(s.sent).toHaveLength(1); expect(s.sdk.callTool).toHaveBeenCalledOnce();
});
test("malformed expired approval evidence cannot become a fabricated no-dispatch failure", async () => {
  const s = await setup(), nowMs = await due(s); await advanceWorkflowLifecycle(s.services, { nowMs }); await s.queue.executeTask(s.sent[0]!, { timeoutMs: 3000 });
  const id = s.sent[0]!.executionId;
  await s.repository.mutateExecution(id, state => { const run = state.executions[id]!; run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!.reviewHash = `sha256:${"0".repeat(64)}`; });
  const before = await s.repository.snapshot(), approval = before.executions[id]!.runtimeApprovalSecret!.records[before.executions[id]!.runtimeApprovalSecret!.activeId]!;
  await expect(advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(approval.expiresAt) })).rejects.toThrow("inconsistent");
  expect(await s.repository.snapshot()).toEqual(before); expect(s.sdk.callTool).toHaveBeenCalledOnce();
});
test("unbound, copied and retired invocation scopes cannot admit or expire anything", async () => {
  const s = await setup(); let original!: WorkflowLifecycleScope;
  await withWorkflowLifecycleScope(s.repository, {}, async scope => { original = scope; expect(() => assertWorkflowLifecycleScope(s.repository, { ...scope })).toThrow(); });
  expect(() => assertWorkflowLifecycleScope(s.repository, original)).toThrow();
  await expect(workflowScheduleRunner(s.services).runDueInvocation(original)).rejects.toThrow();
  await expect(s.queue.expireWaitingApprovalInvocation(original)).rejects.toThrow();
});
test("abandonment closes authority and drains the owned callback before returning", async () => {
  const s = await setup(), controller = new AbortController(); let finish!: () => void, scope!: WorkflowLifecycleScope, returned = false;
  const pending = withWorkflowLifecycleScope(s.repository, { signal: controller.signal }, async current => { scope = current; await new Promise<void>(done => { finish = done; }); });
  void pending.then(() => { returned = true; }, () => { returned = true; }); controller.abort();
  await new Promise<void>(done => setImmediate(done)); expect(returned).toBe(false); expect(() => assertWorkflowLifecycleScope(s.repository, scope)).toThrow();
  expect(() => s.repository.assertAuthority()).toThrow(); finish(); await expect(pending).rejects.toThrow("cancelled"); expect(returned).toBe(true);
});

test("occurrence and expiry batches honor independent limits and preserve untouched work", async () => {
  const s = await setup(); await s.create("scheduled2"); await s.create("scheduled3");
  const deadlines = [await due(s)];
  for (const id of ["scheduled2", "scheduled3"]) {
    const saved = await s.save(id); expect(saved.statusCode, saved.body).toBe(200); deadlines.push(Date.parse(saved.json().data.nextRunAt));
  }
  const nowMs = Math.max(...deadlines);
  for (let count = 1; count <= 3; count++) {
    expect((await advanceWorkflowLifecycle(s.services, { nowMs, occurrenceLimit: 1 })).admitted).toBe(1);
    expect(s.sent).toHaveLength(count); expect(s.sdk.callTool).not.toHaveBeenCalled();
  }
  for (const command of s.sent) await s.queue.executeTask(command, { timeoutMs: 3000 });
  const waiting = await s.repository.snapshot(), expiry = Math.max(...s.sent.map(command => {
    const run = waiting.executions[command.executionId]!; return Date.parse(run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!.expiresAt);
  }));
  for (let count = 1; count <= 3; count++) {
    expect((await advanceWorkflowLifecycle(s.services, { nowMs: expiry, expiryLimit: 1 })).expired).toBe(1);
    const state = await s.repository.snapshot();
    expect(s.sent.filter(command => state.executions[command.executionId]!.status === "FAILED")).toHaveLength(count);
  }
  expect(s.sent).toHaveLength(3); expect(s.sdk.callTool).toHaveBeenCalledTimes(3);
});

test("expiry cannot assert no dispatch when the pending approval already has an entered intent", async () => {
  const s = await setup(), nowMs = await due(s); await advanceWorkflowLifecycle(s.services, { nowMs }); await s.queue.executeTask(s.sent[0]!, { timeoutMs: 3000 });
  const id = s.sent[0]!.executionId;
  await s.repository.mutateExecution(id, state => {
    const run = state.executions[id]!, original = Object.values(run.operationSecret!.intents)[0]!, approval = run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!;
    run.operationSecret!.intents.entered = { ...original, id: "entered-intent", nodeId: "send", invocationId: approval.binding.invocationId, state: "DISPATCH_INTENT" };
  });
  const entered = await s.repository.snapshot(), run = entered.executions[id]!, approval = run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!;
  await expect(advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(approval.expiresAt) })).rejects.toThrow();
  expect(await s.repository.snapshot()).toEqual(entered); expect(s.sdk.callTool).toHaveBeenCalledOnce();
});

test("a valid scope for one owner cannot grant lifecycle authority to another", async () => {
  const a = await setup(), b = await setup(); await due(b); const before = await b.repository.snapshot();
  await withWorkflowLifecycleScope(a.repository, {}, async scope => {
    expect(() => assertWorkflowLifecycleScope(b.repository, scope)).toThrow();
    await expect(workflowScheduleRunner(b.services).runDueInvocation(scope)).rejects.toThrow();
  });
  expect(await b.repository.snapshot()).toEqual(before); expect(b.enqueue).not.toHaveBeenCalled();
});

test("a deadline retires and drains its owned callback before the invocation rejects", async () => {
  const s = await setup(); let finish!: () => void, retired!: WorkflowLifecycleScope, returned = false;
  const pending = withWorkflowLifecycleScope(s.repository, { timeoutMs: 20 }, async scope => { retired = scope; await new Promise<void>(resolve => { finish = resolve; }); });
  void pending.then(() => { returned = true; }, () => { returned = true; });
  try {
    // The clock guard may deny before the timer callback runs. Wait for the
    // abandonment callback itself, not merely that earlier logical denial.
    await vi.waitFor(() => expect(() => s.repository.assertAuthority()).toThrow(), { interval: 5, timeout: 1000 });
    expect(returned).toBe(false); expect(() => assertWorkflowLifecycleScope(s.repository, retired)).toThrow();
  } finally { finish(); }
  await expect(pending).rejects.toThrow(); expect(returned).toBe(true);
});

test("abandoned lifecycle drains the first persistence close, not a later no-op repository close", async () => {
  const records = new TaskRecords(), s = await setup({ records }), controller = new AbortController();
  let finishStorage!: () => void, finishWork!: () => void, returned = false;
  records.close = vi.fn(() => new Promise<void>(resolve => { finishStorage = resolve; }));
  const pending = withWorkflowLifecycleScope(s.repository, { signal: controller.signal }, async () => { await new Promise<void>(resolve => { finishWork = resolve; }); });
  void pending.then(() => { returned = true; }, () => { returned = true; }); controller.abort();
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(records.close).toHaveBeenCalledOnce();
    await s.repository.close(); // Existing closed flag returns without joining the first persistence close.
    finishWork(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false); expect(records.close).toHaveBeenCalledOnce();
  } finally { finishWork(); finishStorage(); }
  await expect(pending).rejects.toThrow("cancelled"); expect(returned).toBe(true);
});
