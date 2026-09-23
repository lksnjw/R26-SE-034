import type { OperationToolNode } from "../workflows/compiled-read.js";
import type { ProtectedMachinePoint } from "../workflows/protected-machine-state.js";
import type { ProtectedInvocationLedgerSnapshot } from "../repository/protected-invocation-records.js";
import { protectedJournalHash as hash, protectedInvocationOperationKey, assertProtectedInvocationLedger } from "../repository/protected-invocation-records.js";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { protectedApprovalRecordSchema, protectedApprovalPolicySchema, protectedApprovalCommandSchema, protectedApprovalReviewHash, protectedApprovalDecisionFingerprint, assertProtectedApprovalRecord,
  type ProtectedApprovalRecord } from "../repository/protected-approval-records.js";
import type { RuntimeApprovalPolicy } from "./runtime-approvals.js";

export type ProtectedApprovalContext = { node: OperationToolNode; point: ProtectedMachinePoint; ledger: ProtectedInvocationLedgerSnapshot;
  connectionBinding: string; policy: RuntimeApprovalPolicy };
export type ProtectedApproverData = { id: string; roleId: string; active: boolean; permissions: string[] };
const time = (now: number) => { if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error("Invalid protected approval clock"); return new Date(now).toISOString(); };
function facts(context: ProtectedApprovalContext) {
  assertBoundedFiniteJSON(context); const { node, point, ledger, policy } = context;
  protectedApprovalPolicySchema.parse(policy);
  assertProtectedInvocationLedger(ledger, ledger.identity.executionId);
  const key = protectedInvocationOperationKey(ledger.identity, point.invocationId, { kind: "node" }), intent = ledger.intents[key];
  if (node.kind !== "action" || !["write", "notification"].includes(node.effectClass) || node.id !== point.nodeId || !node.capability.admission ||
      node.capability.contractHash !== node.capability.admission.contractHash || !point.valid || point.kind !== "action" || point.scope !== "invocation" ||
      ledger.state !== "OPEN" || point.sequence !== ledger.nextSequence || !intent || intent.purpose !== "effect" || intent.component.kind !== "node" ||
      intent.sequence !== point.sequence || intent.argumentHash !== hash(point.arguments) || intent.boundary.nodeId !== point.nodeId ||
      intent.boundary.invocationId !== point.invocationId || hash(intent.boundary.iterations) !== hash(point.iterations) ||
      !policy.enabled || policy.separationOfDuties !== true || !Number.isSafeInteger(policy.revision) || policy.revision < 1 ||
      !Number.isSafeInteger(policy.ttlSeconds) || policy.ttlSeconds < 60 || policy.ttlSeconds > 86400 || !policy.approverRoleIds.length ||
      new Set(policy.approverRoleIds).size !== policy.approverRoleIds.length) throw new Error("Protected approval requires exact effect preparation and independent policy");
  return { intent, binding: { executionId: ledger.identity.executionId, workflowId: ledger.identity.workflowId, identityHash: hash(ledger.identity),
    nodeId: point.nodeId, invocationId: point.invocationId, iterations: structuredClone(point.iterations), sequence: point.sequence, pointHash: hash(point), nodeHash: hash(node),
    intentKey: key, intentId: intent.id, argumentHash: intent.argumentHash, requesterId: ledger.identity.actorId, requesterRoleId: ledger.identity.roleId,
    requestEpoch: intent.epoch, policyHash: hash(policy), connectionBinding: context.connectionBinding, admission: structuredClone(node.capability.admission) } };
}
function current(context: ProtectedApprovalContext, value: ProtectedApprovalRecord, now: number) {
  assertProtectedApprovalRecord(value, context.ledger);
  const record = protectedApprovalRecordSchema.parse(value), expected = facts(context); time(now);
  const binding = { ...expected.binding, requestEpoch: record.binding.requestEpoch };
  if (hash(binding) !== hash(record.binding) || expected.intent.epoch < record.binding.requestEpoch || record.reviewHash !== protectedApprovalReviewHash(record) ||
      hash(record.arguments) !== hash(context.point.arguments) || now < Date.parse(record.requestedAt) || now >= Date.parse(record.expiresAt) ||
      expected.intent.state !== "PREPARING") throw new Error("Protected approval facts, policy, generation or original deadline changed");
  return { record, intent: expected.intent };
}
function independent(context: ProtectedApprovalContext, actor: ProtectedApproverData, requesterId: string) {
  if (!actor.active || actor.id === requesterId || !actor.id || !actor.roleId || !actor.permissions.includes("execution:approve") ||
      !context.policy.approverRoleIds.includes(actor.roleId)) throw new Error("Protected approval requires a current independent approver");
}

/** Pure DATA constructors/transitions only. Callers cannot mint a confirmed
 * human decision, owned wait, commit, lease, current authority or SDK permit.
 * Future server adapters must capture context/actor from authoritative state. */
export function createProtectedApprovalRecord(context: ProtectedApprovalContext, id: string, reason: string, now: number): ProtectedApprovalRecord {
  const { binding, intent } = facts(context), args = context.point.arguments;
  assertBoundedFiniteJSON(args, 64_000);
  if (intent.state !== "PREPARING" || !args || typeof args !== "object" || Array.isArray(args) || hash(withoutSecretFields(args)) !== hash(args))
    throw new Error("Protected approval cannot hide arguments or request an entered effect");
  const record = protectedApprovalRecordSchema.parse({ profile: "protected-approval/v1", id, version: 1, state: "PENDING", binding,
    arguments: structuredClone(args), policy: structuredClone(context.policy), reason, requestedAt: time(now), expiresAt: time(now + context.policy.ttlSeconds * 1000), reviewHash: hash({}) });
  record.reviewHash = protectedApprovalReviewHash(record); return record;
}
export function decideProtectedApprovalRecord(context: ProtectedApprovalContext, value: ProtectedApprovalRecord, raw: unknown,
  actor: ProtectedApproverData, outcome: "APPROVED" | "REJECTED", now: number): ProtectedApprovalRecord {
  const command = protectedApprovalCommandSchema.parse(raw), parsed = protectedApprovalRecordSchema.parse(value);
  assertProtectedApprovalRecord(parsed, context.ledger);
  independent(context, actor, parsed.binding.requesterId);
  const fingerprint = protectedApprovalDecisionFingerprint(command, actor.id, actor.roleId, outcome);
  if (parsed.decision) {
    if (parsed.decision.fingerprint !== fingerprint || command.approvalId !== parsed.id || command.reviewHash !== parsed.reviewHash ||
        parsed.binding.pointHash !== hash(context.point) || parsed.binding.nodeHash !== hash(context.node) ||
        parsed.binding.connectionBinding !== context.connectionBinding || hash(context.point.arguments) !== parsed.binding.argumentHash)
      throw new Error("Protected approval has a different recorded decision");
    return structuredClone(parsed); // Historical replay never renews a deadline or dispatches.
  }
  const { record } = current(context, parsed, now);
  if (record.state !== "PENDING" || command.approvalId !== record.id || command.reviewHash !== record.reviewHash || command.baseVersion !== record.version)
    throw new Error("Protected approval review or version changed");
  return protectedApprovalRecordSchema.parse({ ...record, version: record.version + 1, state: outcome,
    decision: { actorId: actor.id, roleId: actor.roleId, outcome, decisionKey: command.decisionKey, fingerprint, note: command.note, decidedAt: time(now) } });
}
/** Provisional DATA consumption must be committed together with the matching
 * ledger dispatch intent. Persisting it against PREPARING is refused by the
 * complete records validator; this transition does not permit SDK entry. */
export function consumeProtectedApprovalRecord(context: ProtectedApprovalContext, value: ProtectedApprovalRecord, actor: ProtectedApproverData, now: number): ProtectedApprovalRecord {
  const { record, intent } = current(context, value, now);
  independent(context, actor, record.binding.requesterId);
  if (record.state !== "APPROVED" || record.decision?.outcome !== "APPROVED" || record.decision.actorId !== actor.id || record.decision.roleId !== actor.roleId ||
      intent.state !== "PREPARING" || now < Date.parse(record.decision.decidedAt)) throw new Error("Protected approval cannot consume a changed or repeated effect");
  return protectedApprovalRecordSchema.parse({ ...record, version: record.version + 1, state: "CONSUMED",
    consumption: { intentId: intent.id, epoch: intent.epoch, consumedAt: time(now) } });
}
export function expireProtectedApprovalRecord(value: ProtectedApprovalRecord, ledger: ProtectedInvocationLedgerSnapshot, now: number): ProtectedApprovalRecord {
  assertProtectedApprovalRecord(value, ledger); time(now);
  if (!["PENDING", "APPROVED"].includes(value.state) || now < Date.parse(value.expiresAt)) throw new Error("Protected approval cannot expire before its original deadline or after consumption");
  return protectedApprovalRecordSchema.parse({ ...value, version: value.version + 1, state: "EXPIRED", expiredAt: time(now) });
}
