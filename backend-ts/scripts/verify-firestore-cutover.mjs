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
const db = new Firestore({ projectId, databaseId: "(default)" }); let persistence;
const directory = await mkdtemp(join(tmpdir(), "lcwe-firestore-cutover-")), backupPath = join(directory, "backup.json");
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
  console.log(`PASS: operator CLI authenticated legacy export/verify/migrate/status (${migrated.recordCount} records, ${migrated.sourceBytes} plaintext bytes)`);
  console.log(`PASS: normalized reopen matched the complete source; overwrite was denied and the legacy source remained retained`);
  console.log(`Firestore cutover rehearsal complete in synthetic workspace ${namespace.workspaceId}. No cloud project, application data, ERP/model/email call, source deletion or production activation was used.`);
} finally {
  await persistence?.close(); await db.terminate(); await rm(directory, { recursive: true, force: true });
}
