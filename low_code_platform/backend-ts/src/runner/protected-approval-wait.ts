import { randomUUID } from "node:crypto";
import type { RepositoryState } from "../repository/store.js";
import type { HandlerServices } from "../http/handlers/common.js";
import { emptyProtectedApprovalRecords, type ProtectedApprovalRecord } from "../repository/protected-approval-records.js";
import { assertProtectedJobCurrent, restoreProtectedJob, sealProtectedCursor, type ProtectedJobOwner } from "./protected-job-state.js";
import { createProtectedApprovalRecord, expireProtectedApprovalRecord, closeProtectedApprovalRecord } from "./protected-approval-protocol.js";
import { assertCurrentProtectedApprovalFacts, currentProtectedApprovalContext, protectedApprovalStorage, type ProtectedApprovalSaved } from "./protected-approval-context.js";
import { appendExecutionEvent } from "./read-checkpoints.js";

/** Server-only atomic wait transition. Only an authenticated current owned
 * claim can capture approval facts; no browser/model request exposes this API.
 * The complete effect driver must be qualified before effect plans are admitted. */
export function createOwnedProtectedApprovalWait(state: RepositoryState, services: HandlerServices, executionId: string, owner: ProtectedJobOwner): string {
  protectedApprovalStorage(services);
  const saved = assertProtectedJobCurrent(state, services, executionId, owner), point = saved.machine.peek();
  if (!point) throw new Error("Protected approval requires a current invocation");
  const initial = currentProtectedApprovalContext(saved, state, services), records = saved.run.protectedApprovalSecret ?? emptyProtectedApprovalRecords();
  if (records.count >= 5000 || Object.values(records.records).some(record => record.binding.invocationId === point.invocationId))
    throw new Error("Protected approval cannot replace an original review or renew its deadline");
  const pending = Object.values(saved.ledger.snapshot().intents).filter(intent => intent.sequence === point.sequence);
  if (pending.length > 1 || pending.some(intent => intent.state !== "PREPARING" || intent.purpose !== "effect" || intent.component.kind !== "node" || intent.epoch !== owner.epoch))
    throw new Error("Protected approval cannot capture an entered or foreign intent");
  if (!pending.length) saved.ledger.prepare(saved.machine, "effect", { kind: "node" }, point.arguments, owner.epoch);
  const id = `protected-approval-${randomUUID()}`, now = Date.now();
  const record = createProtectedApprovalRecord({ ...initial, ledger: saved.ledger.snapshot() }, id,
    `Review exact ${initial.node.effectClass} action ${initial.node.capability.action}. Automatic retry is disabled.`, now);
  records.records[id] = record; records.count++; records.activeId = id;
  const run = saved.run; run.protectedApprovalSecret = records; run.protectedInvocationSecret = saved.ledger.snapshot();
  run.status = "AWAITING_APPROVAL"; run.protectedJobSecret!.state = "WAITING"; delete run.protectedJobSecret!.lease;
  run.pendingApproval = { stepId: point.nodeId, invocationId: point.invocationId, iterations: structuredClone(point.iterations),
    description: record.reason, requestedAt: record.requestedAt };
  run.agentSummary = "Waiting for an independent decision on this exact item and action. No effect was dispatched by this checkpoint.";
  (state.timelines[executionId] ??= []).push({ id, approvalId: id, nodeId: point.nodeId, invocationId: point.invocationId,
    iterations: structuredClone(point.iterations), kind: "approval", status: "AWAITING_APPROVAL", startedAt: record.requestedAt });
  sealProtectedCursor(services, state, run, saved.machine);
  appendExecutionEvent(state, run, "approval.requested", { approvalId: id, state: record.state, version: record.version }, point.nodeId, point.invocationId);
  return id;
}
export function closeProtectedApprovalWait(state: RepositoryState, services: HandlerServices, saved: ProtectedApprovalSaved,
  record: ProtectedApprovalRecord, reason: string, status: "FAILED" | "CANCELLED", now: number): void {
  if (reason === "PROTECTED_APPROVAL_CANCELLED" || reason === "PROTECTED_APPROVAL_CONTEXT_CHANGED") {
    const closed = closeProtectedApprovalRecord(record, saved.ledger.snapshot(), reason, now);
    if (closed.closure!.status !== status) throw new Error("Protected approval closure status changed");
    saved.run.protectedApprovalSecret!.records[record.id] = closed;
  }
  const run = saved.run; run.status = status; run.protectedJobSecret!.state = "FINISHED"; delete run.protectedJobSecret!.lease;
  run.completedAt = new Date(now).toISOString(); run.durationMs = Math.max(0, now - Date.parse(run.startedAt));
  run.failure = { failureCategory: reason, failedStepId: record.binding.nodeId, failedInvocationId: record.binding.invocationId, toolWasCalled: false };
  delete run.pendingApproval;
  run.agentSummary = "This approval checkpoint closed before effect dispatch. Earlier confirmed answers remain saved; no uncertain call was replayed.";
  const entry = state.timelines[run.id]?.find(item => item.approvalId === record.id);
  if (entry) Object.assign(entry, { status, outcome: "NOT_DISPATCHED", completedAt: run.completedAt });
  sealProtectedCursor(services, state, run, saved.machine);
  appendExecutionEvent(state, run, `run.${status.toLowerCase()}`, { reason, outcome: "NOT_DISPATCHED", approvalId: record.id },
    record.binding.nodeId, record.binding.invocationId);
}
/** Maintenance does not claim a worker or dispatch. Original TTL never renews.
 * Authentic history is checked outside revocation handling: corrupt evidence
 * cannot be repaired into a fabricated terminal commit by this path. */
export function settleProtectedApprovalWait(state: RepositoryState, services: HandlerServices, executionId: string): boolean {
  const saved = restoreProtectedJob(state, services, executionId), run = saved.run;
  if (run.protectedJobSecret!.state !== "WAITING") return false;
  const records = run.protectedApprovalSecret!, record = records.records[records.activeId!]!, now = Date.now();
  if (run.readProgress!.cancellation) {
    closeProtectedApprovalWait(state, services, saved, record, "PROTECTED_APPROVAL_CANCELLED", "CANCELLED", now); return true;
  }
  if (now >= Date.parse(record.expiresAt)) {
    records.records[record.id] = expireProtectedApprovalRecord(record, saved.ledger.snapshot(), now);
    closeProtectedApprovalWait(state, services, saved, records.records[record.id]!, "PROTECTED_APPROVAL_EXPIRED", "FAILED", now); return true;
  }
  try { assertCurrentProtectedApprovalFacts(state, services, executionId, record, now); }
  catch {
    closeProtectedApprovalWait(state, services, saved, record, "PROTECTED_APPROVAL_CONTEXT_CHANGED", "FAILED", now); return true;
  }
  return false;
}
/** Internal maintenance hook for the future qualified collection queue.
 * It remains safe to run while effect admission/dispatch is closed. */
export async function maintainProtectedApprovalWaits(services: HandlerServices): Promise<number> {
  protectedApprovalStorage(services);
  const ids = await services.repository.readAuthoritative(state => Object.values(state.executions)
    .filter(run => run.protectedJobSecret?.state === "WAITING").map(run => run.id));
  let closed = 0;
  for (const id of ids) if (await services.repository.mutateExecution(id, state => settleProtectedApprovalWait(state, services, id))) closed++;
  return closed;
}
