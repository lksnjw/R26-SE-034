import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { FirestoreRecordCodec, FIRESTORE_RECORD_BOUNDS as B } from "../src/storage/firestore-record-codec.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { initialState } from "../src/repository/store.js";
import { recordKey } from "../src/storage/execution-record-layout.js";

// No credentials/ADC or production fallback. Never flush an emulator or use
// an existing workspace; keep every read/write inside new synthetic namespaces.
const projectId = "demo-lcwe-records", host = process.env.FIRESTORE_EMULATOR_HOST;
if (host !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded demo project, fixed loopback Firestore emulator, and no credential file are required");
const workspaceId = `test_${randomUUID().replaceAll("-", "")}`, namespace = { projectId, databaseId: "(default)", workspaceId };
const key = randomBytes(32).toString("base64"), stores = [], create = (scope = namespace, selectedKey = key) => { const store = FirestoreRecordStore.create(selectedKey, scope); stores.push(store); return store; };
const codec = new FirestoreRecordCodec(key, namespace), store = create();
const item = (name, value) => ({ profile: "runtime-record/v1", path: ["domain", "settings", name], value });
const check = message => console.log(`PASS: ${message}`);
const rawChunkPath = record => `${store.chunkCollectionPath}/${codec.encodeRecord(record).chunks[0].id}`;
const scoped = (snapshot, path) => store.readRecords(snapshot, [path])[0];
let initialRecords;

try {
  const empty = await store.load(); assert.equal(empty.recordCount, 0);
  const state = initialState();
  state.settings.private = { token: "synthetic-private-fixture-only" };
  state.chats.chat = { id: "chat", ownerId: "fixture-owner", title: "Test conversation", createdAt: "now", updatedAt: "now", messageCount: 2, messages: [{ role: "user", text: "Read" }, { role: "assistant", text: "Confirmed fixture" }] };
  state.versions.flow = [{ version: 1 }, { version: 2 }]; initialRecords = splitFirestoreState(state);
  const first = await store.commit(empty, { transitionId: "initial-workspace-state", upsert: initialRecords });
  assert.equal(first.revision, 1); assert.deepEqual(assembleFirestoreState(store.readRecords(await store.load())), state);
  const raw = await store.db.collection(store.collectionPath).get();
  for (const row of raw.docs) {
    assert.match(row.id, /^[a-f0-9]{64}$/);
    assert.equal(row.data().payload.includes(Buffer.from("synthetic-private-fixture-only")), false);
    assert.ok(row.data().payload.length + 8192 < B.documentBytes);
  }
  const chunkRows = await store.db.collection(store.chunkCollectionPath).get();
  for (const row of chunkRows.docs) { assert.match(row.id, /^[a-f0-9]{64}-\d\d$/); assert.ok(row.data().payload.length + 8192 < B.documentBytes); }
  check(`actual server SDK encrypted startup/round-trip (${raw.size} manifests, ${chunkRows.size} bounded chunks)`);

  const deniedUrl = `http://${host}/v1/projects/${projectId}/databases/(default)/documents/${store.headPath}`;
  const deniedRead = await fetch(deniedUrl, { signal: AbortSignal.timeout(5000) }); assert.equal(deniedRead.status, 403);
  const deniedWrite = await fetch(deniedUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { malicious: { booleanValue: true } } }), signal: AbortSignal.timeout(5000) }); assert.equal(deniedWrite.status, 403);
  check("browser-style unauthenticated REST read/write denied by real emulator rules; server IAM/RBAC remains separate");

  // Force the real SDK retry path after the callback staged its first writes.
  // The wrapper is fixture instrumentation only, not an application hook.
  const actualTransaction = store.db.runTransaction.bind(store.db); let injected = false, callbacks = 0; const batches = [];
  store.db.runTransaction = (callback, options) => actualTransaction(async tx => {
    const originalSet = tx.set, set = originalSet.bind(tx), batch = [];
    tx.set = (ref, data, ...args) => { batch.push([ref.path, createHash("sha256").update(data.payload).digest("hex")]); return set(ref, data, ...args); };
    try {
      const result = await callback(tx); batches.push(batch); callbacks++;
      if (!injected) { injected = true; throw Object.assign(new Error("synthetic aborted transaction"), { code: 10 }); }
      return result;
    } finally { tx.set = originalSet; }
  }, options);
  const second = await store.commit(first, { transitionId: "real-sdk-retry", upsert: [item("retry", { answer: false })] });
  store.db.runTransaction = actualTransaction;
  assert.ok(callbacks >= 2); assert.deepEqual(batches[0], batches[1]); assert.equal(second.revision, 2);
  check(`real Firestore SDK ABORTED retry reused identical prepared writes (${callbacks} callbacks, one revision)`);

  const before = await store.db.collection(store.collectionPath).get(), beforePackets = new Map(before.docs.map(row => [row.id, row.data().payload]));
  const third = await store.commit(second, { transitionId: "one-scoped-change", upsert: [item("retry", { answer: 0 })] });
  const changedId = codec.manifestId(recordKey(item("retry", { answer: 0 }).path));
  const after = await store.db.collection(store.collectionPath).get();
  for (const row of after.docs) if (row.id !== changedId) assert.ok(row.data().payload.equals(beforePackets.get(row.id)));
  const repeat = await store.commit(second, { transitionId: "one-scoped-change", upsert: [item("retry", { answer: 0 })] }); assert.equal(repeat.revision, third.revision);
  const afterRepeat = await store.commit(repeat, { transitionId: "after-duplicate-ack", upsert: [item("retry", { answer: 1 })] }); assert.equal(afterRepeat.revision, 4);
  check("scoped update preserved unrelated ciphertext; same transition acknowledgement and next checkpoint both succeeded");

  for (const commitWasApplied of [false, true]) {
    const base = await store.load(), mutation = { transitionId: `lost-ack-${commitWasApplied}`, upsert: [item("ack", { committed: commitWasApplied })] };
    store.db.runTransaction = async (callback, options) => {
      if (commitWasApplied) await actualTransaction(callback, options);
      throw new Error("synthetic lost database acknowledgement");
    };
    await assert.rejects(store.commit(base, mutation)); assert.equal(store.writeUncertain, true);
    await assert.rejects(store.commit(base, mutation), /reloaded/);
    assert.throws(() => store.readRecords(base), /fenced/);
    store.db.runTransaction = actualTransaction;
    const loaded = await store.load(); assert.equal(loaded.revision, base.revision + Number(commitWasApplied));
    const recovered = await store.commit(base, mutation); assert.equal(recovered.revision, base.revision + 1);
  }
  check("actual emulator pre-commit and post-commit lost-ACK recovery fenced cached use and did not write twice");

  const secondWriter = create(), baseA = await store.load(), baseB = await secondWriter.load();
  const competition = await Promise.allSettled([store.commit(baseA, { transitionId: "independent-writer-a", upsert: [item("competition", "a")] }), secondWriter.commit(baseB, { transitionId: "independent-writer-b", upsert: [item("competition", "b")] })]);
  assert.equal(competition.filter(result => result.status === "fulfilled").length, 1);
  const current = await store.load(); assert.equal(current.revision, baseA.revision + 1);
  check("two independent SDK clients could not overwrite one admitted revision (CAS only, not an ownership lease)");

  const originalCollection = store.db.collection.bind(store.db); let stages = 0;
  store.db.collection = path => {
    const collection = originalCollection(path);
    if (path !== store.chunkCollectionPath) return collection;
    const doc = collection.doc.bind(collection);
    collection.doc = id => {
      const ref = doc(id), create = ref.create.bind(ref);
      ref.create = data => { if (++stages === 2) throw new Error("synthetic partial preparation failure"); return create(data); };
      return ref;
    };
    return collection;
  };
  const pending = { transitionId: "partial-staging-failure", upsert: [item("pending", "p".repeat(5_400_000))] };
  try { await assert.rejects(store.commit(current, pending), /partial preparation/); }
  finally { store.db.collection = originalCollection; }
  assert.equal(store.writeUncertain, true);
  const observer = create(), observed = await observer.load(); assert.equal(observed.revision, current.revision);
  assert.throws(() => observer.readRecords(observed, [pending.upsert[0].path]), /missing/);
  await store.load(); const preparedRecovery = await store.commit(current, pending); assert.equal(preparedRecovery.revision, current.revision + 1);
  check("partial immutable preparation remained invisible to an independent reader; authoritative reload and exact retry completed activation");

  const big = item("large", "x".repeat(5_400_000)), large = await store.commit(preparedRecovery, { transitionId: "maximum-continuation-size", upsert: [big] });
  const reopened = create(), restarted = await reopened.load();
  // Read through the reopened store, never pass another instance's snapshot.
  assert.deepEqual(reopened.readRecords(restarted, [big.path]), [big]);
  const small = await store.commit(await store.load(), { transitionId: "shrink-private-record", upsert: [item("large", "confirmed")] });
  assert.ok(small.chunkCount < large.chunkCount);
  const larger = item("larger", "x".repeat(7_900_000));
  const biggerSnapshot = await store.commit(small, { transitionId: "bounded-larger-record", upsert: [larger] });
  assert.deepEqual(store.readRecords(await store.load(), [larger.path]), [larger]);
  assert.equal(biggerSnapshot.revision, small.revision + 1);
  const limitBase = await store.load(), revisionBeforeLimit = limitBase.revision;
  await assert.rejects(store.commit(limitBase, { transitionId: "oversize-logical-record", upsert: [item("large", "x".repeat(B.recordBytes))] }), /logical record byte budget/);
  await assert.rejects(store.commit(limitBase, { transitionId: "oversize-write-count", upsert: Array.from({ length: 400 }, (_, at) => item(`new_${at}`, at)) }), /atomic transaction budget/);
  assert.equal((await store.load()).revision, revisionBeforeLimit);
  check("5.4 MB continuation survived a new client and shrank atomically; 7.9 MB staging succeeded; bounded rejection preserved authority");

  const wrongKey = create(namespace, randomBytes(32).toString("base64")); await assert.rejects(wrongKey.load());
  const changed = scoped(await store.load(), ["domain", "settings", "retry"]), path = rawChunkPath(changed), savedPacket = (await store.db.doc(path).get()).data();
  const damaged = { ...savedPacket, payload: Buffer.from(savedPacket.payload) }; damaged.payload[80] ^= 1;
  await store.db.doc(path).set(damaged);
  await assert.rejects(store.load()); assert.equal(store.writeUncertain, true);
  await store.db.doc(path).set(savedPacket); await store.load();
  await store.db.doc(path).delete(); await assert.rejects(store.load(), /referenced chunk is missing/);
  await store.db.doc(path).set(savedPacket); await store.load();
  const savedHead = (await store.db.doc(store.headPath).get()).data(), savedChunks = await store.db.collection(store.collectionPath).get();
  const otherScope = { ...namespace, workspaceId: `${workspaceId}_other` }, other = create(otherScope);
  assert.equal((await other.load()).revision, 0);
  await other.db.doc(other.headPath).set(savedHead);
  await assert.rejects(other.load());
  const extra = `${store.collectionPath}/${"a".repeat(64)}`; await store.db.doc(extra).set(savedChunks.docs[0].data());
  await assert.rejects(store.load()); await store.db.doc(extra).delete(); await store.load();
  check("actual persisted tampering, missing active chunk, wrong key, copied-workspace head and extra manifest were rejected without downgrade");

  const closingStore = create(), closingBase = await closingStore.load(), closingTransaction = closingStore.db.runTransaction.bind(closingStore.db);
  let entered, resume;
  const reading = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { resume = resolve; });
  closingStore.db.runTransaction = (callback, options) => closingTransaction(async tx => {
    const originalGetAll = tx.getAll, getAll = originalGetAll.bind(tx);
    tx.getAll = async (...refs) => {
      const rows = await getAll(...refs);
      if (refs[0]?.path.startsWith(closingStore.chunkCollectionPath + "/")) { entered(); await hold; }
      return rows;
    };
    try { return await callback(tx); } finally { tx.getAll = originalGetAll; }
  }, options);
  const closingOperation = closingStore.commit(closingBase, { transitionId: "close-at-final-reference", upsert: [item("closing", "must not activate")] });
  await reading; const closed = closingStore.close(); resume();
  await assert.rejects(closingOperation, /closed/); await closed;
  assert.equal((await store.load()).revision, closingBase.revision);
  check("close during actual SDK final reference reads denied activation and left the authoritative revision unchanged");

  const inspect = await store.db.collection(store.collectionPath).get();
  for (const row of inspect.docs) assert.ok(row.data().payload.length + 8192 < B.documentBytes);
  console.log(`Firestore foundation qualification complete in synthetic workspace ${workspaceId}. No application data, cloud project, ERP/model/email calls, durable-admission markers or production latency claim.`);
} finally {
  for (const storage of stores) await storage.close();
}
