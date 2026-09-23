import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import type { Execution } from "./store.js";
import { assertProtectedJobShape } from "./protected-job-record.js";

export const protectedJournalHash = (value: unknown): string => resolvedParameterHashBytes(canonicalJSONBytes(value));
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/), id = z.string().min(1).max(256);
const nodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), sequence = z.number().int().min(0).max(4999);
const iterations = z.array(z.object({ loopId: nodeId, index: z.number().int().min(0).max(99) }).strict()).max(8);
export const protectedLedgerIdentitySchema = z.object({ executionId: id, workflowId: id, actorId: id, roleId: id, admittedRole: id,
  sourceHash: sha, operationHash: sha, machineHash: sha, inputHash: sha }).strict();
export type ProtectedLedgerIdentity = z.infer<typeof protectedLedgerIdentitySchema>;
export const protectedDispatchComponentSchema = z.union([
  z.object({ kind: z.literal("node") }).strict(),
  z.object({ kind: z.literal("agent-model"), round: z.number().int().min(0).max(15) }).strict(),
  z.object({ kind: z.literal("agent-tool"), round: z.number().int().min(0).max(15), callIndex: z.number().int().min(0).max(15) }).strict(),
  z.object({ kind: z.literal("report-page"), mode: z.enum(["page", "cursor"]), ordinal: z.number().int().min(0).max(99) }).strict(),
]);
export type ProtectedDispatchComponent = z.infer<typeof protectedDispatchComponentSchema>;
const businessFailure = z.object({ profile: z.literal("reviewed-read-business-failure/v1"), code: z.literal("ERP_RESOURCE_NOT_FOUND"), toolId: id, contractHash: sha,
  admissionPin: z.object({ connectionId: id, capabilityId: id, revisionId: id, admissionVersion: z.number().int().positive(), contractHash: sha }).strict() }).strict();
const boundary = z.object({ kind: z.enum(["action", "condition", "skip", "merge", "return", "collection-start", "collection-item", "collection-complete",
  "protected-start", "protected-select", "protected-complete"]), nodeId, invocationId: z.string().min(1).max(1100), iterations,
  scope: z.enum(["invocation", "unentered-template"]) }).strict();
const intent = z.object({ profile: z.literal("protected-intent/v1"), key: sha, id, sequence, boundary,
  purpose: z.enum(["read", "effect", "analysis", "agent-model", "agent-tool", "report-page"]), component: protectedDispatchComponentSchema,
  epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1), argumentHash: sha,
  state: z.enum(["PREPARING", "DISPATCH_INTENT", "ACKNOWLEDGED", "UNKNOWN"]),
  result: z.union([z.object({ kind: z.literal("OUTPUT"), hash: sha }).strict(),
    z.object({ kind: z.literal("READ_ERROR"), hash: sha, businessFailureHash: sha, businessFailure }).strict()]).optional() }).strict();
export type ProtectedInvocationIntent = z.infer<typeof intent>;
export const protectedBoundaryResultSchema = z.union([
  z.object({ kind: z.literal("accept"), output: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal("business-read-failure"), fault: z.object({ code: z.literal("ERP_RESOURCE_NOT_FOUND"), failedNodeId: nodeId,
    failedInvocationId: z.string().min(1).max(1100) }).strict(), intentKey: sha, businessFailureHash: sha }).strict(),
]);
export type ProtectedBoundaryResult = z.infer<typeof protectedBoundaryResultSchema>;
const receipt = z.object({ profile: z.literal("protected-boundary-receipt/v1"), sequence, boundary, pointHash: sha,
  beforeMachineHash: sha, afterMachineHash: sha, previousHash: sha, hash: sha, intentKeys: z.array(sha).max(512), result: protectedBoundaryResultSchema }).strict();
export type ProtectedBoundaryReceipt = z.infer<typeof receipt>;
const ledgerSchema = z.object({ profile: z.literal("protected-invocation-ledger/v1"), identity: protectedLedgerIdentitySchema,
  initialMachineHash: sha, machineHash: sha, head: sha, nextSequence: z.number().int().min(0).max(5000),
  intentCount: z.number().int().min(0).max(20000), state: z.enum(["OPEN", "RECOVERY_REQUIRED", "FINISHED"]),
  intents: z.record(sha, intent), receipts: z.record(z.string().regex(/^(0|[1-9]\d*)$/), receipt) }).strict();
export type ProtectedInvocationLedgerSnapshot = z.infer<typeof ledgerSchema>;

/** Original immutable identity and exact sub-call, never lease/epoch/attempt
 * nonce. This logical key is DATA, not a broker permit or delivery proof. */
export function protectedInvocationOperationKey(identity: ProtectedLedgerIdentity, invocationId: string, component: ProtectedDispatchComponent): string {
  assertBoundedFiniteJSON({ identity, invocationId, component });
  protectedLedgerIdentitySchema.parse(identity); protectedDispatchComponentSchema.parse(component);
  if (typeof invocationId !== "string" || invocationId.length < 1 || invocationId.length > 1100) throw new Error("Invalid protected invocation operation address");
  return protectedJournalHash({ domain: "lcwe/protected-invocation-operation/v1", identity, invocationId, component });
}
export const protectedLedgerGenesis = (identity: ProtectedLedgerIdentity, initialMachineHash: string) =>
  protectedJournalHash({ domain: "lcwe/protected-invocation-genesis/v1", identity, initialMachineHash });

/** Complete normalized DATA consistency. Hashes are not authentication; the
 * private continuation/owned worker must prove confirmed origin and authority. */
export function assertProtectedInvocationLedger(value: unknown, executionId: string): asserts value is ProtectedInvocationLedgerSnapshot {
  assertBoundedFiniteJSON(value, 32_000_000, 2_000_000);
  const data = ledgerSchema.parse(value);
  if (data.identity.executionId !== executionId || Object.keys(data.intents).length !== data.intentCount || Object.keys(data.receipts).length !== data.nextSequence)
    throw new Error("Protected invocation ledger identity or complete record counts changed");
  let head = protectedLedgerGenesis(data.identity, data.initialMachineHash), machineHash = data.initialMachineHash;
  const consumed = new Set<string>();
  const sequenceKeys = new Map<number, string[]>();
  for (const item of Object.values(data.intents)) {
    const keys = sequenceKeys.get(item.sequence) ?? []; keys.push(item.key); sequenceKeys.set(item.sequence, keys);
  }
  for (let at = 0; at < data.nextSequence; at++) {
    const row = data.receipts[String(at)];
    if (!row || row.sequence !== at || row.previousHash !== head || row.beforeMachineHash !== machineHash || new Set(row.intentKeys).size !== row.intentKeys.length)
      throw new Error("Protected invocation receipt chain is missing or reordered");
    const { hash, ...body } = row;
    if (hash !== protectedJournalHash(body)) throw new Error("Protected invocation receipt hash changed");
    for (const key of row.intentKeys) {
      const item = data.intents[key];
      if (!item || item.state !== "ACKNOWLEDGED" || item.sequence !== at || protectedJournalHash(item.boundary) !== protectedJournalHash(row.boundary) ||
          consumed.has(key)) throw new Error("Protected receipt reused a foreign or unacknowledged intent");
      consumed.add(key);
    }
    const expected = (sequenceKeys.get(at) ?? []).sort();
    if (protectedJournalHash(expected) !== protectedJournalHash([...row.intentKeys].sort())) throw new Error("Protected receipt omits invocation sub-calls");
    if (row.boundary.kind === "action") {
      if (!row.intentKeys.length) throw new Error("Protected action receipt lacks acknowledged intents");
      if (row.result.kind === "accept") {
        if (!Object.hasOwn(row.result, "output") || row.intentKeys.some(key => data.intents[key]!.result?.kind !== "OUTPUT") ||
            !row.intentKeys.some(key => data.intents[key]!.result?.hash === protectedJournalHash(row.result.kind === "accept" ? row.result.output : null)))
          throw new Error("Protected action receipt differs from acknowledged outputs");
      } else {
        const failed = data.intents[row.result.intentKey]?.result;
        if (!row.intentKeys.includes(row.result.intentKey) || failed?.kind !== "READ_ERROR" || failed.hash !== protectedJournalHash(row.result.fault) ||
            failed.businessFailureHash !== row.result.businessFailureHash || row.result.fault.failedNodeId !== row.boundary.nodeId ||
            row.result.fault.failedInvocationId !== row.boundary.invocationId) throw new Error("Protected failure receipt belongs to another invocation");
      }
    } else if (row.intentKeys.length || row.result.kind !== "accept") throw new Error("Protected control receipt cannot carry dispatch/failure evidence");
    head = hash; machineHash = row.afterMachineHash;
  }
  if (head !== data.head || machineHash !== data.machineHash) throw new Error("Protected invocation ledger head differs from complete receipts");
  for (const [key, item] of Object.entries(data.intents)) {
    if (key !== item.key || key !== protectedInvocationOperationKey(data.identity, item.boundary.invocationId, item.component) || item.boundary.kind !== "action" || item.boundary.scope !== "invocation" ||
        item.sequence > data.nextSequence || item.sequence < data.nextSequence && !consumed.has(key) ||
        (item.state === "ACKNOWLEDGED") !== !!item.result ||
        item.result?.kind === "READ_ERROR" && !["read", "agent-tool", "report-page"].includes(item.purpose) ||
        (["agent-model", "agent-tool", "report-page"].includes(item.purpose) ? item.component.kind !== item.purpose : item.component.kind !== "node"))
      throw new Error("Protected invocation intent identity, scope or lifecycle changed");
    if (item.result?.kind === "READ_ERROR" && (item.result.businessFailureHash !== protectedJournalHash(item.result.businessFailure) ||
        item.result.businessFailure.contractHash !== item.result.businessFailure.admissionPin.contractHash)) throw new Error("Protected business failure contract or private evidence changed");
    if (item.state === "UNKNOWN" && data.state !== "RECOVERY_REQUIRED") throw new Error("Unknown protected invocation cannot remain runnable");
  }
  if (data.state === "FINISHED" && Object.values(data.intents).some(item => !consumed.has(item.key))) throw new Error("Finished protected ledger has pending invocations");
}

export function assertProtectedInvocationExecution(run: Execution): void {
  assertProtectedJobShape(run);
  if (!Object.hasOwn(run, "protectedInvocationSecret")) return;
  assertProtectedInvocationLedger(run.protectedInvocationSecret, run.id);
  const identity = run.protectedInvocationSecret!.identity;
  if (identity.workflowId !== run.workflowId || identity.actorId !== run.startedBy.id ||
      run.workflowSnapshot && (identity.sourceHash !== run.workflowSnapshot.contentHash || identity.inputHash !== protectedJournalHash(run.workflowSnapshot.input) ||
        run.workflowSnapshot.operationCompilation && identity.operationHash !== run.workflowSnapshot.operationCompilation.semanticHash) || Object.hasOwn(run, "operationSecret"))
    throw new Error("Protected invocation journal has foreign execution/source or legacy operation ownership");
}
