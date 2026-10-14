import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { decodeEncryptionKey } from "../src/storage/aes-gcm.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { FirestoreRecordCodec, validateFirestoreNamespace } from "../src/storage/firestore-record-codec.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { createFirestoreLegacyBackup, prepareFirestoreLegacyCutover, verifyFirestoreLegacyBackup } from "../src/storage/firestore-legacy-cutover.js";

const command = process.argv[2], allowed = new Set(["export", "verify", "status", "migrate", "clear-staging", "restore-rehearsal", "restore-status", "rollback-readiness"]);
if (!allowed.has(command)) throw new Error("Usage: firestore-cutover.mjs export|verify|status|migrate|clear-staging|restore-rehearsal|restore-status|rollback-readiness");
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
if (command === "clear-staging" && process.env.FIRESTORE_CUTOVER_CONFIRM_CLEAR_STAGING !== "I_CONFIRM_CLEAR_UNACTIVATED_STAGING")
  throw new Error("Staging cleanup requires FIRESTORE_CUTOVER_CONFIRM_CLEAR_STAGING=I_CONFIRM_CLEAR_UNACTIVATED_STAGING");
if (command === "rollback-readiness" && process.env.FIRESTORE_CUTOVER_CONFIRM_ROLLBACK_READINESS !== namespace.workspaceId)
  throw new Error("Rollback readiness requires exact target workspace confirmation");
const restoreCommand = command === "restore-rehearsal" || command === "restore-status";
const validateRestoreScope = backup => {
  if (backup.namespace.projectId !== namespace.projectId || backup.namespace.databaseId !== namespace.databaseId)
    throw new Error("Restore rehearsal must remain in the authenticated backup project and database");
  if (backup.namespace.workspaceId === namespace.workspaceId || !/^restore_[a-z0-9_]{8,120}$/.test(namespace.workspaceId))
    throw new Error("Restore rehearsal requires a different quarantined restore_ workspace");
  if (process.env.FIRESTORE_CUTOVER_CONFIRM_RESTORE_SOURCE_WORKSPACE !== backup.namespace.workspaceId ||
      process.env.FIRESTORE_CUTOVER_CONFIRM_DISPOSABLE_RESTORE !== namespace.workspaceId)
    throw new Error("Restore rehearsal requires exact source and disposable target workspace confirmations");
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
} else if (command === "status") {
  const backup = verifyFirestoreLegacyBackup(await readFile(backupPath), storageKey, backupKey);
  if (backup.namespace.projectId !== namespace.projectId || backup.namespace.databaseId !== namespace.databaseId || backup.namespace.workspaceId !== namespace.workspaceId)
    throw new Error("Backup namespace differs from the explicit status target");
  const prepared = prepareFirestoreLegacyCutover(backup.document, storageKey, namespace), persistence = await FirestoreRecordPersistence.open(storageKey, namespace, authentication);
  try {
    const snapshot = await persistence.records.load();
    if (!snapshot.recordCount || !snapshot.revision) {
      console.log(JSON.stringify({ status: "not-active", namespace, sourceHash: backup.sourceHash })); process.exitCode = 2;
    } else {
      const state = assembleFirestoreState(persistence.records.readRecords(snapshot));
      const expectedTransition = new FirestoreRecordCodec(storageKey, namespace).identity("transition", `legacy_cutover_${backup.sourceHash.slice("sha256:".length)}`);
      if (snapshot.transitionIdentity !== expectedTransition || snapshot.recordCount !== backup.recordCount || !canonicalJSONBytes(state).equals(canonicalJSONBytes(prepared.state)))
        throw new Error("Active Firestore target differs from the authenticated backup");
      const legacy = await persistence.records.db.doc("runtime/state").get(), legacySourceRetained = legacy.exists &&
        canonicalJSONBytes(legacy.data()).equals(canonicalJSONBytes(backup.document));
      console.log(JSON.stringify({ status: "active", namespace, sourceHash: backup.sourceHash, sourceBytes: backup.sourceBytes,
        recordCount: snapshot.recordCount, recordFingerprint: backup.recordFingerprint, revision: snapshot.revision, legacySourceRetained }));
    }
  } finally { await persistence.close(); }
} else if (command === "rollback-readiness") {
  const backup = verifyFirestoreLegacyBackup(await readFile(backupPath), storageKey, backupKey);
  if (backup.namespace.projectId !== namespace.projectId || backup.namespace.databaseId !== namespace.databaseId || backup.namespace.workspaceId !== namespace.workspaceId)
    throw new Error("Backup namespace differs from the explicit rollback-readiness target");
  const prepared = prepareFirestoreLegacyCutover(backup.document, storageKey, namespace), persistence = await FirestoreRecordPersistence.open(storageKey, namespace, authentication);
  try {
    const snapshot = await persistence.records.load(), state = snapshot.recordCount ? assembleFirestoreState(persistence.records.readRecords(snapshot)) : null;
    const expectedTransition = new FirestoreRecordCodec(storageKey, namespace).identity("transition", `legacy_cutover_${backup.sourceHash.slice("sha256:".length)}`);
    if (snapshot.revision !== 1) throw new Error("Rollback is not ready: normalized target contains post-cutover changes");
    if (!state || snapshot.transitionIdentity !== expectedTransition || snapshot.recordCount !== backup.recordCount ||
        !canonicalJSONBytes(state).equals(canonicalJSONBytes(prepared.state))) throw new Error("Rollback readiness target differs from the authenticated cutover");
    await persistence.records.probeWriterAndLegacySource(snapshot, { path: "runtime/state", document: backup.document });
    console.log(JSON.stringify({ status: "rollback-ready-no-post-cutover-writes", namespace, sourceHash: backup.sourceHash,
      recordCount: snapshot.recordCount, revision: snapshot.revision, legacySourceRetained: true,
      postCutoverWrites: false, routingChanged: false, operatorRoutingRequired: true }));
  } finally { await persistence.close(); }
} else if (command === "migrate") {
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
} else if (command === "clear-staging") {
  const backup = verifyFirestoreLegacyBackup(await readFile(backupPath), storageKey, backupKey);
  if (backup.namespace.projectId !== namespace.projectId || backup.namespace.databaseId !== namespace.databaseId || backup.namespace.workspaceId !== namespace.workspaceId)
    throw new Error("Backup namespace differs from the explicit staging-cleanup target");
  const db = new Firestore({ projectId: namespace.projectId, databaseId: namespace.databaseId, ...authentication });
  let sourceBefore;
  try {
    const row = await db.doc("runtime/state").get();
    if (!row.exists) throw new Error("Legacy Firestore source is unavailable; staging cleanup denied");
    sourceBefore = row.data();
  } finally { await db.terminate(); }
  const persistence = await FirestoreRecordPersistence.open(storageKey, namespace, authentication);
  try {
    const report = await persistence.records.clearUnactivatedStaging();
    const sourceAfter = await persistence.records.db.doc("runtime/state").get();
    if (!sourceAfter.exists || !canonicalJSONBytes(sourceAfter.data()).equals(canonicalJSONBytes(sourceBefore)))
      throw new Error("Legacy Firestore source changed during staging cleanup");
    console.log(JSON.stringify({ status: "cleared", namespace, backupSourceHash: backup.sourceHash,
      legacySourceMatchesBackup: canonicalJSONBytes(sourceBefore).equals(canonicalJSONBytes(backup.document)),
      manifestsRemoved: report.manifests, chunksRemoved: report.chunks, legacySourceRetained: true }));
  } finally { await persistence.close(); }
} else if (restoreCommand) {
  const backup = verifyFirestoreLegacyBackup(await readFile(backupPath), storageKey, backupKey); validateRestoreScope(backup);
  const prepared = prepareFirestoreLegacyCutover(backup.document, storageKey, namespace);
  if (prepared.sourceHash !== backup.sourceHash || prepared.sourceBytes !== backup.sourceBytes || prepared.recordCount !== backup.recordCount ||
      prepared.recordFingerprint !== backup.recordFingerprint) throw new Error("Restore conversion differs from the authenticated backup");
  const persistence = await FirestoreRecordPersistence.open(storageKey, namespace, authentication);
  try {
    const transitionId = `legacy_restore_${backup.sourceHash.slice("sha256:".length)}`;
    if (command === "restore-rehearsal") await persistence.records.initializeStaged(prepared.records, transitionId);
    const snapshot = await persistence.records.load();
    const state = snapshot.recordCount ? assembleFirestoreState(persistence.records.readRecords(snapshot)) : null;
    const expectedTransition = new FirestoreRecordCodec(storageKey, namespace).identity("transition", transitionId);
    if (!state || snapshot.transitionIdentity !== expectedTransition || snapshot.recordCount !== backup.recordCount ||
        !canonicalJSONBytes(state).equals(canonicalJSONBytes(prepared.state))) {
      if (command === "restore-status" && !snapshot.recordCount) {
        console.log(JSON.stringify({ status: "not-restored", sourceNamespace: backup.namespace, targetNamespace: namespace,
          sourceHash: backup.sourceHash, quarantineRequired: true })); process.exitCode = 2;
      } else throw new Error("Disposable restore target differs from the authenticated backup");
    } else console.log(JSON.stringify({ status: "restored-for-verification", sourceNamespace: backup.namespace, targetNamespace: namespace,
      sourceHash: backup.sourceHash, sourceBytes: backup.sourceBytes, recordCount: snapshot.recordCount,
      recordFingerprint: backup.recordFingerprint, revision: snapshot.revision, quarantineRequired: true }));
  } finally { await persistence.close(); }
}
