import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { Firestore } from "@google-cloud/firestore";
import { fileURLToPath } from "node:url";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { prepareFirestoreLegacyCutover } from "../src/storage/firestore-legacy-cutover.js";
import { Repository, initialState } from "../src/repository/store.js";

const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded demo project, fixed loopback Firestore emulator, and no credential file are required");
const namespace = { projectId, databaseId: "(default)", workspaceId: `cutover_${randomUUID().replaceAll("-", "")}` };
const storageKey = randomBytes(32).toString("base64"), backupKey = randomBytes(32).toString("base64");
const state = initialState(); state.settings.cutover = { falseValue: false, zeroValue: 0, nullValue: null };
for (let at = 0; at < 450; at++) state.settings[`staged_${at}`] = { value: at % 3 === 0 ? false : at };
const plaintext = Buffer.from(JSON.stringify(state)), sourceHash = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
const document = { payload: new AESGCMCodec(storageKey).encode(gzipSync(plaintext)).toString("base64"), encrypted: true,
  compression: "gzip", updatedAt: new Date().toISOString() };
const db = new Firestore({ projectId, databaseId: "(default)" }); let persistence, abandoned, recovered, restored;
const directory = await mkdtemp(join(tmpdir(), "lcwe-firestore-cutover-")), backupPath = join(directory, "backup.json"), cleanupBackupPath = join(directory, "cleanup-backup.json");
const cli = fileURLToPath(new URL("./firestore-cutover.mjs", import.meta.url)), execute = promisify(execFile);
const environment = { ...process.env, FIRESTORE_PROJECT_ID: namespace.projectId, FIRESTORE_DATABASE_ID: namespace.databaseId,
  FIRESTORE_WORKSPACE_ID: namespace.workspaceId, STORAGE_ENCRYPTION_KEY: storageKey, FIRESTORE_CUTOVER_BACKUP_KEY: backupKey,
  FIRESTORE_CUTOVER_BACKUP_PATH: backupPath };
const run = command => execute(process.execPath, ["--import", "tsx/esm", cli, command], { env: environment, maxBuffer: 1_000_000 });
try {
  await db.doc("runtime/state").create(document);
  const exported = JSON.parse((await run("export")).stdout), artifact = await readFile(backupPath);
  assert.equal(exported.status, "exported"); assert.equal(exported.sourceHash, sourceHash); assert.equal(artifact.includes(Buffer.from("falseValue")), false);
  await assert.rejects(run("export"), /EEXIST/);
  const verified = JSON.parse((await run("verify")).stdout); assert.equal(verified.status, "verified"); assert.equal(verified.sourceHash, sourceHash);
  await assert.rejects(execute(process.execPath, ["--import", "tsx/esm", cli, "verify"], { env: { ...environment, FIRESTORE_CUTOVER_BACKUP_KEY: randomBytes(32).toString("base64") } }), /authentication/);
  const migrated = JSON.parse((await run("migrate")).stdout); assert.equal(migrated.status, "migrated"); assert.equal(migrated.legacySourceRetained, true);
  const status = JSON.parse((await run("status")).stdout); assert.equal(status.status, "active"); assert.equal(status.sourceHash, sourceHash);
  assert.equal(status.recordCount, migrated.recordCount); assert.equal(status.legacySourceRetained, true);
  persistence = await FirestoreRecordPersistence.open(storageKey, namespace);
  const repository = await Repository.open(persistence); assert.deepEqual(await repository.snapshot(), state);
  assert.deepEqual((await db.doc("runtime/state").get()).data(), document);
  await assert.rejects(persistence.migrateLegacy(sourceHash), /empty target/);
  const cleanupNamespace = { ...namespace, workspaceId: `cleanup_${randomUUID().replaceAll("-", "")}` };
  const cleanupEnvironment = { ...environment, FIRESTORE_WORKSPACE_ID: cleanupNamespace.workspaceId,
    FIRESTORE_CUTOVER_BACKUP_PATH: cleanupBackupPath };
  const cleanupRun = (command, extra = {}) => execute(process.execPath, ["--import", "tsx/esm", cli, command],
    { env: { ...cleanupEnvironment, ...extra }, maxBuffer: 1_000_000 });
  await cleanupRun("export");
  abandoned = await FirestoreRecordPersistence.open(storageKey, cleanupNamespace);
  const cleanupPrepared = prepareFirestoreLegacyCutover(document, storageKey, cleanupNamespace);
  const changedDocument = { ...document, updatedAt: "2030-01-01T00:00:00.000Z" };
  await db.doc("runtime/state").set(changedDocument);
  await assert.rejects(abandoned.records.initializeStaged(cleanupPrepared.records, "abandoned_rehearsal", {
    path: "runtime/state", document,
  }), /source changed after backup verification/);
  await abandoned.close(); abandoned = undefined;
  await assert.rejects(cleanupRun("clear-staging"), /I_CONFIRM_CLEAR_UNACTIVATED_STAGING/);
  const cleared = JSON.parse((await cleanupRun("clear-staging", {
    FIRESTORE_CUTOVER_CONFIRM_CLEAR_STAGING: "I_CONFIRM_CLEAR_UNACTIVATED_STAGING",
  })).stdout);
  assert.equal(cleared.status, "cleared"); assert.ok(cleared.manifestsRemoved > 0); assert.ok(cleared.chunksRemoved > 0);
  assert.equal(cleared.backupSourceHash, sourceHash); assert.equal(cleared.legacySourceMatchesBackup, false);
  assert.equal(cleared.legacySourceRetained, true); assert.deepEqual((await db.doc("runtime/state").get()).data(), changedDocument);
  const recoveredMigration = JSON.parse((await cleanupRun("migrate")).stdout); assert.equal(recoveredMigration.status, "migrated");
  recovered = await FirestoreRecordPersistence.open(storageKey, cleanupNamespace);
  const recoveredRepository = await Repository.open(recovered); assert.deepEqual(await recoveredRepository.snapshot(), state);
  const restoreNamespace = { ...namespace, workspaceId: `restore_${randomUUID().replaceAll("-", "")}` };
  const restoreEnvironment = { ...environment, FIRESTORE_WORKSPACE_ID: restoreNamespace.workspaceId,
    FIRESTORE_CUTOVER_CONFIRM_RESTORE_SOURCE_WORKSPACE: namespace.workspaceId,
    FIRESTORE_CUTOVER_CONFIRM_DISPOSABLE_RESTORE: restoreNamespace.workspaceId };
  const restoreRun = (command, overrides = {}) => execute(process.execPath, ["--import", "tsx/esm", cli, command],
    { env: { ...restoreEnvironment, ...overrides }, maxBuffer: 1_000_000 });
  await db.doc("runtime/state").set({ payload: "deliberately-invalid-live-source", encrypted: true });
  await assert.rejects(execute(process.execPath, ["--import", "tsx/esm", cli, "restore-rehearsal"],
    { env: { ...environment, FIRESTORE_CUTOVER_CONFIRM_RESTORE_SOURCE_WORKSPACE: namespace.workspaceId,
      FIRESTORE_CUTOVER_CONFIRM_DISPOSABLE_RESTORE: namespace.workspaceId }, maxBuffer: 1_000_000 }), /different quarantined/);
  await assert.rejects(restoreRun("restore-rehearsal", { FIRESTORE_CUTOVER_CONFIRM_DISPOSABLE_RESTORE: "wrong_target" }), /exact source and disposable target/);
  const restoredReport = JSON.parse((await restoreRun("restore-rehearsal")).stdout);
  assert.equal(restoredReport.status, "restored-for-verification"); assert.equal(restoredReport.quarantineRequired, true);
  assert.equal(restoredReport.sourceNamespace.workspaceId, namespace.workspaceId); assert.equal(restoredReport.targetNamespace.workspaceId, restoreNamespace.workspaceId);
  const restoreStatus = JSON.parse((await restoreRun("restore-status")).stdout); assert.equal(restoreStatus.status, "restored-for-verification");
  restored = await FirestoreRecordPersistence.open(storageKey, restoreNamespace);
  const restoredRepository = await Repository.open(restored); assert.deepEqual(await restoredRepository.snapshot(), state);
  console.log(`PASS: operator CLI authenticated legacy export/verify/migrate/status (${migrated.recordCount} records, ${migrated.sourceBytes} plaintext bytes)`);
  console.log(`PASS: normalized reopen matched the complete source; overwrite was denied and the legacy source remained retained`);
  console.log(`PASS: confirmation-gated cleanup removed only abandoned headless staging, retained the legacy source, and permitted an exact retry`);
  console.log(`PASS: authenticated backup restored into a separately confirmed quarantined workspace without relying on the changed live source`);
  console.log(`Firestore cutover rehearsal complete in synthetic workspace ${namespace.workspaceId}. No cloud project, application data, ERP/model/email call, source deletion or production activation was used.`);
} finally {
  await restored?.close(); await recovered?.close(); await abandoned?.close(); await persistence?.close(); await db.terminate(); await rm(directory, { recursive: true, force: true });
}
