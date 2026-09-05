import { createHmac } from "node:crypto";
import { AESGCMCodec } from "../storage/aes-gcm.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { assertReadContinuation, type ReadContinuation } from "../repository/store.js";
import type { ReadMachineSnapshot } from "../workflows/read-machine.js";
import type { ReadCompletionSnapshot } from "../workflows/read-completion-evidence.js";

export type ReadContinuationBody = { profile: "private-read-continuation/v1"; identity: string; evidenceBinding: string;
  machine: ReadMachineSnapshot; completion: ReadCompletionSnapshot; used: string[]; hasFinal: boolean; observedFinal?: unknown };

/** Private data only. The caller supplies a fresh server-computed identity and
 * exact saved-evidence binding; neither an HTTP cursor nor model prose is used.
 * Separate key domain prevents this payload becoming another storage record. */
export class ReadContinuationCodec {
  readonly #codec: AESGCMCodec;
  constructor(bindingKey: string) {
    if (Buffer.byteLength(bindingKey) < 32) throw new Error("Private continuation requires a server binding key");
    this.#codec = new AESGCMCodec(createHmac("sha256", bindingKey).update("lcwe/private-read-continuation/v1").digest("base64"));
  }
  encode(executionId: string, body: ReadContinuationBody): ReadContinuation {
    const plaintext = canonicalJSONBytes(body); if (plaintext.length > 4_000_000) throw new Error("Private continuation exceeds bounded storage");
    return { profile: "read-continuation/v1", executionId, ciphertext: this.#codec.encode(plaintext).toString("base64") };
  }
  decode(record: ReadContinuation, executionId: string, identity: string, evidenceBinding: string): ReadContinuationBody {
    assertReadContinuation(record, executionId);
    const ciphertext = Buffer.from(record.ciphertext, "base64"); if (ciphertext.toString("base64") !== record.ciphertext) throw new Error("Invalid continuation ciphertext encoding");
    const plaintext = this.#codec.decode(ciphertext); if (plaintext.length > 4_000_000) throw new Error("Private continuation exceeds bounded storage");
    const body = JSON.parse(plaintext.toString("utf8")) as ReadContinuationBody;
    if (!body || body.profile !== "private-read-continuation/v1" || body.identity !== identity || body.evidenceBinding !== evidenceBinding || !body.machine || body.machine.profile !== "read-machine/v1" || !body.completion || body.completion.profile !== "read-completion/v1" || !Array.isArray(body.used) || body.used.length > 5000 || body.used.some(key => typeof key !== "string" || key.length > 2048) || new Set(body.used).size !== body.used.length || typeof body.hasFinal !== "boolean" || body.hasFinal !== Object.hasOwn(body, "observedFinal") || Object.keys(body).some(key => !["profile", "identity", "evidenceBinding", "machine", "completion", "used", "hasFinal", "observedFinal"].includes(key))) throw new Error("Private continuation differs from its exact run or committed evidence");
    return body;
  }
}
