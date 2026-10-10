import { afterEach, expect, test, vi } from "vitest";
import { operationTaskFixture } from "./fixtures/operation-task.js";
import { TaskRecords } from "./fixtures/bounded-read-task.js";
import { assertOperationTaskLedger, recoverOperationTaskOutboxes, configureOperationTaskDispatch, completeOperationTaskGeneration, operationTaskReceipt } from "../src/runner/operation-task-outbox.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";
import type { OperationTaskCommand } from "../src/runner/operation-task-outbox.js";
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).reverse().map(close => close())); vi.restoreAllMocks(); });
async function fixture(options: Parameters<typeof operationTaskFixture>[0] = {}) { const s = await operationTaskFixture(options); closers.push(s.close); return s; }
async function admission(s: Awaited<ReturnType<typeof fixture>>) {
  const reply = await s.run(); expect(reply.statusCode, reply.body).toBe(202); expect(reply.json().meta.taskDispatch).toBe("ENQUEUED"); return reply.json().data.id as string;
}
const execute = (s: Awaited<ReturnType<typeof fixture>>, index: number, timeoutMs = 4000) => s.queue.executeTask(s.sent[index], { timeoutMs });

/** Pure history fixture: multiple intents on one completed node, not an agent
 * execution claim. Neither the copied intents nor this cloned state are saved. */
async function multiIntentHistory() {
  const s = await fixture(), id = await admission(s); await execute(s, 0);
  const state = await s.repository.snapshot(), run = state.executions[id]!, command = s.sent[0]!;
  const original = Object.values(run.operationSecret!.intents).find(intent => intent.nodeId === "inspect")!;
  run.operationSecret!.intents = { z: { ...original, id: "z-intent" }, a: { ...original, id: "a-intent" } };
  delete run.operationSecret!.taskDispatchSecret!.generations[0]!.completion;
  completeOperationTaskGeneration(state, run, command);
  return { s, state, run, command };
}

test("multi-intent result receipts survive storage map-key reordering without replay", async () => {
  const { s, state, run, command } = await multiIntentHistory(), before = operationTaskReceipt(state, run, command);
  run.operationSecret!.intents = Object.fromEntries(Object.entries(run.operationSecret!.intents).reverse());
  expect(operationTaskReceipt(state, run, command)).toEqual(before);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
});

test.each(["argument", "identity", "state", "added", "removed"])("multi-intent %s evidence changes are still refused", async change => {
  const { s, state, run, command } = await multiIntentHistory(), intents = run.operationSecret!.intents;
  if (change === "argument") intents.a!.argumentHash = "f".repeat(64);
  if (change === "identity") intents.a!.id = "replacement-intent";
  if (change === "state") intents.a!.state = "UNKNOWN";
  if (change === "added") intents.extra = { ...intents.a!, id: "extra-intent" };
  if (change === "removed") delete intents.a;
  expect(() => operationTaskReceipt(state, run, command)).toThrow("result evidence changed");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
});

test("fresh online renewal of identical policy does not cancel its original operation task", async () => {
  const s = await fixture();
  await s.repository.mutate(state => { state.governancePolicy = { lastPrimaryPolicyVersion: "same-reviewed-policy", snapshot: {
    policyVersion: "same-reviewed-policy", rules: [], evidenceIds: ["same-evidence"], ruleVersion: "same-rule-hash", source: "primary",
    fetchedAt: Date.now() - 1000, expiresAt: Date.now() + 300000 } }; });
  Object.assign(s.services, { validationGate: { validateAndIssueToken: async (action: string, yaml: string, actor: { role: string }) => {
    await s.repository.mutate(state => { const snapshot = state.governancePolicy!.snapshot as Record<string, unknown>;
      snapshot.fetchedAt = Date.now(); snapshot.expiresAt = Date.now() + 300000; });
    return s.services.validator.validateAndIssueToken(action, yaml, actor.role);
  } } });
  const id = await admission(s);
  expect(await execute(s, 0)).toMatchObject({ checkpointStatus: "AWAITING_APPROVAL" });
  await s.approve(id); expect(await execute(s, 1)).toMatchObject({ checkpointStatus: "DONE" });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 2);
});

test.each(["expired", "shortened", "changed"])("%s policy cannot reach SDK entry under operation task renewal", async scenario => {
  const s = await fixture();
  await s.repository.mutate(state => { state.governancePolicy = { lastPrimaryPolicyVersion: "reviewed", snapshot: {
    policyVersion: "reviewed", rules: [], evidenceIds: [], ruleVersion: "rules", source: "primary", fetchedAt: Date.now() - 5000,
    expiresAt: scenario === "expired" ? Date.now() - 1000 : Date.now() + 300000 } }; });
  Object.assign(s.services, { validationGate: { validateAndIssueToken: async (action: string, yaml: string, actor: { role: string }) => {
    if (action === "ReadToolBroker" && scenario !== "expired") await s.repository.mutate(state => {
      const snapshot = state.governancePolicy!.snapshot as Record<string, unknown>;
      if (scenario === "shortened") snapshot.expiresAt = Date.now() - 1;
      else snapshot.evidenceIds = ["changed-after-worker-verification"];
    });
    return s.services.validator.validateAndIssueToken(action, yaml, actor.role);
  } } });
  await admission(s); const result = await execute(s, 0);
  expect(["FAILED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED"]).toContain(result.checkpointStatus);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls);
});

test("read -> original independent approval -> separate effect task; old duplicate never enters the approved generation", async () => {
  const s = await fixture(), id = await admission(s); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls);
  const first = await execute(s, 0); expect(first).toMatchObject({ milestone: "AWAITING_APPROVAL", checkpointStatus: "AWAITING_APPROVAL", deliveryVerified: false });
  const before = await s.repository.snapshot(), run = before.executions[id]!, original = run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!;
  expect(s.sdk.callTool.mock.calls.slice(s.baselineCalls).map(call => call[0])).toEqual([exactBridgeName(s.target)]);
  const command = await s.approvalCommand(id), denied = await s.approve(id, command, "requester"); expect(denied.statusCode).toBe(403);
  const granted = await s.approve(id, command); expect(granted.statusCode, granted.body).toBe(200); expect(granted.json().data.taskDispatch).toBe("ENQUEUED"); expect(s.sent).toHaveLength(2);
  expect(s.sent[1]!.taskId).not.toBe(s.sent[0]!.taskId); expect(Object.keys(s.sent[1]!).sort()).toEqual(["executionId", "profile", "taskId"]);
  expect(await execute(s, 0)).toEqual(first); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
  expect(await execute(s, 1)).toMatchObject({ milestone: "TERMINAL", checkpointStatus: "DONE", deliveryVerified: false });
  const done = (await s.repository.snapshot()).executions[id]!, approval = done.runtimeApprovalSecret!.records[original.id]!;
  expect(approval.expiresAt).toBe(original.expiresAt); expect(approval.binding).toEqual(original.binding); expect(approval.state).toBe("CONSUMED");
  expect(s.sdk.callTool.mock.calls.slice(s.baselineCalls).map(call => call[0])).toEqual([exactBridgeName(s.target), exactBridgeName(s.effect)]);
  const events = (await s.repository.snapshot()).executionEvents[id]!;
  expect(await execute(s, 0)).toEqual(first); await execute(s, 1); const replay = await s.approve(id, command); expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().data.replayed).toBe(true); expect((await s.repository.snapshot()).executionEvents[id]).toEqual(events);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 2);
});

test("fresh owner resumes only the approved original generation with preserved expiry and results", async () => {
  const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a); await execute(a, 0); await a.approve(id);
  const command = a.sent[1]!, old = a.sent[0]!, prior = (await a.repository.snapshot()).executions[id]!; await a.close();
  const b = await fixture({ records }); expect(b.sdk.callTool).not.toHaveBeenCalled();
  expect(await b.queue.executeTask(old, { timeoutMs: 4000 })).toMatchObject({ milestone: "AWAITING_APPROVAL" });
  expect(await b.queue.executeTask(command, { timeoutMs: 4000 })).toMatchObject({ checkpointStatus: "DONE" }); expect(b.sdk.callTool).toHaveBeenCalledOnce();
  expect(b.sdk.callTool.mock.calls[0]![0]).toBe(exactBridgeName(b.effect)); expect((await b.repository.snapshot()).executions[id]!.stepOutputs!.inspect).toEqual(prior.stepOutputs!.inspect);
});

test("multiple independent effects each get their own generation, never a reused approval", async () => {
  const s = await fixture({ twoEffects: true }), id = await admission(s); await execute(s, 0);
  await s.approve(id, await s.approvalCommand(id, "first-independent-decision-001"));
  expect(await execute(s, 1)).toMatchObject({ milestone: "AWAITING_APPROVAL" });
  await s.approve(id, await s.approvalCommand(id, "second-independent-decision-001")); await execute(s, 2);
  const run = (await s.repository.snapshot()).executions[id]!;
  expect(run.status).toBe("DONE"); expect(Object.keys(run.runtimeApprovalSecret!.records)).toHaveLength(2);
  expect(assertOperationTaskLedger(run).generations).toHaveLength(3); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 3);
});

test("uninstalled bounded adapter and forged task bodies are refused without new calls", async () => {
  const a = await fixture({ configure: false }), reply = await a.run(); expect(reply.statusCode, reply.body).toBe(503); expect(a.sent).toHaveLength(0);
  const b = await fixture(); await admission(b);
  await expect(b.queue.executeTask({ ...b.sent[0], approval: "grant" }, { timeoutMs: 4000 })).rejects.toThrow();
  expect(() => configureOperationTaskDispatch(b.repository, { enqueue: b.enqueue, timeoutMs: 1000 })).toThrow(); expect(b.sdk.callTool).toHaveBeenCalledTimes(b.baselineCalls);
});

test("unknown effect outcome is not replayed by duplicate delivery or original-key admission", async () => {
  const s = await fixture(), id = await admission(s); await execute(s, 0); await s.approve(id);
  s.sdk.callTool.mockImplementationOnce(async () => { throw new Error("Synthetic unknown effect"); });
  expect(await execute(s, 1)).toMatchObject({ checkpointStatus: "RECONCILIATION_REQUIRED" });
  await execute(s, 1); const repeated = await s.run(); expect(repeated.statusCode, repeated.body).toBe(202); expect(repeated.json().data.id).toBe(id);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 2); expect((await s.repository.snapshot()).executions[id]!.operationSecret!.intents.send!.state).toBe("UNKNOWN");
});

test("lost approval enqueue acknowledgement retains the exact decided generation without resending prior reads", async () => {
  const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a); await execute(a, 0);
  const command = await a.approvalCommand(id); a.enqueue.mockImplementationOnce(async () => { throw new Error("Synthetic queue ACK loss"); });
  const granted = await a.approve(id, command); expect(granted.statusCode, granted.body).toBe(200); expect(granted.json().data.taskDispatch).toBe("PENDING");
  const originalTask = assertOperationTaskLedger((await a.repository.snapshot()).executions[id]!).generations.at(-1)!.taskId; await a.close();
  const b = await fixture({ records }); expect(await recoverOperationTaskOutboxes(b.repository)).toEqual({ inspected: 1, pending: 0 });
  expect(b.sent[0]!.taskId).toBe(originalTask); expect(b.sdk.callTool).not.toHaveBeenCalled(); await execute(b, 0); expect(b.sdk.callTool).toHaveBeenCalledOnce();
});

test("an ignored-cancellation effect deadline and live duplicate cannot produce or acknowledge false success", async () => {
  const s = await fixture(), id = await admission(s); await execute(s, 0); await s.approve(id); let release!: (value: unknown) => void;
  s.sdk.callTool.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const pending = execute(s, 1, 200);
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); await expect(execute(s, 1)).rejects.toThrow("claim is live");
  expect(await pending).toMatchObject({ checkpointStatus: "RECONCILIATION_REQUIRED" }); release({ content: [], structuredContent: { accepted: true } });
  await new Promise<void>(resolve => setImmediate(resolve)); const run = (await s.repository.snapshot()).executions[id]!;
  expect(run.stepOutputs).not.toHaveProperty("send"); await execute(s, 1); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 2);
});

test("a changed original publication binding or terminal journal cannot be acknowledged or dispatched", async () => {
  const s = await fixture(), id = await admission(s); await execute(s, 0); const events = (await s.repository.snapshot()).executionEvents[id]!;
  await s.repository.mutate(state => { state.executionEvents[id]!.pop(); }); await expect(execute(s, 0)).rejects.toThrow("journal is unconfirmed");
  await s.repository.mutate(state => { state.executionEvents[id] = events; state.executions[id]!.workflowSnapshot!.input = { forged: true }; });
  await expect(execute(s, 0)).rejects.toThrow("binding changed"); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
});

const boundedRun = (state: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["repository"]["snapshot"]>>) => Object.values(state.executions).find(run => run.workflowId === "bounded");
test.each(["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"])("before/after COMMIT admission loss at %s retains only the original generation", async stage => {
  for (const committed of [false, true]) {
    const records = new TaskRecords(), a = await fixture({ records }); let captured: OperationTaskCommand | undefined;
    records.commitBeforeFailure = committed; records.failWhen = state => {
      const run = boundedRun(state), generation = run?.operationSecret?.taskDispatchSecret?.generations.at(-1);
      if (run && generation?.state === stage) { captured = { profile: "operation-task-delivery/v1", executionId: run.id, taskId: generation.taskId }; return true; } return false;
    };
    const failed = await a.run(); expect(failed.statusCode).toBeGreaterThanOrEqual(500); expect(() => a.repository.assertAuthority()).toThrow(); await a.close();
    const b = await fixture({ records }), run = boundedRun(await b.repository.snapshot()); expect(b.sdk.callTool).not.toHaveBeenCalled();
    if (!committed && stage === "PREPARED") { expect(run).toBeUndefined(); expect(await recoverOperationTaskOutboxes(b.repository)).toEqual({ inspected: 0, pending: 0 }); }
    else {
      expect(run!.id).toBe(captured!.executionId); await recoverOperationTaskOutboxes(b.repository);
      expect(await b.queue.executeTask(captured, { timeoutMs: 4000 })).toMatchObject({ milestone: "AWAITING_APPROVAL" });
      expect(b.sdk.callTool).toHaveBeenCalledOnce(); expect(assertOperationTaskLedger((await b.repository.snapshot()).executions[run!.id]!)).toMatchObject({ generations: [{ taskId: captured!.taskId }] });
    }
  }
});

test.each([false, true])("approval decision COMMIT loss committed=%s cannot create a second decision or extend expiry", async committed => {
  const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a); await execute(a, 0);
  const command = await a.approvalCommand(id), original = (await a.repository.snapshot()).executions[id]!.runtimeApprovalSecret!.records[command.approvalId]!;
  records.commitBeforeFailure = committed; records.failWhen = state => state.executions[id]!.runtimeApprovalSecret!.records[command.approvalId]!.state === "APPROVED";
  const failed = await a.approve(id, command); expect(failed.statusCode, failed.body).toBe(503); await a.close();
  const b = await fixture({ records }), before = (await b.repository.snapshot()).executions[id]!, approval = before.runtimeApprovalSecret!.records[command.approvalId]!;
  expect(approval.state).toBe(committed ? "APPROVED" : "PENDING"); expect(approval.expiresAt).toBe(original.expiresAt); expect(approval.binding).toEqual(original.binding);
  expect(assertOperationTaskLedger(before).generations).toHaveLength(committed ? 2 : 1); expect(b.sdk.callTool).not.toHaveBeenCalled();
  const replay = await b.approve(id, command); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.replayed).toBe(committed);
  expect(b.sent).toHaveLength(1); await execute(b, 0); expect(b.sdk.callTool).toHaveBeenCalledOnce();
  expect(assertOperationTaskLedger((await b.repository.snapshot()).executions[id]!).generations).toHaveLength(2);
});

test.each(["ENQUEUE_INTENT", "ENQUEUED"])("approved continuation dispatch loss at %s preserves the consumed decision and task", async stage => {
  for (const committed of [false, true]) {
    const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a); await execute(a, 0); const command = await a.approvalCommand(id);
    records.commitBeforeFailure = committed; records.failWhen = state => state.executions[id]!.operationSecret!.taskDispatchSecret!.generations.at(-1)!.state === stage && state.executions[id]!.operationSecret!.taskDispatchSecret!.generations.length === 2;
    const failed = await a.approve(id, command); expect(failed.statusCode, failed.body).toBe(503); await a.close();
    const b = await fixture({ records }), run = (await b.repository.snapshot()).executions[id]!, taskId = assertOperationTaskLedger(run).generations[1]!.taskId;
    expect(run.runtimeApprovalSecret!.records[command.approvalId]!.state).toBe("APPROVED"); await recoverOperationTaskOutboxes(b.repository);
    const replay = await b.approve(id, command); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.replayed).toBe(true);
    await b.queue.executeTask({ profile: "operation-task-delivery/v1", executionId: id, taskId }, { timeoutMs: 4000 }); expect(b.sdk.callTool).toHaveBeenCalledOnce();
  }
});

test.each([false, true])("lost original approval-wait receipt committed=%s is sealed before deciding without repeating its read", async committed => {
  const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a), old = a.sent[0]!;
  records.commitBeforeFailure = committed; records.failWhen = state => !!state.executions[id]!.operationSecret!.taskDispatchSecret!.generations[0]!.completion;
  await expect(execute(a, 0)).rejects.toThrow(); await a.close();
  const b = await fixture({ records }), reply = await b.approve(id); expect(reply.statusCode, reply.body).toBe(200);
  expect(await b.queue.executeTask(old, { timeoutMs: 4000 })).toMatchObject({ milestone: "AWAITING_APPROVAL" }); expect(b.sdk.callTool).not.toHaveBeenCalled();
  await execute(b, 0); expect(b.sdk.callTool).toHaveBeenCalledOnce(); expect(assertOperationTaskLedger((await b.repository.snapshot()).executions[id]!).generations).toHaveLength(2);
});

test.each([false, true])("effect answer COMMIT loss committed=%s never repeats the consumed effect", async committed => {
  const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a); await execute(a, 0); await a.approve(id); const command = a.sent[1]!;
  records.commitBeforeFailure = committed; records.failWhen = state => state.executions[id]!.operationSecret!.intents.send?.state === "ACKNOWLEDGED";
  await expect(execute(a, 1)).rejects.toThrow(); expect(a.sdk.callTool).toHaveBeenCalledTimes(a.baselineCalls + 2); await a.close();
  const b = await fixture({ records }), original = (await b.repository.snapshot()).executions[id]!;
  if (original.operationSecret!.lease) await b.repository.mutateExecution(id, state => { state.executions[id]!.operationSecret!.lease!.expiresAt = Date.now() - 1; });
  const receipt = await b.queue.executeTask(command, { timeoutMs: 4000 });
  expect(receipt.checkpointStatus).toBe(committed ? "RECOVERY_REQUIRED" : "RECONCILIATION_REQUIRED"); await b.queue.executeTask(command, { timeoutMs: 4000 }); expect(b.sdk.callTool).not.toHaveBeenCalled();
});

test.each([false, true])("terminal generation receipt COMMIT loss committed=%s returns only original saved success", async committed => {
  const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a); await execute(a, 0); await a.approve(id); const command = a.sent[1]!;
  records.commitBeforeFailure = committed; records.failWhen = state => !!state.executions[id]!.operationSecret!.taskDispatchSecret!.generations[1]!.completion;
  await expect(execute(a, 1)).rejects.toThrow(); await a.close(); const b = await fixture({ records });
  expect(await b.queue.executeTask(command, { timeoutMs: 4000 })).toMatchObject({ checkpointStatus: "DONE" }); expect(b.sdk.callTool).not.toHaveBeenCalled();
});

test("rejection terminates the business run while the original delivery retains only its approval-wait receipt", async () => {
  const s = await fixture(), id = await admission(s); const receipt = await execute(s, 0), command = await s.approvalCommand(id);
  const reply = await s.request("POST", `/api/executions/${id}/reject`, command, "reviewer"); expect(reply.statusCode, reply.body).toBe(200);
  expect((await s.repository.snapshot()).executions[id]!.status).toBe("FAILED"); expect(await execute(s, 0)).toEqual(receipt);
  expect(s.sent).toHaveLength(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
});

test("revoked requester or approver prevents an approved generation from dispatching", async () => {
  for (const revoked of ["requester", "reviewer"]) {
    const s = await fixture(), id = await admission(s); await execute(s, 0); await s.approve(id);
    await s.repository.mutate(state => { state.users[revoked]!.status = "Inactive"; });
    expect(await execute(s, 1)).not.toHaveProperty("checkpointStatus", "DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
  }
});

test("queued cancellation is not execution and task-owned jobs cannot be started by a resident pump", async () => {
  const s = await fixture(), id = await admission(s); await expect(s.queue.start()).rejects.toThrow();
  const reply = await s.request("POST", `/api/executions/${id}/cancel`, {}); expect(reply.statusCode, reply.body).toBe(200);
  expect(await execute(s, 0)).toMatchObject({ checkpointStatus: "CANCELLED" }); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls);
});

test("shutdown fences a hanging effect and duplicate can acknowledge only recovery", async () => {
  const s = await fixture(), id = await admission(s); await execute(s, 0); await s.approve(id); s.sdk.callTool.mockImplementationOnce(() => new Promise(() => {}));
  const work = execute(s, 1); await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.operationSecret!.intents.send?.state).toBe("DISPATCH_INTENT"));
  await s.queue.stop(); expect(await work).toMatchObject({ checkpointStatus: "RECONCILIATION_REQUIRED" });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 2);
});

test("a duplicate delivery rejects replacement of an earlier saved result even after a later approval", async () => {
  const s = await fixture(), id = await admission(s); await execute(s, 0); await s.approve(id); await execute(s, 1);
  await s.repository.mutateExecution(id, state => { state.executions[id]!.stepOutputs!.inspect = { structuredContent: { value: "forged" } }; });
  await expect(execute(s, 0)).rejects.toThrow("result evidence changed"); await expect(execute(s, 1)).rejects.toThrow("result evidence changed");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 2);
});

test("changed earlier completion evidence is refused before an approved effect task enters the SDK", async () => {
  const s = await fixture(), id = await admission(s); await execute(s, 0); await s.approve(id);
  await s.repository.mutateExecution(id, state => { state.timelines[id]!.find(entry => entry.nodeId === "inspect")!.output = { forged: true }; });
  await expect(execute(s, 1)).rejects.toThrow("result evidence changed"); expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
});

test.each(["CLAIMED", "DISPATCH_INTENT"])("original approved claim/intent loss at %s does not replay a possibly consumed effect", async stage => {
  for (const committed of [false, true]) {
    const records = new TaskRecords(), a = await fixture({ records }), id = await admission(a); await execute(a, 0); await a.approve(id); const command = a.sent[1]!;
    records.commitBeforeFailure = committed; records.failWhen = state => stage === "CLAIMED" ? state.executions[id]!.operationSecret!.state === "CLAIMED" : state.executions[id]!.operationSecret!.intents.send?.state === "DISPATCH_INTENT";
    await expect(execute(a, 1)).rejects.toThrow(); expect(a.sdk.callTool).toHaveBeenCalledTimes(a.baselineCalls + 1); await a.close();
    const b = await fixture({ records }); await b.repository.mutateExecution(id, state => { const lease = state.executions[id]!.operationSecret!.lease; if (lease) lease.expiresAt = Date.now() - 1; });
    const result = await b.queue.executeTask(command, { timeoutMs: 4000 }); expect(result.checkpointStatus).toBe(stage === "CLAIMED" && !committed ? "DONE" : stage === "DISPATCH_INTENT" && committed ? "RECONCILIATION_REQUIRED" : "RECOVERY_REQUIRED");
    expect(b.sdk.callTool).toHaveBeenCalledTimes(stage === "CLAIMED" && !committed ? 1 : 0);
  }
});

test("an approved but expired original review cannot dispatch or refresh its expiry", async () => {
  const s = await fixture(), id = await admission(s); await execute(s, 0); await s.approve(id);
  const before = (await s.repository.snapshot()).executions[id]!, approval = before.runtimeApprovalSecret!.records[before.runtimeApprovalSecret!.activeId]!;
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(approval.expiresAt) + 1000);
  try { expect(await execute(s, 1)).not.toHaveProperty("checkpointStatus", "DONE"); } finally { clock.mockRestore(); }
  expect(s.sdk.callTool).toHaveBeenCalledTimes(s.baselineCalls + 1);
  const after = (await s.repository.snapshot()).executions[id]!.runtimeApprovalSecret!.records[approval.id]!;
  expect(after.expiresAt).toBe(approval.expiresAt); expect(after.state).toBe("APPROVED"); expect(after.consumption).toBeUndefined();
});
