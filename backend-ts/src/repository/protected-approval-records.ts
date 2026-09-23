import { z } from "zod";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { protectedJournalHash as hash, protectedInvocationOperationKey, assertProtectedInvocationLedger,
  type ProtectedInvocationLedgerSnapshot } from "./protected-invocation-records.js";

const id = z.string().min(1).max(256), sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const address = z.string().min(1).max(1100), epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const date = z.string().datetime().max(32);
export const protectedApprovalPolicySchema = z.object({ profile: z.literal("runtime-approval-policy/v1"), revision: z.number().int().positive(), enabled: z.literal(true),
  approverRoleIds: z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length), ttlSeconds: z.number().int().min(60).max(86400), separationOfDuties: z.literal(true) }).strict();
const binding = z.object({ executionId: id, workflowId: id, identityHash: sha, nodeId: id, invocationId: address,
  iterations: z.array(z.object({ loopId: id, index: z.number().int().min(0).max(99) }).strict()).max(8),
  sequence: z.number().int().min(0).max(4999), pointHash: sha, nodeHash: sha, intentKey: sha, intentId: id,
  argumentHash: sha, requesterId: id, requesterRoleId: id, requestEpoch: epoch, policyHash: sha,
  connectionBinding: z.string().regex(/^[a-f0-9]{64}$/),
  admission: z.object({ connectionId: id, capabilityId: id, revisionId: id, admissionVersion: z.number().int().positive(), contractHash: sha }).strict()
}).strict();
export const protectedApprovalCommandSchema = z.object({ approvalId: id, baseVersion: z.number().int().positive(), reviewHash: sha,
  decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), note: z.string().max(2000).default("") }).strict();
export type ProtectedApprovalCommand = z.infer<typeof protectedApprovalCommandSchema>;
export const protectedApprovalRecordSchema = z.object({ profile: z.literal("protected-approval/v1"), id, version: z.number().int().positive(),
  state: z.enum(["PENDING", "APPROVED", "REJECTED", "CONSUMED", "EXPIRED"]), binding,
  arguments: z.record(z.string(), z.unknown()), policy: protectedApprovalPolicySchema, reason: z.string().trim().min(1).max(2000), requestedAt: date, expiresAt: date, reviewHash: sha,
  decision: z.object({ actorId: id, roleId: id, decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), fingerprint: sha,
    outcome: z.enum(["APPROVED", "REJECTED"]), note: z.string().max(2000), decidedAt: date }).strict().optional(),
  consumption: z.object({ intentId: id, epoch, consumedAt: date }).strict().optional(), expiredAt: date.optional()
}).strict();
export type ProtectedApprovalRecord = z.infer<typeof protectedApprovalRecordSchema>;
const schema = z.object({ profile: z.literal("protected-approvals/v1"), count: z.number().int().min(0).max(5000),
  activeId: id.optional(), records: z.record(id, protectedApprovalRecordSchema) }).strict();
export type ProtectedApprovalRecords = z.infer<typeof schema>;
export const emptyProtectedApprovalRecords = (): ProtectedApprovalRecords => ({ profile: "protected-approvals/v1", count: 0, records: {} });
export const protectedApprovalReviewHash = (record: ProtectedApprovalRecord) => hash({ domain: "lcwe/protected-approval-review/v1", id: record.id,
  binding: record.binding, arguments: record.arguments, policy: record.policy, reason: record.reason, requestedAt: record.requestedAt, expiresAt: record.expiresAt });
export const protectedApprovalDecisionFingerprint = (command: ProtectedApprovalCommand, actorId: string, roleId: string, outcome: "APPROVED" | "REJECTED") =>
  hash({ domain: "lcwe/protected-approval-decision/v1", command, actorId, roleId, outcome });

/** Strict private DATA consistency, not current authority, a genuine human
 * decision, confirmed commit or SDK permission. Owned adapters must establish
 * those independently and authenticate the complete journal with the cursor. */
export function assertProtectedApprovalRecords(value: unknown, ledger: ProtectedInvocationLedgerSnapshot): asserts value is ProtectedApprovalRecords {
  assertBoundedFiniteJSON(value, 32_000_000, 2_000_000); assertProtectedInvocationLedger(ledger, ledger.identity.executionId);
  const data = schema.parse(value), keys = new Set<string>(), invocations = new Set<string>();
  if (Object.keys(data.records).length !== data.count || (data.count > 0) !== !!data.activeId || data.activeId && !data.records[data.activeId])
    throw new Error("Protected approval counts or active owner changed");
  let latest = -1;
  for (const [recordId, record] of Object.entries(data.records)) {
    assertRecord(record, ledger);
    const b = record.binding;
    if (recordId !== record.id || keys.has(b.intentKey) || invocations.has(b.invocationId)) throw new Error("Protected approval reuses a record or invocation");
    keys.add(b.intentKey); invocations.add(b.invocationId); latest = Math.max(latest, b.sequence);
  }
  if (data.activeId && data.records[data.activeId]!.binding.sequence !== latest) throw new Error("Protected approval active owner is not the latest invocation");
  for (const intent of Object.values(ledger.intents)) if (intent.purpose === "effect" && !keys.has(intent.key)) throw new Error("Protected effect lacks its complete approval record");
}
export function assertProtectedApprovalRecord(value: unknown, ledger: ProtectedInvocationLedgerSnapshot): asserts value is ProtectedApprovalRecord {
  assertProtectedInvocationLedger(ledger, ledger.identity.executionId);
  assertRecord(value, ledger);
}
function assertRecord(value: unknown, ledger: ProtectedInvocationLedgerSnapshot): void {
    assertBoundedFiniteJSON(value, 128_000);
    const record = protectedApprovalRecordSchema.parse(value);
    assertBoundedFiniteJSON(record, 128_000); assertBoundedFiniteJSON(record.arguments, 64_000);
    const b = record.binding, intent = ledger.intents[b.intentKey], requested = Date.parse(record.requestedAt), expiry = Date.parse(record.expiresAt);
    if (b.executionId !== ledger.identity.executionId || b.workflowId !== ledger.identity.workflowId || b.identityHash !== hash(ledger.identity) ||
        b.requesterId !== ledger.identity.actorId || b.requesterRoleId !== ledger.identity.roleId || b.sequence > ledger.nextSequence ||
        b.intentKey !== protectedInvocationOperationKey(ledger.identity, b.invocationId, { kind: "node" }) ||
        !intent || intent.id !== b.intentId || intent.purpose !== "effect" || intent.component.kind !== "node" || intent.sequence !== b.sequence || intent.epoch < b.requestEpoch ||
        intent.argumentHash !== b.argumentHash || hash(record.arguments) !== b.argumentHash || hash(withoutSecretFields(record.arguments)) !== b.argumentHash ||
        intent.boundary.nodeId !== b.nodeId || intent.boundary.invocationId !== b.invocationId || hash(intent.boundary.iterations) !== hash(b.iterations) ||
        record.reviewHash !== protectedApprovalReviewHash(record) || hash(record.policy) !== b.policyHash || expiry - requested !== record.policy.ttlSeconds * 1000)
      throw new Error("Protected approval differs from its exact original effect invocation or review");
    const decision = record.decision, consumed = record.consumption;
    const version = 1 + Number(!!decision) + Number(!!consumed || !!record.expiredAt);
    if (record.version !== version || (record.state === "CONSUMED") !== !!consumed || (record.state === "EXPIRED") !== !!record.expiredAt ||
        ["APPROVED", "CONSUMED"].includes(record.state) && decision?.outcome !== "APPROVED" || record.state === "REJECTED" && decision?.outcome !== "REJECTED" ||
        record.state === "PENDING" && !!decision || record.state === "EXPIRED" && decision?.outcome === "REJECTED")
      throw new Error("Protected approval decision lifecycle changed");
    if (decision && (decision.actorId === b.requesterId || !record.policy.approverRoleIds.includes(decision.roleId) || Date.parse(decision.decidedAt) < requested || Date.parse(decision.decidedAt) >= expiry ||
        decision.fingerprint !== protectedApprovalDecisionFingerprint({ approvalId: record.id, baseVersion: 1, reviewHash: record.reviewHash,
          decisionKey: decision.decisionKey, note: decision.note }, decision.actorId, decision.roleId, decision.outcome)))
      throw new Error("Protected approval has a foreign, self or expired decision");
    if (record.expiredAt && Date.parse(record.expiredAt) < expiry) throw new Error("Protected approval expired before its original deadline");
    if (consumed ? !["DISPATCH_INTENT", "ACKNOWLEDGED", "UNKNOWN"].includes(intent.state) || consumed.intentId !== intent.id || consumed.epoch !== intent.epoch ||
        Date.parse(consumed.consumedAt) < Date.parse(decision!.decidedAt) || Date.parse(consumed.consumedAt) >= expiry : intent.state !== "PREPARING" || b.sequence < ledger.nextSequence)
      throw new Error("Protected approval consumption differs from its exact effect intent");
    if (b.sequence < ledger.nextSequence && (record.state !== "CONSUMED" || intent.state !== "ACKNOWLEDGED" || intent.result?.kind !== "OUTPUT"))
      throw new Error("Advanced protected effect lacks its consumed decision and acknowledgement");
}
