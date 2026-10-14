import type { RepositoryState } from "../repository/store.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { protectedApprovalCommandSchema } from "../repository/protected-approval-records.js";
import { assertProtectedJobCurrent, restoreProtectedJob, sealProtectedCursor, protectedHash as hash } from "./protected-job-state.js";
import { decideProtectedApprovalRecord } from "./protected-approval-protocol.js";
import { assertCurrentProtectedApprovalFacts, originalProtectedApprovalContext, protectedApprover, protectedApprovalDenied as deny, protectedApprovalStorage } from "./protected-approval-context.js";
import { closeProtectedApprovalWait } from "./protected-approval-wait.js";
import { appendExecutionEvent } from "./read-checkpoints.js";

function restored(state: Readonly<RepositoryState>, services: HandlerServices, executionId: string) {
  try { return restoreProtectedJob(state, services, executionId); }
  catch { deny("Authenticated protected approval evidence is unavailable"); }
}
/** Minimum exact-case review, separate from generic public execution output.
 * Current independent RBAC applies to history too; canDecide additionally
 * checks current original publication, requester, policy/session and deadline. */
export function protectedApprovalView(state: Readonly<RepositoryState>, services: HandlerServices, executionId: string, user: CurrentUser, approvalId?: string) {
  const run = state.executions[executionId]; if (!run) deny("Approval execution not found", 404);
  protectedApprover(state, user, run.startedBy.id);
  const saved = restored(state, services, executionId), records = run.protectedApprovalSecret, record = records?.records[approvalId ?? records.activeId!];
  if (!record) deny("The exact protected approval record is unavailable", 404);
  let unavailable: string | null = null;
  if (["PENDING", "APPROVED"].includes(record.state)) {
    if (run.completedAt !== null) unavailable = "This execution checkpoint is closed; approval cannot authorize another action.";
    else try { assertCurrentProtectedApprovalFacts(state, services, executionId, record, Date.now()); }
      catch { unavailable = "Original approval facts, deadline or current authorization changed. No effect is authorized."; }
  }
  const node = saved.plan.ir.root.nodes.find(item => item.id === record.binding.nodeId)!;
  if (node.kind !== "action") deny("The original effect definition is unavailable");
  return { id: run.id, workflowId: run.workflowId, workflowName: run.workflowName, status: run.status,
    runtimeApproval: { profile: record.profile, id: record.id, version: record.version, state: record.state, reviewHash: record.reviewHash,
      nodeId: record.binding.nodeId, invocationId: record.binding.invocationId, iterations: structuredClone(record.binding.iterations),
      connectionId: record.binding.admission.connectionId, capabilityRevision: record.binding.admission.revisionId,
      toolName: node.capability.action, remoteToolName: node.capability.remoteName, sourceHash: saved.plan.sourceHash, semanticHash: saved.plan.semanticHash,
      reason: record.reason, requestedAt: record.requestedAt, expiresAt: record.expiresAt, requesterId: record.binding.requesterId,
      arguments: structuredClone(record.arguments), unavailable,
      canDecide: !unavailable && records!.activeId === record.id && record.state === "PENDING" && run.status === "AWAITING_APPROVAL" && run.protectedJobSecret!.state === "WAITING",
      approverRole: state.roles[user.roleId]!.name, operationManaged: false, protectedInvocationManaged: true,
      decision: record.decision ? { outcome: record.decision.outcome, actorId: record.decision.actorId, decidedAt: record.decision.decidedAt } : null,
      closure: record.closure ? structuredClone(record.closure) : null, expiredAt: record.expiredAt ?? null,
      canResume: false, resumeQueued: false,
      resumeReason: "Approval records a decision only. The protected effect driver is not qualified; no operation or email is dispatched by review." } };
}
/** Genuine authenticated HTTP/server decision recorded with its complete
 * private journal and cursor in one scoped transaction. No supplied actor
 * flags/facts/permit and no effect call, queue claim or TTL renewal. */
export async function decideOwnedProtectedApproval(services: HandlerServices, executionId: string, user: CurrentUser,
  raw: unknown, outcome: "APPROVED" | "REJECTED") {
  protectedApprovalStorage(services); user = structuredClone(user);
  const parsed = protectedApprovalCommandSchema.safeParse(raw);
  if (!parsed.success || !["APPROVED", "REJECTED"].includes(outcome)) deny("Approval requires exact ID, version, review hash and decision key", 422);
  const command = parsed.data;
  try { return await services.repository.mutateExecution(executionId, state => {
    const saved = restored(state, services, executionId), { run } = saved, records = run.protectedApprovalSecret, record = records?.records[command.approvalId];
    if (!record) deny("The exact approval record is unavailable");
    const actor = protectedApprover(state, user, record.binding.requesterId);
    try { assertProtectedJobCurrent(state, services, executionId); } catch { deny("Original requester or reviewed publication authority changed"); }
    const context = originalProtectedApprovalContext(saved, state, services, record);
    if (hash(context.policy) !== record.binding.policyHash || context.connectionBinding !== record.binding.connectionBinding)
      deny("Original approval policy or connection changed");
    let decided;
    try { decided = decideProtectedApprovalRecord(context, record, command, actor, outcome, Date.now()); }
    catch { deny("Approval facts, decision, version, original deadline or current authority changed"); }
    if (record.decision) return { replayed: true, approvalId: record.id, state: record.state, version: record.version, executionId, executionStatus: run.status,
      operationManaged: false, protectedInvocationManaged: true, canResume: false, resumeQueued: false };
    if (records!.activeId !== record.id || run.status !== "AWAITING_APPROVAL" || run.protectedJobSecret!.state !== "WAITING")
      deny("The exact owned approval wait changed");
    records!.records[record.id] = decided;
    if (outcome === "REJECTED") closeProtectedApprovalWait(state, services, saved, decided, "PROTECTED_APPROVAL_REJECTED", "FAILED", Date.now());
    else {
      run.status = "BLOCKED"; delete run.pendingApproval;
      run.agentSummary = "Exact independent approval recorded, not execution. The protected effect driver is not qualified; no ERP action or email was sent.";
      const entry = state.timelines[executionId]?.find(item => item.approvalId === record.id);
      if (entry) Object.assign(entry, { status: "BLOCKED", outcome: "APPROVED_NOT_DISPATCHED" });
      sealProtectedCursor(services, state, run, saved.machine);
    }
    appendExecutionEvent(state, run, outcome === "APPROVED" ? "approval.granted" : "approval.rejected",
      { approvalId: record.id, state: decided.state, version: decided.version }, record.binding.nodeId, record.binding.invocationId);
    return { replayed: false, approvalId: record.id, state: decided.state, version: decided.version, executionId, executionStatus: run.status,
      operationManaged: false, protectedInvocationManaged: true, canResume: false, resumeQueued: false };
  }); } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    try { services.repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "Approval acknowledgement is unconfirmed. Reload authoritative storage before another decision; do not automatically retry.",
      { code: "PROTECTED_APPROVAL_SAVE_UNCONFIRMED" }); }
    deny("The current approval checkpoint is unavailable");
  }
}
