import type { RepositoryState } from "../repository/store.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { protectedApprovalPolicySchema, type ProtectedApprovalRecord } from "../repository/protected-approval-records.js";
import { boundMcpConnection } from "../tools/mcp-dispatch-context.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";
import { workflowContentHash } from "../parser/workflow.js";
import { assertProtectedJobCurrent, protectedHash as hash, type restoreProtectedJob } from "./protected-job-state.js";
import { assertProtectedApprovalContext, type ProtectedApprovalContext, type ProtectedApproverData } from "./protected-approval-protocol.js";

export type ProtectedApprovalSaved = ReturnType<typeof restoreProtectedJob>;
export function protectedApprovalDenied(message: string, status = 409): never {
  throw new HandlerFailure(status, message, { code: "PROTECTED_APPROVAL_DENIED" });
}
export function protectedApprovalStorage(services: HandlerServices): void {
  const persistence = services.repository.persistence;
  if (persistence && (persistence.readQueueDurability !== "encrypted-single-writer" ||
      persistence.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !persistence.saveExecutionCheckpoint))
    protectedApprovalDenied("Protected approvals require qualified encrypted scoped transactions", 503);
  services.repository.assertAuthority();
}
export function protectedApprovalPolicy(state: Readonly<RepositoryState>) {
  const parsed = protectedApprovalPolicySchema.safeParse((state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy);
  if (!parsed.success) protectedApprovalDenied("A current enabled independent approval policy is required", 503);
  return parsed.data;
}
/** Always derive current authority from account/role/policy records. Neither a
 * caller's permissions nor the captured historical policy grants authority. */
export function protectedApprover(state: Readonly<RepositoryState>, user: CurrentUser | string, requesterId: string): ProtectedApproverData {
  const actorId = typeof user === "string" ? user : user.id, account = state.users[actorId], role = account && state.roles[account.roleId];
  const permissions = [...new Set([...(role?.permissions ?? []), ...(account?.permissionOverrides ?? [])])].sort(), policy = protectedApprovalPolicy(state);
  if (!account || account.status.toLowerCase() !== "active" || !role || role.id !== account.roleId || account.id !== actorId ||
      actorId === requesterId || !permissions.includes("execution:approve") || !policy.approverRoleIds.includes(role.id) ||
      typeof user !== "string" && (user.roleId !== role.id || user.role !== role.name || user.departmentId !== account.departmentId ||
        hash([...new Set(user.permissions)].sort()) !== hash(permissions)))
    protectedApprovalDenied("Current independent approver authority is required", 403);
  return { id: actorId, roleId: role.id, active: true, permissions };
}
function context(saved: ProtectedApprovalSaved, state: Readonly<RepositoryState>, services: HandlerServices,
  point: NonNullable<ReturnType<ProtectedMachine["peek"]>>): ProtectedApprovalContext {
  const workflow = state.workflows[saved.run.workflowId], snapshot = saved.run.workflowSnapshot!;
  if (!workflow || workflow.archived || workflow.publishedVersion !== snapshot.version || workflowContentHash(workflow.yaml) !== snapshot.contentHash)
    protectedApprovalDenied("The original approval publication or authored workflow changed");
  const node = saved.plan.ir.root.nodes.find(item => item.id === point.nodeId);
  if (!point.valid || point.kind !== "action" || node?.kind !== "action" || node.effectClass === "read" || !node.capability.admission)
    protectedApprovalDenied("The current invocation is not an exact governed effect");
  const { session } = boundMcpConnection(services, node.capability.admission.connectionId);
  if (session.available === false || session.requiresReviewedRevision !== true || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding)
    protectedApprovalDenied("The original reviewed ERP connection is unavailable");
  return { node, point, ledger: saved.ledger.snapshot(), connectionBinding: session.admissionBinding, policy: protectedApprovalPolicy(state) };
}
/** Capture the exact owned cursor, compiled effect and current selected session.
 * There is no caller-supplied point, policy, pin or connection parameter. */
export function currentProtectedApprovalContext(saved: ProtectedApprovalSaved, state: Readonly<RepositoryState>, services: HandlerServices): ProtectedApprovalContext {
  const point = saved.machine.peek(); if (!point) protectedApprovalDenied("The effect invocation is no longer current");
  return context(saved, state, services, point);
}
/** Historical identity only. The complete journal/cursor was authenticated by
 * restore before replay; this context does not permit another effect call. */
export function originalProtectedApprovalContext(saved: ProtectedApprovalSaved, state: Readonly<RepositoryState>, services: HandlerServices,
  record: ProtectedApprovalRecord): ProtectedApprovalContext {
  const machine = new ProtectedMachine(saved.plan.machine, saved.run.workflowSnapshot!.input), receipts = saved.ledger.snapshot().receipts; machine.peek();
  for (let at = 0; at < record.binding.sequence; at++) {
    const result = receipts[String(at)]!.result;
    if (result.kind === "accept") machine.accept(result.output); else machine.fail(result.fault);
    machine.peek();
  }
  const point = machine.peek(); if (!point) protectedApprovalDenied("The original approval invocation cannot be reproduced");
  return context(saved, state, services, point);
}
export function assertCurrentProtectedApprovalFacts(state: Readonly<RepositoryState>, services: HandlerServices, executionId: string,
  record: ProtectedApprovalRecord, now: number): void {
  const saved = assertProtectedJobCurrent(state, services, executionId), expected = currentProtectedApprovalContext(saved, state, services);
  assertProtectedApprovalContext(expected, record, now);
  if (record.decision) {
    const actor = protectedApprover(state, record.decision.actorId, record.binding.requesterId);
    if (actor.roleId !== record.decision.roleId) protectedApprovalDenied("Recorded approver authority changed");
  }
}
