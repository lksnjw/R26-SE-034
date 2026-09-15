import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { decodeEncryptionKey } from "../src/storage/aes-gcm.js";
import { validateFirestoreNamespace } from "../src/storage/firestore-record-codec.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { createFirestoreLegacyBackup, verifyFirestoreLegacyBackup } from "../src/storage/firestore-legacy-cutover.js";

const command = process.argv[2], allowed = new Set(["export", "verify", "migrate"]);
if (!allowed.has(command)) throw new Error("Usage: firestore-cutover.mjs export|verify|migrate");
const required = name => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
const backupPath = resolve(required("FIRESTORE_CUTOVER_BACKUP_PATH"));
const storageKey = required("STORAGE_ENCRYPTION_KEY"), backupKey = required("FIRESTORE_CUTOVER_BACKUP_KEY");
if (decodeEncryptionKey(storageKey).equals(decodeEncryptionKey(backupKey))) throw new Error("FIRESTORE_CUTOVER_BACKUP_KEY must differ from STORAGE_ENCRYPTION_KEY");

if (command === "verify") {
  const backup = verifyFirestoreLegacyBackup(await readFile(backupPath), storageKey, backupKey);
  console.log(JSON.stringify({ status: "verified", profile: backup.profile, namespace: backup.namespace, createdAt: backup.createdAt,
    sourceHash: backup.sourceHash, sourceBytes: backup.sourceBytes, recordCount: backup.recordCount, recordFingerprint: backup.recordFingerprint }));
  process.exit(0);
}

const namespace = validateFirestoreNamespace({ projectId: required("FIRESTORE_PROJECT_ID"), databaseId: required("FIRESTORE_DATABASE_ID"), workspaceId: required("FIRESTORE_WORKSPACE_ID") });
const emulator = process.env.FIRESTORE_EMULATOR_HOST?.trim();
if (emulator) {
  if (!/^(127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(emulator) || process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("Cutover emulator must be loopback-only and must not use a credential file");
} else if (process.env.FIRESTORE_CUTOVER_CONFIRM_PROJECT !== namespace.projectId || process.env.FIRESTORE_CUTOVER_CONFIRM_SOURCE_STOPPED !== "I_CONFIRM_SOURCE_WRITER_STOPPED") {
  throw new Error("Cloud cutover requires exact project confirmation and confirmation that the legacy writer is stopped");
}
const authentication = {
  ...(process.env.FIRESTORE_KEY_FILE?.trim() ? { keyFilename: process.env.FIRESTORE_KEY_FILE.trim() } : {}),
  ...(process.env.FIRESTORE_KEY_JSON?.trim() ? { credentials: JSON.parse(process.env.FIRESTORE_KEY_JSON) } : {}),
};

if (command === "export") {
  const db = new Firestore({ projectId: namespace.projectId, databaseId: namespace.databaseId, ...authentication });
  try {
    const row = await db.doc("runtime/state").get(); if (!row.exists) throw new Error("Legacy Firestore source is unavailable");
    const artifact = createFirestoreLegacyBackup(row.data(), storageKey, backupKey, namespace);
    await writeFile(backupPath, artifact, { flag: "wx", mode: 0o600 });
    const backup = verifyFirestoreLegacyBackup(artifact, storageKey, backupKey);
    console.log(JSON.stringify({ status: "exported", path: backupPath, namespace: backup.namespace, sourceHash: backup.sourceHash,
      sourceBytes: backup.sourceBytes, recordCount: backup.recordCount, recordFingerprint: backup.recordFingerprint }));
  } finally { await db.terminate(); }
} else {
  const backup = verifyFirestoreLegacyBackup(await readFile(backupPath), storageKey, backupKey);
  if (backup.namespace.projectId !== namespace.projectId || backup.namespace.databaseId !== namespace.databaseId || backup.namespace.workspaceId !== namespace.workspaceId)
    throw new Error("Backup namespace differs from the explicit migration target");
  const persistence = await FirestoreRecordPersistence.open(storageKey, namespace, authentication);
  try {
    const report = await persistence.migrateLegacy(backup.sourceHash);
    if (report.sourceBytes !== backup.sourceBytes || report.recordCount !== backup.recordCount || report.recordFingerprint !== backup.recordFingerprint)
      throw new Error("Activated migration report differs from the authenticated backup");
    console.log(JSON.stringify({ status: "migrated", namespace, ...report, legacySourceRetained: true }));
  } finally { await persistence.close(); }
}
