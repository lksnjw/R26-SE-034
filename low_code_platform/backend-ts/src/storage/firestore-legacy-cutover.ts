import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { restoreState, type RepositoryState } from "../repository/store.js";
import { AESGCMCodec } from "./aes-gcm.js";
import { splitFirestoreState, assembleFirestoreState } from "./firestore-record-layout.js";
import { FIRESTORE_RECORD_BOUNDS, validateFirestoreNamespace, type FirestoreNamespace } from "./firestore-record-codec.js";
import type { RuntimeRecord } from "./execution-record-layout.js";

const GZIP = "gzip";
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|"));
const digest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export type LegacyFirestoreDocument = Readonly<{
  payload: string;
  encrypted: boolean;
  compression?: "gzip";
  updatedAt?: string;
}>;

export type FirestoreLegacyCutover = Readonly<{
  profile: "firestore-legacy-cutover/v1";
  namespace: FirestoreNamespace;
  sourceHash: string;
  sourceBytes: number;
  recordCount: number;
  recordFingerprint: string;
  payload: Buffer;
  state: RepositoryState;
  records: readonly RuntimeRecord[];
}>;

type BackupEnvelope = Readonly<{
  profile: "firestore-legacy-backup/v1";
  namespace: FirestoreNamespace;
  createdAt: string;
  sourceHash: string;
  sourceBytes: number;
  recordCount: number;
  recordFingerprint: string;
  payload: string;
}>;

export type VerifiedFirestoreLegacyBackup = Readonly<{
  profile: "firestore-legacy-backup/v1";
  namespace: FirestoreNamespace;
  createdAt: string;
  sourceHash: string;
  sourceBytes: number;
  recordCount: number;
  recordFingerprint: string;
  document: LegacyFirestoreDocument;
}>;

function strictBase64(value: string): Buffer {
  if (!value.length || value.trim() !== value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid legacy Firestore payload encoding");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) throw new Error("Invalid legacy Firestore payload encoding");
  return bytes;
}
function legacyDocument(value: unknown): LegacyFirestoreDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy Firestore document");
  const source = value as Record<string, unknown>, allowed = new Set(["payload", "encrypted", "compression", "updatedAt"]);
  if (Object.keys(source).some(key => !allowed.has(key)) || typeof source.payload !== "string" || typeof source.encrypted !== "boolean" ||
      source.compression !== undefined && source.compression !== GZIP || source.updatedAt !== undefined &&
      (typeof source.updatedAt !== "string" || !Number.isFinite(Date.parse(source.updatedAt)))) throw new Error("Invalid legacy Firestore document");
  return Object.freeze({ payload: source.payload, encrypted: source.encrypted,
    ...(source.compression === GZIP ? { compression: GZIP } : {}), ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {}) });
}

function checkedState(payload: Uint8Array): RepositoryState {
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload).toString("utf8")); }
  catch { throw new Error("Legacy Firestore backup is not valid repository JSON"); }
  const restored = restoreState(payload);
  // Cutover is not a catch-all repair. Added defaults, malformed ACL maps, or
  // dropped fields require a separately reviewed schema-repair artifact.
  if (!canonicalJSONBytes(decoded).equals(canonicalJSONBytes(restored))) throw new Error("Legacy Firestore state requires explicit schema repair before cutover");
  return restored;
}

/** Decode and fully validate the old aggregate without mutating either source
 * or target. The returned hash is over decompressed plaintext and must match an
 * independently retained backup before activation is allowed. */
export function prepareFirestoreLegacyCutover(document: unknown, encryptionKey: string, namespace: FirestoreNamespace): FirestoreLegacyCutover {
  const scope = validateFirestoreNamespace(namespace), source = legacyDocument(document);
  let bytes = strictBase64(source.payload);
  if (source.encrypted) bytes = new AESGCMCodec(encryptionKey).decode(bytes);
  if (source.compression === GZIP) {
    try { bytes = gunzipSync(bytes, { maxOutputLength: FIRESTORE_RECORD_BOUNDS.imageBytes }); }
    catch { throw new Error("Legacy Firestore compression is invalid or exceeds the migration budget"); }
  }
  if (!bytes.length || bytes.length > FIRESTORE_RECORD_BOUNDS.imageBytes) throw new Error("Legacy Firestore state exceeds the migration budget");
  const state = checkedState(bytes), records = splitFirestoreState(state), assembled = assembleFirestoreState(records);
  if (!canonicalJSONBytes(state).equals(canonicalJSONBytes(assembled))) throw new Error("Legacy Firestore record conversion is not lossless");
  const recordFingerprint = digest(canonicalJSONBytes(records.map(record => [record.path, record.value])));
  return Object.freeze({ profile: "firestore-legacy-cutover/v1", namespace: scope, sourceHash: digest(bytes), sourceBytes: bytes.length,
    recordCount: records.length, recordFingerprint, payload: Buffer.from(bytes), state, records: Object.freeze(records.map(record => structuredClone(record))) });
}

export function assertFirestoreLegacyBackupHash(actual: string, expected: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(expected)) throw new Error("An explicit legacy Firestore backup hash is required");
  if (actual !== expected) throw new Error("Legacy Firestore source no longer matches its external backup hash");
}

/** Create a portable, separately encrypted source backup. The storage key and
 * backup key should be different secrets; neither key is included in the file. */
export function createFirestoreLegacyBackup(document: unknown, storageEncryptionKey: string, backupEncryptionKey: string,
  namespace: FirestoreNamespace, createdAt = new Date().toISOString()): Buffer {
  if (new Date(createdAt).toISOString() !== createdAt) throw new Error("Invalid Firestore legacy backup timestamp");
  const source = legacyDocument(document), cutover = prepareFirestoreLegacyCutover(source, storageEncryptionKey, namespace);
  const body = canonicalJSONBytes({ profile: "firestore-legacy-backup-body/v1", namespace: cutover.namespace, createdAt,
    sourceHash: cutover.sourceHash, sourceBytes: cutover.sourceBytes, recordCount: cutover.recordCount,
    recordFingerprint: cutover.recordFingerprint, document: source });
  const payload = new AESGCMCodec(backupEncryptionKey).encode(body).toString("base64");
  return canonicalJSONBytes({ profile: "firestore-legacy-backup/v1", namespace: cutover.namespace, createdAt,
    sourceHash: cutover.sourceHash, sourceBytes: cutover.sourceBytes, recordCount: cutover.recordCount,
    recordFingerprint: cutover.recordFingerprint, payload } satisfies BackupEnvelope);
}

/** Authenticate a backup and re-run source/schema/record validation before it
 * is accepted as cutover evidence. */
export function verifyFirestoreLegacyBackup(artifact: Uint8Array, storageEncryptionKey: string, backupEncryptionKey: string): VerifiedFirestoreLegacyBackup {
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(artifact).toString("utf8")); } catch { throw new Error("Invalid Firestore legacy backup artifact"); }
  if (!exact(decoded, ["profile", "namespace", "createdAt", "sourceHash", "sourceBytes", "recordCount", "recordFingerprint", "payload"]) ||
      decoded.profile !== "firestore-legacy-backup/v1" || typeof decoded.createdAt !== "string" || new Date(decoded.createdAt).toISOString() !== decoded.createdAt ||
      typeof decoded.sourceHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(decoded.sourceHash) || !Number.isSafeInteger(decoded.sourceBytes) || Number(decoded.sourceBytes) < 1 ||
      !Number.isSafeInteger(decoded.recordCount) || Number(decoded.recordCount) < 1 || typeof decoded.recordFingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(decoded.recordFingerprint) || typeof decoded.payload !== "string") throw new Error("Invalid Firestore legacy backup artifact");
  const namespace = validateFirestoreNamespace(decoded.namespace as FirestoreNamespace), encrypted = strictBase64(decoded.payload);
  let body: unknown;
  try { body = JSON.parse(new AESGCMCodec(backupEncryptionKey).decode(encrypted).toString("utf8")); }
  catch { throw new Error("Firestore legacy backup authentication failed"); }
  if (!exact(body, ["profile", "namespace", "createdAt", "sourceHash", "sourceBytes", "recordCount", "recordFingerprint", "document"]) ||
      body.profile !== "firestore-legacy-backup-body/v1") throw new Error("Invalid Firestore legacy backup body");
  const metadata = { namespace, createdAt: decoded.createdAt, sourceHash: decoded.sourceHash, sourceBytes: Number(decoded.sourceBytes),
    recordCount: Number(decoded.recordCount), recordFingerprint: decoded.recordFingerprint };
  if (!canonicalJSONBytes(body.namespace).equals(canonicalJSONBytes(metadata.namespace)) || body.createdAt !== metadata.createdAt || body.sourceHash !== metadata.sourceHash ||
      body.sourceBytes !== metadata.sourceBytes || body.recordCount !== metadata.recordCount || body.recordFingerprint !== metadata.recordFingerprint)
    throw new Error("Firestore legacy backup metadata authentication failed");
  const document = legacyDocument(body.document), checked = prepareFirestoreLegacyCutover(document, storageEncryptionKey, namespace);
  if (checked.sourceHash !== metadata.sourceHash || checked.sourceBytes !== metadata.sourceBytes || checked.recordCount !== metadata.recordCount ||
      checked.recordFingerprint !== metadata.recordFingerprint) throw new Error("Firestore legacy backup contents differ from authenticated metadata");
  return Object.freeze({ profile: "firestore-legacy-backup/v1", ...metadata, document });
}
