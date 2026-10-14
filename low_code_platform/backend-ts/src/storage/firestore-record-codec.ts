import { createHash, createHmac } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { AESGCMCodec, decodeEncryptionKey } from "./aes-gcm.js";
import { recordKey, type RuntimeRecord } from "./execution-record-layout.js";

export type FirestoreNamespace = Readonly<{ projectId: string; databaseId: string; workspaceId: string }>;
export type PrivateFirestoreDocument = { profile: "firestore-private/v1"; payload: Buffer };
export type RecordChunk = { id: string; document: PrivateFirestoreDocument };
export type EncodedFirestoreRecord = { key: string; record: RuntimeRecord; bytes: Buffer; hash: string; chunks: RecordChunk[] };
export type DecodedRecordChunk = { key: string; hash: string; bytes: number; index: number; count: number; body: Buffer };
// Application budgets, not platform quotas. Activate only bounded metadata in
// one commit; prepare the larger immutable encrypted bodies separately.
export const FIRESTORE_RECORD_BOUNDS = Object.freeze({ chunkBytes: 384_000, recordBytes: 8_000_000, documentBytes: 786_432, imageBytes: 256_000_000, recordCount: 100_000, chunkCount: 100_000, transactionWrites: 400, transactionBytes: 3_000_000, mutationBytes: 32_000_000, stagingConcurrency: 4, readBatch: 100,
  migrationRecords: 5_000, migrationManifestBytes: 6_000_000 });
const chunkMagic = Buffer.from("LCWE_FS_CHUNK_V1", "ascii"), MAX_HEADER = 24_000;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const invalid = () => new Error("Invalid authenticated Firestore record or scope");
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|"));

export function validateFirestoreNamespace(input: FirestoreNamespace): FirestoreNamespace {
  assertJSON(input);
  if (!exact(input, ["projectId", "databaseId", "workspaceId"]) || typeof input.projectId !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId) ||
      typeof input.databaseId !== "string" || !(input.databaseId === "(default)" || /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(input.databaseId)) ||
      typeof input.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.workspaceId) || /^__.*__$/.test(input.workspaceId)) throw invalid();
  return Object.freeze({ ...input });
}
function validPath(path: unknown): asserts path is string[] {
  if (!Array.isArray(path) || !path.length || path.length > 8 || path.some(part => typeof part !== "string" || !part.length || part.length > 4096) || recordKey(path).length > 16_384) throw invalid();
}
// Reject lossy/non-JSON inputs before canonicalization; accessors cannot run
// during transaction preparation. Prototype-like *member names* are allowed.
function assertJSON(value: unknown, active = new Set<object>(), depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 250_000 || depth > 64) throw invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string" && value.length <= FIRESTORE_RECORD_BOUNDS.recordBytes || typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || active.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Array.isArray(value) && Object.keys(value).length !== value.length) throw invalid();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw invalid();
    if (!descriptor.enumerable || !("value" in descriptor) || key.length > 16_384) throw invalid();
    assertJSON(descriptor.value, active, depth + 1, budget);
  }
  active.delete(value);
}
function recordBytes(record: RuntimeRecord) {
  assertJSON(record);
  if (!exact(record, ["profile", "path", "value"]) || record.profile !== "runtime-record/v1") throw invalid();
  validPath(record.path);
  const bytes = canonicalJSONBytes(record);
  if (bytes.length > FIRESTORE_RECORD_BOUNDS.recordBytes) throw new Error("Firestore logical record byte budget exceeded");
  return bytes;
}

/** Authenticated scope lives inside each encrypted packet. Binary chunk bodies
 * avoid another base64 expansion of already encrypted private continuations.
 * Physical addresses are keyed and never contain private logical paths. */
export class FirestoreRecordCodec {
  readonly namespace: FirestoreNamespace;
  readonly #codec: AESGCMCodec;
  readonly #addressKey: Buffer;
  constructor(encryptionKey: string, namespace: FirestoreNamespace) {
    this.namespace = validateFirestoreNamespace(namespace); this.#codec = new AESGCMCodec(encryptionKey);
    this.#addressKey = createHmac("sha256", decodeEncryptionKey(encryptionKey)).update(canonicalJSONBytes(["firestore-private-address/v1", this.namespace])).digest();
  }
  identity(domain: string, value: unknown): string { return createHmac("sha256", this.#addressKey).update(canonicalJSONBytes([domain, value])).digest("hex"); }
  manifestId(key: string): string {
    try { validPath(JSON.parse(key)); } catch { throw invalid(); }
    if (recordKey(JSON.parse(key)) !== key) throw invalid();
    return this.identity("record-manifest", key);
  }
  documentId(key: string, index: number, digest: string): string {
    this.manifestId(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(FIRESTORE_RECORD_BOUNDS.recordBytes / FIRESTORE_RECORD_BOUNDS.chunkBytes)) throw invalid();
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw invalid();
    return `${this.identity("record-chunk", [key, digest])}-${String(index).padStart(2, "0")}`;
  }
  private document(plaintext: Buffer): PrivateFirestoreDocument {
    const payload = this.#codec.encode(plaintext);
    if (payload.length + 8192 > FIRESTORE_RECORD_BOUNDS.documentBytes) throw new Error("Firestore encoded document budget exceeded");
    return { profile: "firestore-private/v1", payload };
  }
  private plaintext(document: unknown): Buffer {
    if (!exact(document, ["profile", "payload"]) || document.profile !== "firestore-private/v1" || !Buffer.isBuffer(document.payload) || document.payload.length + 8192 > FIRESTORE_RECORD_BOUNDS.documentBytes) throw invalid();
    try { return this.#codec.decode(document.payload); } catch { throw invalid(); }
  }
  encodeRecord(record: RuntimeRecord): EncodedFirestoreRecord {
    const bytes = recordBytes(record), key = recordKey(record.path), digest = hash(bytes), count = Math.ceil(bytes.length / FIRESTORE_RECORD_BOUNDS.chunkBytes), chunks: RecordChunk[] = [];
    for (let index = 0; index < count; index++) {
      const header = canonicalJSONBytes({ profile: "firestore-chunk/v1", namespace: this.namespace, key, hash: digest, bytes: bytes.length, index, count });
      if (header.length > MAX_HEADER) throw invalid();
      const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
      const body = bytes.subarray(index * FIRESTORE_RECORD_BOUNDS.chunkBytes, (index + 1) * FIRESTORE_RECORD_BOUNDS.chunkBytes);
      chunks.push({ id: this.documentId(key, index, digest), document: this.document(Buffer.concat([chunkMagic, size, header, body])) });
    }
    return { key, record: JSON.parse(bytes.toString("utf8")), bytes, hash: digest, chunks };
  }
  decodeChunk(id: string, document: unknown): DecodedRecordChunk {
    const raw = this.plaintext(document), start = chunkMagic.length + 4;
    if (raw.length < start || !raw.subarray(0, chunkMagic.length).equals(chunkMagic)) throw invalid();
    const length = raw.readUInt32BE(chunkMagic.length);
    if (length > MAX_HEADER || length < 1 || start + length >= raw.length) throw invalid();
    const headerBytes = raw.subarray(start, start + length);
    let header: Record<string, unknown>;
    try { header = JSON.parse(headerBytes.toString("utf8")); } catch { throw invalid(); }
    if (!exact(header, ["profile", "namespace", "key", "hash", "bytes", "index", "count"]) || header.profile !== "firestore-chunk/v1" ||
        !canonicalJSONBytes(header.namespace).equals(canonicalJSONBytes(this.namespace)) || !canonicalJSONBytes(header).equals(headerBytes) ||
        typeof header.key !== "string" || typeof header.hash !== "string" || !/^[a-f0-9]{64}$/.test(header.hash) ||
        !Number.isSafeInteger(header.bytes) || Number(header.bytes) < 1 || Number(header.bytes) > FIRESTORE_RECORD_BOUNDS.recordBytes ||
        header.count !== Math.ceil(Number(header.bytes) / FIRESTORE_RECORD_BOUNDS.chunkBytes) || !Number.isSafeInteger(header.index) || Number(header.index) < 0 || Number(header.index) >= Number(header.count)) throw invalid();
    if (id !== this.documentId(header.key, Number(header.index), header.hash)) throw invalid();
    const body = raw.subarray(start + length), expected = Math.min(FIRESTORE_RECORD_BOUNDS.chunkBytes, Number(header.bytes) - Number(header.index) * FIRESTORE_RECORD_BOUNDS.chunkBytes);
    if (body.length !== expected) throw invalid();
    return { key: header.key, hash: header.hash, bytes: Number(header.bytes), index: Number(header.index), count: Number(header.count), body };
  }
  decodeRecord(chunks: DecodedRecordChunk[]): RuntimeRecord {
    const first = chunks[0]; if (!first || chunks.length !== first.count) throw invalid();
    const ordered: Buffer[] = [];
    for (const chunk of chunks) {
      if (chunk.key !== first.key || chunk.hash !== first.hash || chunk.bytes !== first.bytes || chunk.count !== first.count || ordered[chunk.index]) throw invalid();
      ordered[chunk.index] = chunk.body;
    }
    if (ordered.filter(Boolean).length !== first.count) throw invalid();
    const bytes = Buffer.concat(ordered); if (bytes.length !== first.bytes || hash(bytes) !== first.hash) throw invalid();
    let record: RuntimeRecord; try { record = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
    if (recordKey(record.path) !== first.key || !recordBytes(record).equals(bytes)) throw invalid();
    return record;
  }
  encodeHead(value: unknown): PrivateFirestoreDocument {
    assertJSON(value); const raw = canonicalJSONBytes({ profile: "firestore-head-packet/v1", namespace: this.namespace, value });
    if (raw.length > MAX_HEADER) throw invalid(); return this.document(raw);
  }
  decodeHead(document: unknown): unknown {
    const raw = this.plaintext(document); if (raw.length > MAX_HEADER) throw invalid();
    let packet: Record<string, unknown>; try { packet = JSON.parse(raw.toString("utf8")); } catch { throw invalid(); }
    if (!exact(packet, ["profile", "namespace", "value"]) || packet.profile !== "firestore-head-packet/v1" || !canonicalJSONBytes(packet.namespace).equals(canonicalJSONBytes(this.namespace)) || !canonicalJSONBytes(packet).equals(raw)) throw invalid();
    return packet.value;
  }
}
