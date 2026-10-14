import { canonicalJSONBytes } from "../core/canonical-json.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { RepositoryState } from "../repository/store.js";
import { ownedProtectedEffectContext } from "../runner/protected-effect-context.js";
import { protectedHash as hash } from "../runner/protected-job-state.js";
import { consumeProtectedEffectConsumptionTicket, type ProtectedEffectConsumptionTicket } from "../runner/protected-effect-consumption.js";
import type { DispatchIdentity } from "./registry.js";

export type ProtectedOperationDispatchPermit = Readonly<{ profile: "protected-operation-sdk-permit/v1" }>;
const proofs = new WeakMap<ProtectedOperationDispatchPermit, { contractHash: string; bytes: Buffer; identity: Buffer; assertCurrent: () => void; dispose: () => void }>();

/** Server-only producer after an acknowledged atomic CONSUMED+intent save.
 * WeakMap identity is the authority; profile strings and supplied callbacks
 * cannot stand in for exact durable owned evidence. */
export async function issueProtectedOperationDispatchPermit(ticket: ProtectedEffectConsumptionTicket, assertCurrent: () => void): Promise<ProtectedOperationDispatchPermit> {
  const { services, executionId, owner, definition, args, identity, approvalId } = consumeProtectedEffectConsumptionTicket(ticket);
  const repository = services.repository, bytes = canonicalJSONBytes(args), contractHash = capabilityContractHash(definition), identityBytes = canonicalJSONBytes(identity);
  const validator = services.validator, gate = services.validationGate;
  let fenced = false, expiresAt = 0, expected: string | undefined, session: object | undefined, latest: Readonly<RepositoryState> | undefined;
  const check = (state: Readonly<RepositoryState>) => {
    if (fenced || services.validator !== validator || services.validationGate !== gate) throw new Error("Protected permit authority was fenced");
    const value = ownedProtectedEffectContext(state, services, executionId, owner, "CONSUMED");
    const facts = hash({ record: value.record, identity: value.identity, roleMap: value.bound.roleMap, point: value.context.point,
      intent: value.saved.ledger.snapshot().intents[value.record.binding.intentKey], generation: value.bound.session.discoveryGeneration ?? 0,
      governance: state.governancePolicy });
    if (value.record.id !== approvalId || contractHash !== capabilityContractHash(value.definition) || !bytes.equals(canonicalJSONBytes(value.context.point.arguments)) ||
        !identityBytes.equals(canonicalJSONBytes(value.identity)) || expected && facts !== expected || session && session !== value.bound.session)
      throw new Error("Protected permit differs from its exact approved claim or session");
    expected = facts; session = value.bound.session; latest = state;
    expiresAt = Math.min(value.saved.run.protectedJobSecret!.lease!.expiresAt, Date.parse(value.record.expiresAt));
    assertCurrent();
  };
  // Subscribe first: every acknowledged revocation and authority loss fences
  // this permit permanently, including changes between authoritative reads.
  const unsubscribe = repository.observeCommits({ committed: state => { try { check(state); } catch { fenced = true; } }, unavailable: () => { fenced = true; } });
  try { await repository.readAuthoritative(check); await repository.readAuthoritative(check); }
  catch (error) { fenced = true; unsubscribe(); throw error; }
  const deadline = Date.now() + 30_000, timer = setTimeout(() => { fenced = true; unsubscribe(); }, 30_000); timer.unref();
  const dispose = () => { fenced = true; clearTimeout(timer); unsubscribe(); };
  const permit = Object.freeze({ profile: "protected-operation-sdk-permit/v1" as const });
  proofs.set(permit, { contractHash, bytes, identity: identityBytes, dispose, assertCurrent: () => {
    repository.assertAuthority();
    if (fenced || !latest || Date.now() >= Math.min(deadline, expiresAt)) throw new Error("Protected permit is fenced or expired");
    check(latest);
  } });
  return permit;
}
export function isProtectedOperationDispatchPermit(permit: object | undefined): permit is ProtectedOperationDispatchPermit {
  return !!permit && proofs.has(permit as ProtectedOperationDispatchPermit);
}
export function consumeProtectedOperationDispatchPermit(permit: ProtectedOperationDispatchPermit | undefined, definition: ToolDefinition,
  args: Uint8Array, identity: DispatchIdentity): void {
  const proof = permit && proofs.get(permit);
  try {
    if (!proof || proof.contractHash !== capabilityContractHash(definition) || !proof.bytes.equals(args) || !proof.identity.equals(canonicalJSONBytes(identity)))
      throw new Error("Protected operation requires an authentic exact consumed-approval SDK permit");
    proof.assertCurrent();
  } finally { if (permit) retireProtectedOperationDispatchPermit(permit); }
}
export function retireProtectedOperationDispatchPermit(permit: ProtectedOperationDispatchPermit): void {
  const proof = proofs.get(permit); proofs.delete(permit); proof?.dispose();
}
