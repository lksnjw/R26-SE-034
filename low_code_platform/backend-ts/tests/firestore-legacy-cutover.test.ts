import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { initialState } from "../src/repository/store.js";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import { createFirestoreLegacyBackup, prepareFirestoreLegacyCutover, verifyFirestoreLegacyBackup } from "../src/storage/firestore-legacy-cutover.js";

const storageKey = "s".repeat(32), backupKey = "b".repeat(32);
const namespace = { projectId: "demo-lcwe-cutover", databaseId: "(default)", workspaceId: "migration_fixture" };
const fixture = () => {
  const state = initialState(); state.settings.cutover = { falseValue: false, zeroValue: 0, nullValue: null };
  const plaintext = Buffer.from(JSON.stringify(state));
  const document = { payload: new AESGCMCodec(storageKey).encode(gzipSync(plaintext)).toString("base64"), encrypted: true as const,
    compression: "gzip" as const, updatedAt: "2026-10-08T00:00:00.000Z" };
  return { state, plaintext, document };
};

test("a separately encrypted backup authenticates source metadata and lossless record conversion", () => {
  const source = fixture(), artifact = createFirestoreLegacyBackup(source.document, storageKey, backupKey, namespace, "2026-10-08T01:00:00.000Z");
  expect(artifact.includes(Buffer.from("falseValue"))).toBe(false);
  const backup = verifyFirestoreLegacyBackup(artifact, storageKey, backupKey);
  expect(backup).toMatchObject({ namespace, createdAt: "2026-10-08T01:00:00.000Z", sourceBytes: source.plaintext.length,
    sourceHash: `sha256:${createHash("sha256").update(source.plaintext).digest("hex")}` });
  expect(prepareFirestoreLegacyCutover(backup.document, storageKey, namespace).state).toEqual(source.state);
});

test("wrong backup/storage keys, changed metadata and changed ciphertext all fail closed", () => {
  const source = fixture(), artifact = createFirestoreLegacyBackup(source.document, storageKey, backupKey, namespace, "2026-10-08T01:00:00.000Z");
  expect(() => verifyFirestoreLegacyBackup(artifact, storageKey, "x".repeat(32))).toThrow("authentication");
  expect(() => verifyFirestoreLegacyBackup(artifact, "x".repeat(32), backupKey)).toThrow();
  const envelope = JSON.parse(artifact.toString("utf8")); envelope.recordCount++;
  expect(() => verifyFirestoreLegacyBackup(Buffer.from(JSON.stringify(envelope)), storageKey, backupKey)).toThrow("metadata authentication");
  const damaged = JSON.parse(artifact.toString("utf8")), bytes = Buffer.from(damaged.payload, "base64"); bytes[40] = bytes[40]! ^ 1; damaged.payload = bytes.toString("base64");
  expect(() => verifyFirestoreLegacyBackup(Buffer.from(JSON.stringify(damaged)), storageKey, backupKey)).toThrow("authentication");
});

test("legacy downgrade, unknown metadata and implicit schema repair are rejected", () => {
  const source = fixture();
  expect(() => prepareFirestoreLegacyCutover({ ...source.document, encrypted: false }, storageKey, namespace)).toThrow();
  expect(() => prepareFirestoreLegacyCutover({ ...source.document, extra: true }, storageKey, namespace)).toThrow("document");
  const incomplete = Buffer.from(JSON.stringify({ version: 1 }));
  expect(() => prepareFirestoreLegacyCutover({ payload: incomplete.toString("base64"), encrypted: false }, storageKey, namespace)).toThrow("schema repair");
});
