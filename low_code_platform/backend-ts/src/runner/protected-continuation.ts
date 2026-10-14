import { createHmac } from "node:crypto";
import { z } from "zod";
import { AESGCMCodec } from "../storage/aes-gcm.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundProtectedMachineJSON } from "../workflows/protected-machine.js";
import { protectedMachineSnapshotSchema, type ProtectedMachineSnapshot } from "../workflows/protected-machine-state.js";
import { protectedContinuationRecordSchema as recordSchema, type ProtectedContinuation } from "../repository/protected-continuation-record.js";
export type { ProtectedContinuation } from "../repository/protected-continuation-record.js";

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/), hmac = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
const contextSchema = z.object({ executionId: id, workflowId: id, epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  actorId: id, roleId: id, admittedRole: id, sourceHash: sha, semanticHash: sha }).strict();
const identitySchema = contextSchema.extend({ inputBinding: hmac }).strict();
export type ProtectedContinuationContext = z.infer<typeof contextSchema>;
export type ProtectedContinuationIdentity = z.infer<typeof identitySchema>;
const bodySchema = z.object({ profile: z.literal("private-protected-machine/v1"), identity: identitySchema,
  evidenceBinding: hmac, machine: protectedMachineSnapshotSchema }).strict();
const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));

/** Private bound DATA only, not an acknowledged checkpoint or recovery grant.
 * The future owned worker must freshly derive context and complete evidence
 * from authoritative records before decoding, then validate the machine plan.
 * No HTTP/model cursor, lease renewal, receipt fabrication or dispatch exists. */
export class ProtectedContinuationCodec {
  readonly #codec: AESGCMCodec;
  readonly #bindingKey: string;
  constructor(bindingKey: string) {
    if (Buffer.byteLength(bindingKey) < 32) throw new Error("Protected continuation requires a server-held binding key");
    this.#bindingKey = bindingKey;
    this.#codec = new AESGCMCodec(createHmac("sha256", bindingKey).update("lcwe/private-protected-machine/v1").digest("base64"));
  }
  private bind(domain: "input" | "evidence", value: unknown) {
    boundProtectedMachineJSON(value);
    return `hmac-sha256:${createHmac("sha256", this.#bindingKey).update(`lcwe/protected-continuation/${domain}/v1\0`).update(canonicalJSONBytes(value)).digest("hex")}`;
  }
  identity(context: ProtectedContinuationContext, input: Record<string, unknown>): ProtectedContinuationIdentity {
    const current = contextSchema.parse(context);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Protected continuation input must be an object");
    return { ...current, inputBinding: this.bind("input", { context: current, input }) };
  }
  evidenceBinding(identity: ProtectedContinuationIdentity, completeSavedEvidence: unknown): string {
    return this.bind("evidence", { identity: identitySchema.parse(identity), completeSavedEvidence });
  }
  private assertBody(identity: ProtectedContinuationIdentity, machine: ProtectedMachineSnapshot) {
    const { inputBinding, ...context } = identity;
    if (identity.sourceHash !== machine.sourceHash || identity.semanticHash !== machine.semanticHash ||
        this.identity(context, machine.values.input as Record<string, unknown>).inputBinding !== inputBinding)
      throw new Error("Protected continuation source, semantic identity or private input changed");
  }
  encode(identity: ProtectedContinuationIdentity, evidenceBinding: string, machine: ProtectedMachineSnapshot): ProtectedContinuation {
    boundProtectedMachineJSON({ identity, evidenceBinding, machine });
    const body = bodySchema.parse({ profile: "private-protected-machine/v1", identity, evidenceBinding, machine });
    boundProtectedMachineJSON(body);
    this.assertBody(body.identity, body.machine as ProtectedMachineSnapshot);
    return { profile: "protected-continuation/v1", executionId: identity.executionId,
      ciphertext: this.#codec.encode(canonicalJSONBytes(body)).toString("base64") };
  }
  decode(record: ProtectedContinuation, expectedIdentity: ProtectedContinuationIdentity, expectedEvidenceBinding: string): ProtectedMachineSnapshot {
    const current = recordSchema.parse(record), identity = identitySchema.parse(expectedIdentity); hmac.parse(expectedEvidenceBinding);
    if (current.executionId !== identity.executionId) throw new Error("Protected continuation belongs to another run");
    const ciphertext = Buffer.from(current.ciphertext, "base64");
    if (ciphertext.toString("base64") !== current.ciphertext) throw new Error("Protected continuation ciphertext is not canonical");
    const plaintext = this.#codec.decode(ciphertext);
    if (plaintext.length > 4000000) throw new Error("Protected continuation exceeds private data bounds");
    const parsed: unknown = JSON.parse(plaintext.toString("utf8")); boundProtectedMachineJSON(parsed);
    const body = bodySchema.parse(parsed);
    if (!same(body.identity, identity) || body.evidenceBinding !== expectedEvidenceBinding) throw new Error("Protected continuation differs from current run or complete saved evidence");
    this.assertBody(identity, body.machine as ProtectedMachineSnapshot);
    return body.machine as ProtectedMachineSnapshot;
  }
}
