import { canonicalJSONBytes } from "../core/canonical-json.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import { assertConsumedRuntimeApproval } from "../runner/runtime-approvals.js";
import type { DispatchIdentity } from "./registry.js";

export type OperationDispatchPermit = Readonly<{ profile: "operation-sdk-permit/v1" }>;
const proofs = new WeakMap<OperationDispatchPermit, { contractHash: string; bytes: Buffer; identity: Buffer; assertCurrent: () => void; dispose: () => void }>();
/** Trusted server-only producer. Persisted consumed approval + intent must
 * already be acknowledged. JSON, callbacks or validation tokens cannot forge it. */
export async function issueOperationDispatchPermit(repository: Repository, executionId: string, intentId: string, definition: ToolDefinition,
  args: Record<string, unknown>, identity: DispatchIdentity, assertCurrent: () => void): Promise<OperationDispatchPermit> {
  const bytes = canonicalJSONBytes(args), contractHash = capabilityContractHash(definition);
  let valid = false, leaseId = "", expiresAt = 0;
  const check = (state: Readonly<RepositoryState>) => {
    assertConsumedRuntimeApproval(state as RepositoryState, executionId, intentId);
    const run = state.executions[executionId]!, record = run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!, lease = run.operationSecret?.lease;
    if (!lease || run.operationSecret?.state !== "CLAIMED" || lease.expiresAt <= Date.now() || leaseId && lease.id !== leaseId || record.binding.contractHash !== contractHash ||
        identity.userId !== record.binding.requesterId || identity.localRole !== state.roles[record.binding.requesterRoleId]?.name || !bytes.equals(canonicalJSONBytes(record.arguments)))
      throw new Error("Operation permit differs from its exact current approved claim");
    leaseId = lease.id; expiresAt = Math.min(lease.expiresAt, Date.parse(record.expiresAt)); valid = true;
  };
  await repository.readAuthoritative(state => {
    check(state);
    assertCurrent();
  });
  const unsubscribe = repository.observeCommits({ committed: state => { try { check(state); } catch { valid = false; } }, unavailable: () => { valid = false; } });
  // Recheck after installing the observer so no acknowledged revocation can
  // fall into the gap between the initial read and subscription.
  try { await repository.readAuthoritative(check); } catch (error) { unsubscribe(); throw error; }
  const deadline = Date.now() + 30_000;
  const timer = setTimeout(() => { valid = false; unsubscribe(); }, 30_000); timer.unref();
  const dispose = () => { valid = false; clearTimeout(timer); unsubscribe(); };
  const permit = Object.freeze({ profile: "operation-sdk-permit/v1" as const });
  proofs.set(permit, { contractHash, bytes, identity: canonicalJSONBytes(identity), dispose, assertCurrent: () => {
    repository.assertAuthority(); if (!valid || Date.now() >= Math.min(deadline, expiresAt)) throw new Error("Operation permit is fenced or expired"); assertCurrent();
  } }); return permit;
}
export function consumeOperationDispatchPermit(permit: OperationDispatchPermit | undefined, definition: ToolDefinition, args: Uint8Array, identity: DispatchIdentity): void {
  const proof = permit && proofs.get(permit);
  try {
    if (!proof || proof.contractHash !== capabilityContractHash(definition) || !proof.bytes.equals(args) || !proof.identity.equals(canonicalJSONBytes(identity)))
      throw new Error("ERP operation requires an authentic exact consumed-approval SDK permit");
    proof.assertCurrent();
  } finally { if (permit) retireOperationDispatchPermit(permit); }
}
/** Release observers even when admission/cancellation prevents SDK entry. */
export function retireOperationDispatchPermit(permit: OperationDispatchPermit): void {
  const proof = proofs.get(permit); proofs.delete(permit); proof?.dispose();
}
