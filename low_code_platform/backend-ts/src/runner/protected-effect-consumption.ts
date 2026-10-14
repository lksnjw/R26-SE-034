import type { HandlerServices } from "../http/handlers/common.js";
import { ownedProtectedEffectContext } from "./protected-effect-context.js";
import { consumeProtectedApprovalRecord } from "./protected-approval-protocol.js";
import { sealProtectedCursor, type ProtectedJobOwner } from "./protected-job-state.js";
import { appendExecutionEvent } from "./read-checkpoints.js";

export type ProtectedEffectConsumptionTicket = Readonly<{ profile: "protected-effect-consumption-ticket/v1" }>;
const tickets = new WeakMap<ProtectedEffectConsumptionTicket, { services: HandlerServices; executionId: string; owner: ProtectedJobOwner;
  approvalId: string; definition: ReturnType<typeof ownedProtectedEffectContext>["definition"]; args: Record<string, unknown>;
  identity: ReturnType<typeof ownedProtectedEffectContext>["identity"] }>();

/** One atomic owned transition. A ticket exists only after COMMIT returns and
 * can mint at most one SDK permit. Reopening entered intent never makes one. */
export async function enterOwnedProtectedEffect(services: HandlerServices, executionId: string, owner: ProtectedJobOwner,
  assertDispatch: () => void): Promise<ProtectedEffectConsumptionTicket> {
  const proof = await services.repository.mutateExecution(executionId, state => {
    assertDispatch();
    const value = ownedProtectedEffectContext(state, services, executionId, owner, "APPROVED"), { saved, context, record, reviewer } = value;
    const consumed = consumeProtectedApprovalRecord(context, record, reviewer, Date.now());
    saved.ledger.dispatchIntent(saved.machine, record.binding.intentKey, context.point.arguments, owner.epoch);
    saved.run.protectedInvocationSecret = saved.ledger.snapshot();
    saved.run.protectedApprovalSecret!.records[record.id] = consumed;
    delete saved.run.pendingApproval;
    const timeline = state.timelines[executionId]?.find(item => item.approvalId === record.id);
    if (timeline) Object.assign(timeline, { status: "RUNNING", outcome: "APPROVAL_CONSUMED", consumedAt: consumed.consumption!.consumedAt });
    sealProtectedCursor(services, state, saved.run, saved.machine);
    appendExecutionEvent(state, saved.run, "approval.consumed", { approvalId: record.id, version: consumed.version, invocationId: context.point.invocationId }, context.point.nodeId, context.point.invocationId);
    appendExecutionEvent(state, saved.run, "node.protected_dispatch_intent", { invocationId: context.point.invocationId, approvalId: record.id }, context.point.nodeId, context.point.invocationId);
    return { executionId, owner: { ...owner }, approvalId: record.id, definition: structuredClone(value.definition),
      args: structuredClone(context.point.arguments) as Record<string, unknown>, identity: value.identity };
  });
  const ticket = Object.freeze({ profile: "protected-effect-consumption-ticket/v1" as const }); tickets.set(ticket, { ...proof, services }); return ticket;
}
/** Internal one-use proof transfer. JSON and callbacks cannot mint a ticket. */
export function consumeProtectedEffectConsumptionTicket(ticket: ProtectedEffectConsumptionTicket) {
  const proof = tickets.get(ticket); tickets.delete(ticket);
  if (!proof) throw new Error("Protected permit requires a freshly acknowledged owned consumption ticket");
  return proof;
}
