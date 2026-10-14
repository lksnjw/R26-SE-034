import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";

// No credentials, existing workspaces, emulator flush, live tools or provider.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded demo project, fixed loopback Firestore emulator and no credential file are required");
const cycles = Number(process.env.LCWE_WRITER_RESTART_CYCLES ?? 200);
if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 1000) throw new Error("Restart cycles must be an integer from 1 to 1000");
const namespace = { projectId, databaseId: "(default)", workspaceId: `test_${randomUUID().replaceAll("-", "")}_writer_restarts` };
const key = randomBytes(32).toString("base64"), codec = new FirestoreRecordCodec(key, namespace), observer = FirestoreRecordStore.create(key, namespace);
let repository, adapter, lastReleaseReason = null;
try {
  for (let cycle = 0; cycle < cycles; cycle++) {
    adapter = await FirestoreRecordPersistence.open(key, namespace);
    repository = await Repository.open(adapter); repository.assertAuthority();
    if (cycle) assert.equal((await repository.snapshot()).settings.writerRestartFixture.cycle, cycle - 1);
    await repository.mutate(state => { state.settings.writerRestartFixture = { cycle, label: "Synthetic restart only" }; });
    await adapter.renewOwnership(); await adapter.probe();
    await repository.close(); repository = undefined;
    lastReleaseReason = adapter.records.writerFailureReason;
    assert.equal(lastReleaseReason, null, "A closed writer must have a confirmed release, not silent expiry");
    adapter = undefined;
    if ((cycle + 1) % 25 === 0 || cycle + 1 === cycles) console.log(`PASS: ${cycle + 1}/${cycles} actual Firestore writer release/reacquisition and saved-revision cycles`);
  }
  console.log("Writer restart qualification complete. Fresh demo emulator records only; not full runtime, failover/load, cloud or live ERP/model certification.");
} catch (error) {
  // Read only the bounded lease state, never its identities or ciphertext.
  try {
    const row = await observer.db.doc(observer.writerPath).get(), lease = row.exists ? codec.decodeHead(row.data()) : null;
    console.error("Writer restart diagnostic", { lastReleaseReason: adapter?.records.writerFailureReason ?? lastReleaseReason,
      writerState: lease?.state ?? "ABSENT", leaseRemainingMs: lease ? lease.expiresAt - row.readTime.toMillis() : null });
  } catch { console.error("Writer restart diagnostic could not read the authoritative lease; the original error is retained"); }
  throw error;
} finally {
  try { await repository?.close(); } finally { try { await adapter?.close(); } finally { await observer.close(); } }
}
