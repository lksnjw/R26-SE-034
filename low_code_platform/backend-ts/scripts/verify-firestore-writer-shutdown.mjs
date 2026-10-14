import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { boundedOperation } from "../src/core/bounded-operation.js";

const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback demo emulator and no credential file are required");
const namespace = { projectId, databaseId: "(default)", workspaceId: `test_${randomUUID().replaceAll("-", "")}_shutdown` };
const key = randomBytes(32).toString("base64"), codec = new FirestoreRecordCodec(key, namespace);
let repository, adapter, resume;
try {
  for (let cycle = 0; cycle < 40; cycle++) {
    const phases = ["before-callback", "after-commit", "record-after-commit", "record-before-callback",
      "record-lease-read", "record-anchor-read", "record-queued-renewal"];
    const phase = phases[cycle % phases.length];
    adapter = await FirestoreRecordPersistence.open(key, namespace); repository = await Repository.open(adapter);
    if (cycle) assert.equal((await repository.snapshot()).settings.shutdownFixture.cycle, cycle - 1);
    await repository.mutate(state => { state.settings.shutdownFixture = { cycle, phase }; });
    const original = adapter.records.db.runTransaction.bind(adapter.records.db);
    let enter, gated = false;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    adapter.records.db.runTransaction = async (callback, options) => {
      if (gated) return original(callback, options);
      gated = true;
      if (phase === "before-callback" || phase === "record-before-callback") { enter(); await gate; }
      const observedCallback = phase.endsWith("-read") ? async transaction => {
        const get = transaction.get.bind(transaction);
        transaction.get = async reference => {
          const row = await get(reference);
          const target = phase === "record-lease-read" ? adapter.records.writerPath : adapter.records.writerGenerationPath;
          if (reference.path === target) { enter(); await gate; }
          return row;
        };
        return callback(transaction);
      } : callback;
      const result = await original(observedCallback, options);
      if (phase === "after-commit" || phase === "record-after-commit" || phase === "record-queued-renewal") { enter(); await gate; }
      return result;
    };
    // Observe rejection immediately: close invalidates the adapter even when
    // its owned, already-entered renewal is acknowledged and safely drained.
    const renewal = (phase.startsWith("record") ? adapter.probe() : adapter.renewOwnership()).then(() => "acknowledged", () => "closed");
    await boundedOperation(() => entered, { timeoutMs: 20_000, label: "Owned renewal shutdown fixture" });
    const queued = phase === "record-queued-renewal" ? adapter.renewOwnership().then(() => "acknowledged", () => "closed") : undefined;
    const closing = repository.close(); assert.throws(() => repository.assertAuthority()); resume(); resume = undefined;
    await Promise.all([renewal, queued, closing]);
    assert.equal(adapter.records.writerFailureReason, null);
    repository = undefined; adapter = undefined;
    // The next cycle must reopen immediately, without expiry waits/retry or
    // lease deletion. Each reopened repository checks the prior saved value.
    console.log(`PASS: shutdown cycle ${cycle + 1}/40 at ${phase}`);
  }
  adapter = await FirestoreRecordPersistence.open(key, namespace); repository = await Repository.open(adapter);
  assert.equal((await repository.snapshot()).settings.shutdownFixture.cycle, 39);
  const lease = await adapter.records.db.doc(adapter.records.writerPath).get();
  assert.equal(codec.decodeHead(lease.data()).state, "HELD");
  console.log("PASS: actual acknowledged renewal/record-read/queued-renewal shutdown races release exactly and preserve state; not lost-ACK takeover, full runtime or production qualification");
} finally {
  resume?.();
  try { await repository?.close(); } finally { await adapter?.close(); }
}
