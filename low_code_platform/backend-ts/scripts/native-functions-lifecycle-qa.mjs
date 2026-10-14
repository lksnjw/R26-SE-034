import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { assertOperationTaskLedger } from "../src/runner/operation-task-outbox.js";

/** Actual exported Scheduler callback/composition, native queue and encrypted
 * Firestore, with the existing isolated Docker Department/echo workflow.
 * Deliberately no clock injection or altered approval record. This proves the
 * callback, not Cloud Scheduler delivery, deployed IAM or a business email. */
export async function qualifyNativeLifecycle({ request, open, handlers }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records");
  assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  assert.equal(typeof handlers.advanceWorkflowLifecycle?.run, "function");
  const expect = async (path, method = "GET", payload, status = 200, actor = "native_owner") => {
    const response = await request("api", path, method, payload, actor);
    assert.equal(response.status, status, response.body); return response.data;
  };
  const inspect = async () => {
    const repository = await open();
    try { return await repository.snapshot(); } finally { await repository.close(); }
  };
  const initial = await inspect(), completed = Object.values(initial.executions).find(run =>
    run.status === "DONE" && run.stepOutputs?.echo?.structuredContent?.value === "native-operation-qa-ack");
  assert(completed, "Run the normal native independent operation campaign first");
  const policy = initial.settings.rbac.runtimeApprovalPolicy;
  await expect("/api/settings/rbac", "PATCH", { runtimeApprovalPolicy: { profile: "runtime-approval-policy/v1",
    baseRevision: policy.revision, enabled: true, approverRoleIds: ["native_review"], ttlSeconds: 60, separationOfDuties: true } });
  const payload = { mode: "async-operation", idempotencyKey: "native_lifecycle_expiry_0001", input: {} };
  const admitted = await expect(`/api/workflows/${completed.workflowId}/run`, "POST", payload, 202);
  assert.equal(admitted.meta.taskDispatch, "ENQUEUED"); const executionId = admitted.data.id;
  let waiting, progressRequests = 0; const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const progress = await expect(`/api/executions/${executionId}`); progressRequests++;
    if (progress.data.status === "AWAITING_APPROVAL") { waiting = progress.data; break; }
    assert(["PENDING", "RUNNING"].includes(progress.data.status), `Unexpected operation: ${progress.data.status}`);
    await pause(500);
  }
  assert(waiting, "The native queued read did not reach its original approval wait");
  assert.equal(waiting.stepOutputs.departments.structuredContent.data.length, 8); assert(!waiting.stepOutputs.echo);
  const original = await inspect(), run = original.executions[executionId];
  const record = run.runtimeApprovalSecret.records[run.runtimeApprovalSecret.activeId];
  assert.equal(record.state, "PENDING"); const expiresAt = Date.parse(record.expiresAt);
  assert.equal(expiresAt - Date.parse(record.requestedAt), 60_000, "Original real-time policy TTL must remain unchanged");
  assert(Date.now() < expiresAt, "The before-expiry callback must actually be before its original deadline");
  const first = assertOperationTaskLedger(run).generations[0];
  assert.equal(first.completion.milestone, "AWAITING_APPROVAL");
  const callback = eventTime => handlers.advanceWorkflowLifecycle.run({ scheduleTime: eventTime, jobName: "local-native-lifecycle-qa" });
  // A malicious/future event clock must not expire the actual original wait.
  await callback(new Date(expiresAt + 86_400_000).toISOString());
  const early = await inspect(); assert.deepEqual(early.executions, original.executions);
  assert.deepEqual(early.executionEvents, original.executionEvents);
  assert.deepEqual(early.scheduleOccurrences, original.scheduleOccurrences);
  console.log(`PASS: actual native lifecycle callback ignores future event clock; original pending approval/TTL, ${progressRequests} queue-backed progress responses and eight saved synthetic Department rows preserved`);
  console.log("WAIT: original 60-second approval deadline; no clock override, altered review, approval or echo dispatch");
  while (Date.now() <= expiresAt + 100) await pause(Math.min(5000, Math.max(1, expiresAt + 101 - Date.now())));
  // Polling a terminal-looking deadline must not itself manufacture expiry.
  const stillWaiting = await expect(`/api/executions/${executionId}`); assert.equal(stillWaiting.data.status, "AWAITING_APPROVAL");
  await callback(new Date(0).toISOString()); // stale event clock is ignored too
  const expired = await inspect(), terminal = expired.executions[executionId];
  assert.equal(terminal.status, "FAILED"); assert.equal(terminal.failure.failureCategory, "RUNTIME_APPROVAL_EXPIRED");
  assert.deepEqual(terminal.runtimeApprovalSecret.records[record.id], record);
  assert.deepEqual(terminal.stepOutputs, run.stepOutputs); assert(!terminal.stepOutputs.echo);
  assert.equal(terminal.pendingApproval, undefined);
  assert.deepEqual(terminal.operationSecret.intents, run.operationSecret.intents);
  assert.deepEqual(assertOperationTaskLedger(terminal), assertOperationTaskLedger(run));
  assert.equal(expired.executionEvents[executionId].filter(event => event.type === "approval.expired").length, 1);
  assert.deepEqual(expired.executions[completed.id], original.executions[completed.id]);
  assert.deepEqual(expired.scheduleOccurrences, original.scheduleOccurrences);
  assert.equal(Object.keys(expired.executions).length, Object.keys(original.executions).length);
  await callback(new Date(expiresAt + 86_400_000).toISOString());
  const duplicate = await request("executeOperationTask", "", "POST", { data: { profile: "operation-task-delivery/v1", executionId, taskId: first.taskId } }, false);
  assert.equal(duplicate.status, 204, duplicate.body);
  const replay = await expect(`/api/workflows/${completed.workflowId}/run`, "POST", payload, 202); assert.equal(replay.data.id, executionId);
  const after = await inspect(); assert.deepEqual(after.executions, expired.executions);
  assert.deepEqual(after.executionEvents, expired.executionEvents); assert.deepEqual(after.scheduleOccurrences, expired.scheduleOccurrences);
  console.log("PASS: actual exported lifecycle callback expires the original native queued approval after its real deadline; duplicate callback/task/same-key run preserve one expiry, original WAIT receipt, read answers and no effect intent");
  console.log("LIMIT: callback .run invoked locally against actual Firestore/Functions task emulators and isolated Docker MockERP; no Cloud Scheduler delivery, due-report admission, real model, business email, deployed IAM or unattended-send qualification");
}
