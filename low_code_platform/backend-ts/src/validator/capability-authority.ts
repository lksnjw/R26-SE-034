import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalJSONBytes,
  resolvedParameterHashBytes,
} from "../core/canonical-json.js";
import type { DeferredCheck, PublicValidationToken } from "../models/schemas.js";
import { workflowContentHash } from "../parser/workflow.js";
import type { DispatchIdentity } from "../tools/registry.js";

export type ValidationToken = Readonly<PublicValidationToken>;
export type DispatchCapability = Readonly<object>;

type CapabilityPayload = Readonly<{
  workflowContentHash: string;
  registryHash: string;
  stepIndex: number;
  action: string;
  resolvedParameterHash: string;
  dispatchIdentity: DispatchIdentity;
  expiresAt: number;
  proof: Buffer;
}>;

const tokenProofs = new WeakMap<object, Buffer>();
const mintedCapabilities = new WeakSet<object>();
const consumedCapabilities = new WeakSet<object>();
const capabilityPayloads = new WeakMap<object, CapabilityPayload>();
const processSigningKey = randomBytes(32);

/** Mints process-local validation authority bound to exact workflow content. */
export function mintValidationToken(
  rawYAML: string,
  registryHash: string,
  deferredChecks: DeferredCheck[],
): ValidationToken {
  const token = Object.freeze({
    workflow_content_hash: workflowContentHash(rawYAML),
    registry_hash: registryHash,
    passed_at: new Date().toISOString(),
    deferred_checks: structuredClone(deferredChecks),
  });
  tokenProofs.set(token, tokenProof(token));
  return token;
}

/** Verifies that a token is the same immutable object minted by this process. */
export function verifyValidationToken(token: ValidationToken | null): boolean {
  if (token === null || typeof token !== "object") return false;
  const proof = tokenProofs.get(token);
  if (proof === undefined) return false;
  const expected = tokenProof(token);
  return proof.byteLength === expected.byteLength && timingSafeEqual(proof, expected);
}

/** Mints one-use dispatch authority for exact parameters and actor identity. */
export function mintDispatchCapability(
  input: Omit<CapabilityPayload, "proof">,
): DispatchCapability {
  const proof = capabilityProof(input);
  const capability = Object.freeze({
    workflowContentHash: input.workflowContentHash,
    registryHash: input.registryHash,
    stepIndex: input.stepIndex,
    action: input.action,
    resolvedParameterHash: input.resolvedParameterHash,
    dispatchIdentity: Object.freeze({ ...input.dispatchIdentity }),
    expiresAt: input.expiresAt,
    proof: proof.toString("hex"),
  });
  const payload = Object.freeze({ ...input, proof: Buffer.from(proof) });
  mintedCapabilities.add(capability);
  capabilityPayloads.set(capability, payload);
  return capability;
}

/** Verifies exact capability bindings and atomically consumes one-use authority. */
export function consumeDispatchCapability(
  capability: DispatchCapability,
  action: string,
  exactParameterBytes: Uint8Array,
  dispatchIdentity: DispatchIdentity,
): void {
  if (
    typeof capability !== "object" ||
    capability === null ||
    !mintedCapabilities.has(capability)
  ) {
    throw new Error("dispatch capability was not minted by the validator");
  }
  const payload = capabilityPayloads.get(capability);
  if (payload === undefined)
    throw new Error("dispatch capability payload is unavailable");
  const expectedProof = capabilityProof(payload);
  if (
    payload.proof.byteLength !== expectedProof.byteLength ||
    !timingSafeEqual(payload.proof, expectedProof)
  ) {
    throw new Error("dispatch capability HMAC is invalid");
  }
  if (Date.now() > payload.expiresAt)
    throw new Error("dispatch capability has expired");
  if (consumedCapabilities.has(capability))
    throw new Error("dispatch capability has already been consumed");
  if (
    resolvedParameterHashBytes(exactParameterBytes) !==
    payload.resolvedParameterHash
  ) {
    throw new Error("dispatch capability parameter hash mismatch");
  }
  if (payload.action !== action)
    throw new Error("dispatch capability action mismatch");
  if (
    !validDispatchIdentity(dispatchIdentity) ||
    !sameDispatchIdentity(payload.dispatchIdentity, dispatchIdentity)
  ) {
    throw new Error("dispatch capability identity mismatch");
  }
  consumedCapabilities.add(capability);
}

export function validDispatchIdentity(
  identity: DispatchIdentity | null | undefined,
): identity is DispatchIdentity {
  return (
    identity !== null &&
    identity !== undefined &&
    identity.userId.trim() !== "" &&
    identity.localRole.trim() !== "" &&
    (identity.erpbridgeRole === null || identity.erpbridgeRole.trim() !== "")
  );
}

function tokenProof(token: ValidationToken): Buffer {
  return createHmac("sha256", processSigningKey)
    .update(canonicalJSONBytes(token))
    .digest();
}

function capabilityProof(
  input: Omit<CapabilityPayload, "proof"> | CapabilityPayload,
): Buffer {
  return createHmac("sha256", processSigningKey)
    .update(
      canonicalJSONBytes({
        workflowContentHash: input.workflowContentHash,
        registryHash: input.registryHash,
        stepIndex: input.stepIndex,
        action: input.action,
        resolvedParameterHash: input.resolvedParameterHash,
        dispatchIdentity: input.dispatchIdentity,
        expiresAt: input.expiresAt,
      }),
    )
    .digest();
}

function sameDispatchIdentity(
  left: DispatchIdentity,
  right: DispatchIdentity,
): boolean {
  return (
    left.userId === right.userId &&
    left.localRole === right.localRole &&
    left.erpbridgeRole === right.erpbridgeRole
  );
}
