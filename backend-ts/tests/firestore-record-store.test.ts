import { beforeEach, expect, test, vi } from "vitest";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { FirestoreRecordCodec, FIRESTORE_RECORD_BOUNDS as B } from "../src/storage/firestore-record-codec.js";
import { initialState } from "../src/repository/store.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import type { RuntimeRecord } from "../src/storage/execution-record-layout.js";
import { recordKey } from "../src/storage/execution-record-layout.js";

const runtime = vi.hoisted(() => ({ db: null as any }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { constructor(settings: any) { return new FakeClient(runtime.db, settings); } } }));
const clone = (value: any) => value && { ...value, payload: Buffer.isBuffer(value.payload) ? Buffer.from(value.payload) : value.payload };
class Database {
  documents = new Map<string, any>(); version = 0; callbacks = 0; invocations = 0;
  fault: "retry" | "before-commit" | "after-commit" | null = null;
  writes: Array<Array<{ path: string; data: any }>> = []; reads: string[] = []; settings: any[] = [];
  staged: string[] = []; stageFaultAt = -1; stageHook: (() => Promise<void>) | null = null;
}
class FakeClient {
  closed = false; constructor(readonly database: Database, readonly settings: any) { database.settings.push(settings); }
  get databaseId() { return this.settings.databaseId; }
  doc(path: string) { return { path,
    get: async () => ({ exists: this.database.documents.has(path), data: () => clone(this.database.documents.get(path)) }),
    create: async (value: any) => {
      if (this.closed) throw new Error("closed");
      this.database.staged.push(path);
      if (this.database.staged.length === this.database.stageFaultAt) throw new Error("synthetic staging failure");
      if (this.database.stageHook) await this.database.stageHook();
      if (this.database.documents.has(path)) throw Object.assign(new Error("already exists"), { code: 6 });
      this.database.documents.set(path, clone(value)); this.database.version++;
    },
  }; }
  collection(path: string) { return { doc: (id: string) => this.doc(`${path}/${id}`), limit: (limit: number) => ({ path, limit, query: true }) }; }
  async terminate() { this.closed = true; }
  async runTransaction(callback: (tx: any) => Promise<unknown>, options: any) {
    this.database.invocations++;
    for (let attempt = 0; attempt < (options.maxAttempts ?? 1); attempt++) {
      if (this.closed) throw new Error("closed");
      const start = this.database.version, image = new Map(this.database.documents), writes: Array<{ path: string; data: any }> = [];
      const row = (ref: any) => ({ id: ref.path.split("/").at(-1), exists: image.has(ref.path), data: () => clone(image.get(ref.path)) });
      const read = () => { if (writes.length) throw new Error("SDK disallows reads after writes"); };
      const tx = {
        get: async (ref: any) => { read(); this.database.reads.push(ref.path);
          if (!ref.query) return row(ref);
          const docs = [...image.keys()].filter(path => path.startsWith(ref.path + "/") && !path.slice(ref.path.length + 1).includes("/")).sort().slice(0, ref.limit).map(path => row({ path }));
          return { docs, size: docs.length, empty: !docs.length };
        },
        getAll: async (...refs: any[]) => { read(); this.database.reads.push(...refs.map(ref => ref.path)); return refs.map(row); },
        set: (ref: any, value: any) => { writes.push({ path: ref.path, data: clone(value) }); image.set(ref.path, clone(value)); },
        delete: (ref: any) => { writes.push({ path: ref.path, data: null }); image.delete(ref.path); },
      };
      this.database.callbacks++; const result = await callback(tx); this.database.writes.push(writes);
      if (options.readOnly) { if (writes.length) throw new Error("read-only write"); return result; }
      if (this.database.fault === "retry") { this.database.fault = null; continue; }
      if (this.database.fault === "before-commit") { this.database.fault = null; throw new Error("commit unconfirmed"); }
      if (this.database.version !== start) continue;
      if (writes.length) { this.database.documents = image; this.database.version++; }
      if (this.database.fault === "after-commit") { this.database.fault = null; throw new Error("commit acknowledgement lost"); }
      return result;
    }
    throw new Error("retry budget exhausted");
  }
}
const scope = { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "fixture_workspace" }, key = "k".repeat(32);
const record = (id: string, value: unknown): RuntimeRecord => ({ profile: "runtime-record/v1", path: ["domain", "settings", id], value });
let db: Database;
beforeEach(() => { db = new Database(); runtime.db = db; });
const store = () => FirestoreRecordStore.create(key, scope);
async function setup() {
  const storage = store(), empty = await storage.load();
  const first = await storage.commit(empty, { transitionId: "initial-records", upsert: [record("one", false), record("two", 0)] });
  return { storage, empty, first };
}

test("explicit client scope and authenticated snapshot are created without durability markers or implicit migration", async () => {
  const storage = store(), empty = await storage.load();
  expect(empty).toMatchObject({ revision: 0, recordCount: 0 }); expect(storage.readRecords(empty)).toEqual([]);
  expect(db.settings[0]).toMatchObject({ projectId: scope.projectId, databaseId: scope.databaseId });
  expect(storage).not.toHaveProperty("readQueueDurability"); expect(storage).not.toHaveProperty("executionCheckpointDurability");
});
test("a complete repository round-trips through normalized encrypted records", async () => {
  const storage = store(), original = initialState(); original.settings.private = { token: "synthetic-secret" };
  const saved = await storage.commit(await storage.load(), { transitionId: "initial-state", upsert: splitFirestoreState(original) });
  expect(assembleFirestoreState(storage.readRecords(await storage.load()))).toEqual(original);
  expect(saved.recordCount).toBeGreaterThan(10);
  expect([...db.documents.values()].every(value => value.payload && !value.payload.includes(Buffer.from("synthetic-secret")))).toBe(true);
});
test("scoped activation touches only the changed encrypted manifest plus head, not unrelated data", async () => {
  const { storage, first } = await setup(), before = new Map(db.documents); db.writes = []; db.reads = [];
  const second = await storage.commit(first, { transitionId: "change-one-only", upsert: [record("one", { answer: false })] });
  expect(second.revision).toBe(2); expect(db.writes[0]).toHaveLength(2);
  const changed = new Set(db.writes[0]!.map(entry => entry.path));
  for (const [path, document] of before) if (!changed.has(path)) expect(db.documents.get(path)).toEqual(document);
  expect(db.reads.filter(path => path.includes("lcwe_private_records"))).toHaveLength(1);
  const answers = storage.readRecords(second), answer = answers.find(entry => entry.path.at(-1) === "one")!; (answer.value as any).hidden = true;
  expect(storage.readRecords(second).find(entry => entry.path.at(-1) === "one")!.value).toEqual({ answer: false });
});
test("repeated same transition is a read-only acknowledgement and retains actual ciphertext for the next checkpoint", async () => {
  const { storage, empty } = await setup(); db.writes = [];
  const repeat = await storage.commit(empty, { transitionId: "initial-records", upsert: [record("two", 0), record("one", false)] });
  expect(repeat.revision).toBe(1); expect(db.writes[0]).toEqual([]);
  const next = await storage.commit(repeat, { transitionId: "after-repeat-one", upsert: [record("one", 1)] });
  expect(next.revision).toBe(2); expect(storage.readRecords(await storage.load())).toContainEqual(record("one", 1));
});
test("same identity with different content is rejected and fences cached reads/writes", async () => {
  const { storage, empty, first } = await setup();
  await expect(storage.commit(empty, { transitionId: "initial-records", upsert: [record("one", 2), record("two", 0)] })).rejects.toThrow("identity was reused");
  expect(storage.writeUncertain).toBe(true); expect(() => storage.readRecords(first)).toThrow("fenced");
  await storage.load(); expect(storage.writeUncertain).toBe(false);
});
test.each(["before-commit", "after-commit"] as const)("%s fault requires authoritative reload, then exact recovery without another write", async fault => {
  const { storage, first } = await setup(), mutation = { transitionId: "faulted-mutation", upsert: [record("one", { result: 1 })] };
  db.fault = fault; await expect(storage.commit(first, mutation)).rejects.toThrow();
  expect(storage.writeUncertain).toBe(true);
  await expect(storage.commit(first, mutation)).rejects.toThrow("reloaded");
  const loaded = await storage.load(); expect(loaded.revision).toBe(fault === "after-commit" ? 2 : 1);
  const writes = db.version, recovered = await storage.commit(first, mutation);
  expect(recovered.revision).toBe(2); expect(db.version).toBe(writes + (fault === "before-commit" ? 1 : 0));
});
test("SDK callback retry uses identical prepared ciphertext and does not increment revision twice", async () => {
  const { storage, first } = await setup(); db.fault = "retry"; db.writes = [];
  const saved = await storage.commit(first, { transitionId: "sdk-retry-once", upsert: [record("one", 5)] });
  expect(saved.revision).toBe(2); expect(db.writes).toHaveLength(2); expect(db.writes[0]).toEqual(db.writes[1]);
});
test("two clients cannot overwrite the same admitted revision", async () => {
  const { storage, first } = await setup(), other = store(), secondBase = await other.load();
  const results = await Promise.allSettled([storage.commit(first, { transitionId: "writer-one-same", upsert: [record("one", "a")] }), other.commit(secondBase, { transitionId: "writer-two-same", upsert: [record("one", "b")] })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const authority = await store().load(); expect(authority.revision).toBe(2);
});
test.each(["orphan-manifest", "ciphertext", "head", "extra-manifest", "missing-chunk", "plaintext"])("%s damage cannot be silently healed or downgraded", async damage => {
  const { storage, first } = await setup(), paths = [...db.documents.keys()], chunk = paths.find(path => path.includes("lcwe_record_chunks"))!;
  if (damage === "orphan-manifest") db.documents.delete(storage.headPath);
  if (damage === "ciphertext") { const data = db.documents.get(chunk); data.payload[80] ^= 1; }
  if (damage === "head") { const data = db.documents.get(storage.headPath); data.payload[80] ^= 1; }
  if (damage === "extra-manifest") db.documents.set(`${storage.collectionPath}/${"a".repeat(64)}`, clone(db.documents.get(paths.find(path => path.includes("lcwe_private_records"))!)));
  if (damage === "missing-chunk") db.documents.delete(chunk);
  if (damage === "plaintext") db.documents.set(chunk, { profile: "firestore-private/v1", payload: Buffer.from('{"private":"plaintext"}') });
  await expect(storage.load()).rejects.toThrow(); expect(storage.writeUncertain).toBe(true);
  await expect(storage.commit(first, { transitionId: "do-not-heal-00", upsert: [record("one", 10)] })).rejects.toThrow("reloaded");
});
test("corruption of a touched packet is rejected before any overwrite", async () => {
  const { storage, first } = await setup(), codec = new FirestoreRecordCodec(key, scope), id = codec.encodeRecord(record("one", false)).chunks[0]!.id;
  const path = `${storage.chunkCollectionPath}/${id}`, original = db.documents.get(path); original.payload[80] ^= 1;
  const head = clone(db.documents.get(storage.headPath));
  await expect(storage.commit(first, { transitionId: "touched-tamper", upsert: [record("one", true)] })).rejects.toThrow();
  expect(db.documents.get(storage.headPath)).toEqual(head); expect(db.documents.get(path)).toEqual(original);
});
test("large records activate and shrink atomically; retired immutable bodies do not appear in the active image", async () => {
  const storage = store(), original = await storage.load();
  const large = await storage.commit(original, { transitionId: "large-record-initial", upsert: [record("large", "x".repeat(5_400_000))] });
  expect(large.chunkCount).toBeGreaterThan(10);
  const small = await storage.commit(large, { transitionId: "large-record-shrink", upsert: [record("large", "answer")] });
  expect(small.chunkCount).toBe(1);
  expect([...db.documents.keys()].filter(path => path.startsWith(storage.chunkCollectionPath + "/"))).toHaveLength(large.chunkCount + 1);
  expect([...db.documents.keys()].filter(path => path.startsWith(storage.collectionPath + "/"))).toHaveLength(1);
  expect(storage.readRecords(await storage.load())).toEqual([record("large", "answer")]);
});
test("atomic metadata write/size and logical record budgets reject before SDK staging or activation", async () => {
  const { storage, first } = await setup(), calls = db.invocations, prepared = db.staged.length;
  await expect(storage.commit(first, { transitionId: "too-many-documents", upsert: Array.from({ length: B.transactionWrites }, (_, at) => record(`new_${at}`, at)) })).rejects.toThrow("atomic transaction budget");
  await expect(storage.commit(first, { transitionId: "too-many-bytes-00", upsert: [record("large", "x".repeat(B.recordBytes))] })).rejects.toThrow("logical record byte budget");
  await expect(storage.commit(first, { transitionId: "too-much-metadata", upsert: Array.from({ length: 160 }, (_, at) => ({ ...record(`new_${at}`, at), path: ["a".repeat(4000), "b".repeat(4000), "c".repeat(4000), `new_${at}`] })) })).rejects.toThrow("atomic transaction budget");
  expect(db.staged.length).toBe(prepared);
  expect(db.invocations).toBe(calls); expect(storage.writeUncertain).toBe(false);
});

test("a 7.9 MB record fits bounded staging without becoming a giant transaction", async () => {
  const storage = store(), large = record("large", "x".repeat(7_900_000));
  const saved = await storage.commit(await storage.load(), { transitionId: "larger-private-record", upsert: [large] });
  expect(saved.chunkCount).toBeGreaterThan(20); expect(db.writes.at(-1)).toHaveLength(2);
  expect(db.writes.at(-1)!.reduce((sum, write) => sum + write.data.payload.length, 0)).toBeLessThan(24_000);
  expect(storage.readRecords(await storage.load())).toEqual([large]);
});

test("partial preparation never advances authority; healthy reload and exact retry can finish it", async () => {
  const { storage, first } = await setup(), before = clone(db.documents.get(storage.headPath));
  db.stageFaultAt = db.staged.length + 2;
  const mutation = { transitionId: "partial-staging-fault", upsert: [record("large", "x".repeat(5_400_000))] };
  await expect(storage.commit(first, mutation)).rejects.toThrow("staging failure");
  expect(db.documents.get(storage.headPath)).toEqual(before); expect(storage.writeUncertain).toBe(true);
  const reader = store(), observed = await reader.load(); expect(observed.revision).toBe(1);
  expect(reader.readRecords(observed, [record("one", false).path, record("two", 0).path])).toEqual([record("one", false), record("two", 0)]);
  await storage.load(); db.stageFaultAt = -1;
  const recovered = await storage.commit(first, mutation); expect(recovered.revision).toBe(2);
  expect(storage.readRecords(await storage.load(), [mutation.upsert[0]!.path])).toEqual(mutation.upsert);
});

test("staged content-address collisions are authenticated and never overwritten", async () => {
  const { storage, first } = await setup(), value = record("new", "answer"), codec = new FirestoreRecordCodec(key, scope), encoded = codec.encodeRecord(value);
  const path = `${storage.chunkCollectionPath}/${encoded.chunks[0]!.id}`, alien = codec.encodeRecord(record("other", "private"));
  db.documents.set(path, alien.chunks[0]!.document);
  const saved = clone(db.documents.get(path)), head = clone(db.documents.get(storage.headPath));
  await expect(storage.commit(first, { transitionId: "staged-collision-test", upsert: [value] })).rejects.toThrow();
  expect(db.documents.get(path)).toEqual(saved); expect(db.documents.get(storage.headPath)).toEqual(head);
});

test("unreferenced stage packets do not activate even in an empty workspace, but orphan manifests reject", async () => {
  const storage = store(), codec = new FirestoreRecordCodec(key, scope), encoded = codec.encodeRecord(record("not-active", true));
  db.documents.set(`${storage.chunkCollectionPath}/${encoded.chunks[0]!.id}`, encoded.chunks[0]!.document);
  expect((await storage.load()).revision).toBe(0);
  db.documents.set(`${storage.collectionPath}/${codec.manifestId(recordKey(encoded.record.path))}`, codec.encodeHead({ profile: "firestore-record-manifest/v1", key: encoded.key, hash: encoded.hash, bytes: encoded.bytes.length, chunks: encoded.chunks.map(chunk => chunk.id) }));
  await expect(storage.load()).rejects.toThrow("no authoritative head");
});

test("close waits for in-flight staging and refuses subsequent activation or cached success", async () => {
  const { storage, first } = await setup(), head = clone(db.documents.get(storage.headPath)); let resume!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { resume = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  db.stageHook = async () => { started(); await hold; };
  const operation = storage.commit(first, { transitionId: "close-during-stage", upsert: [record("one", true)] });
  await entered; const close = storage.close(); resume();
  await expect(operation).rejects.toThrow("closed"); await close;
  expect(db.writes.at(-1)).toHaveLength(3); expect(db.documents.get(storage.headPath)).toEqual(head);
});

test("a staging failure drains already-started writes before recovery obtains the store mutex", async () => {
  const { storage, first } = await setup(); let resume!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  db.stageHook = async () => { entered(); await hold; }; db.stageFaultAt = db.staged.length + 2;
  let settled = false, loaded = false;
  const operation = storage.commit(first, { transitionId: "drain-inflight-stage", upsert: [record("large", "x".repeat(5_400_000))] });
  const failure = operation.catch(error => { settled = true; return error; });
  await started; const reload = storage.load().then(snapshot => { loaded = true; return snapshot; });
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false); expect(loaded).toBe(false);
  resume(); expect((await failure).message).toMatch(/staging failure/);
  expect((await reload).revision).toBe(1); const prepared = db.staged.length;
  await new Promise(resolve => setImmediate(resolve)); expect(db.staged.length).toBe(prepared);
});

test("close during final reference reads denies activation before transaction writes", async () => {
  const { storage, first } = await setup(), head = clone(db.documents.get(storage.headPath));
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { resume = resolve; });
  const original = storage.db.runTransaction.bind(storage.db);
  storage.db.runTransaction = ((callback: any, options: any) => original(async (tx: any) => {
    const get = tx.getAll.bind(tx);
    tx.getAll = async (...refs: any[]) => { const rows = await get(...refs); if (refs[0]?.path.includes("lcwe_record_chunks")) { entered(); await hold; } return rows; };
    return callback(tx);
  }, options)) as any;
  const operation = storage.commit(first, { transitionId: "close-at-activation", upsert: [record("one", true)] });
  await reading; const close = storage.close(); resume();
  await expect(operation).rejects.toThrow("closed"); await close;
  expect(db.documents.get(storage.headPath)).toEqual(head); expect(db.writes.at(-1)).toHaveLength(3);
});

test.each(["missing", "tampered", "wrong-address", "wrong-count", "head-totals"])("%s manifest/reference damage fails authoritative startup", async damage => {
  const { storage } = await setup(), codec = new FirestoreRecordCodec(key, scope), id = codec.manifestId(recordKey(record("one", false).path)), path = `${storage.collectionPath}/${id}`;
  const document = db.documents.get(path), value = codec.decodeHead(document) as any;
  if (damage === "missing") db.documents.delete(path);
  if (damage === "tampered") document.payload[80] ^= 1;
  if (damage === "wrong-address") { value.chunks[0] = codec.encodeRecord(record("other", false)).chunks[0]!.id; db.documents.set(path, codec.encodeHead(value)); }
  if (damage === "wrong-count") { value.chunks.push(value.chunks[0]); db.documents.set(path, codec.encodeHead(value)); }
  if (damage === "head-totals") { const head = codec.decodeHead(db.documents.get(storage.headPath)) as any; head.bytes++; db.documents.set(storage.headPath, codec.encodeHead(head)); }
  await expect(storage.load()).rejects.toThrow(); expect(storage.writeUncertain).toBe(true);
});

test("removal activates only manifest deletion and preserves other records plus retired bodies", async () => {
  const { storage, first } = await setup(), bodyCount = [...db.documents.keys()].filter(path => path.startsWith(storage.chunkCollectionPath)).length;
  const next = await storage.commit(first, { transitionId: "remove-one-record", upsert: [], remove: [record("one", false).path] });
  expect(next.recordCount).toBe(1); expect(next.chunkCount).toBe(1);
  expect(db.writes.at(-1)).toHaveLength(2); expect(db.writes.at(-1)![0]!.data).toBeNull();
  expect([...db.documents.keys()].filter(path => path.startsWith(storage.chunkCollectionPath))).toHaveLength(bodyCount);
  expect(storage.readRecords(await storage.load())).toEqual([record("two", 0)]);
});
test("unknown/copied snapshots, duplicate mutation addresses and invalid identities never reach the SDK", async () => {
  const { storage, first } = await setup(), other = store(), calls = db.invocations;
  await expect(other.commit(first, { transitionId: "wrong-instance-00", upsert: [record("one", true)] })).rejects.toThrow("does not belong");
  await expect(storage.commit({ ...first }, { transitionId: "copied-snapshot-00", upsert: [record("one", true)] })).rejects.toThrow("does not belong");
  await expect(storage.commit(first, { transitionId: "duplicate-address-00", upsert: [record("one", false), record("one", true)] })).rejects.toThrow("Duplicate");
  await expect(storage.commit(first, { transitionId: "?secret=private", upsert: [record("one", false)] })).rejects.toThrow("Invalid bounded");
  expect(db.invocations).toBe(calls);
});
test("closed stores refuse cached reads and writes", async () => {
  const { storage, first } = await setup(); await storage.close();
  expect(() => storage.readRecords(first)).toThrow("closed"); await expect(storage.load()).rejects.toThrow("closed");
  await expect(storage.commit(first, { transitionId: "closed-operation", upsert: [] })).rejects.toThrow("closed");
});
