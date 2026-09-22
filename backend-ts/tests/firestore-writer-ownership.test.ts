import { beforeEach, expect, test } from "vitest";
import type { Firestore } from "@google-cloud/firestore";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { FirestoreWriterOwnership, FIRESTORE_WRITER_BOUNDS as B } from "../src/storage/firestore-writer-ownership.js";
import { Database, FakeClient, clone } from "./fixtures/fake-firestore.js";

const scope = { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "ownership_fixture" }, codec = new FirestoreRecordCodec("k".repeat(32), scope);
let db: Database, wall: number, monotonic: number;
const clock = { sample: () => ({ wall, monotonic }) };
const owner = (selected = codec, duration: number = B.duration) => new FirestoreWriterOwnership(new FakeClient(db, { projectId: scope.projectId, databaseId: scope.databaseId }) as unknown as Firestore, selected, duration, clock);
const tick = (ms: number) => { wall += ms; monotonic += ms; db.serverTime += ms; };
const lease = (storage: FirestoreWriterOwnership) => codec.decodeHead(db.documents.get(storage.path)) as any;
beforeEach(() => { db = new Database(); db.serverTime = 1_000_000; wall = 100_000_000; monotonic = 1_000; });

test("server-time scoped encrypted ownership is acquired without relying on matching host wall time", async () => {
  const storage = owner(); await storage.acquire(); storage.assertActive();
  const value = lease(storage); expect(value).toMatchObject({ state: "HELD", generation: 1, sequence: 1, acquiredAt: db.serverTime, issuedAt: db.serverTime, expiresAt: db.serverTime + B.duration });
  expect(db.documents.get(storage.path).payload.includes(Buffer.from(value.ownerId))).toBe(false);
});

test("two independent clients cannot both acquire an active namespace", async () => {
  const first = owner(), second = owner();
  const results = await Promise.allSettled([first.acquire(), second.acquire()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const winner = results[0]!.status === "fulfilled" ? first : second, loser = winner === first ? second : first;
  winner.assertActive(); expect(() => loser.assertActive()).toThrow("fenced"); expect(lease(winner).generation).toBe(1);
});

test("renewal preserves generation and token, extends authority only after ACK and repeats identical callback ciphertext", async () => {
  const storage = owner(); await storage.acquire(); const initial = lease(storage); tick(10_000); db.fault = "retry"; db.writes = [];
  await storage.renew(); const renewed = lease(storage);
  expect(renewed).toMatchObject({ generation: initial.generation, ownerId: initial.ownerId, leaseId: initial.leaseId, sequence: 2, issuedAt: db.serverTime });
  expect(db.writes).toHaveLength(2); expect(db.writes[0]).toEqual(db.writes[1]); tick(20_000); storage.assertActive();
});

test.each(["before-commit", "after-commit"] as const)("%s acquisition uncertainty never grants final-entry authority", async fault => {
  const storage = owner(); db.fault = fault;
  await expect(storage.acquire()).rejects.toThrow("fenced"); expect(() => storage.assertActive()).toThrow("fenced");
  await expect(storage.renew()).rejects.toThrow("fenced"); await storage.close();
  expect(db.documents.has(storage.path)).toBe(fault === "after-commit");
});

test.each(["before-commit", "after-commit"] as const)("%s renewal uncertainty fences old cached authority and preserves the remote result", async fault => {
  const storage = owner(); await storage.acquire(); tick(5_000); db.fault = fault; let denials = 0;
  storage.observeUnavailable(() => { denials++; });
  await expect(storage.renew()).rejects.toThrow("fenced"); expect(() => storage.assertActive()).toThrow("fenced");
  expect(denials).toBe(1); expect(lease(storage).sequence).toBe(fault === "after-commit" ? 2 : 1);
  const packet = clone(db.documents.get(storage.path)); await storage.close(); expect(db.documents.get(storage.path)).toEqual(packet);
});

test("the conservative local deadline denies before server lease expiry and cannot be revived by renewal", async () => {
  const storage = owner(); await storage.acquire(); tick(B.duration - B.entryMargin);
  expect(lease(storage).expiresAt).toBeGreaterThan(db.serverTime); expect(() => storage.assertActive()).toThrow("fenced");
  await expect(storage.renew()).rejects.toThrow("fenced");
});

test("expired ownership transfers to a new generation; old controller cannot write or release its successor", async () => {
  const first = owner(); await first.acquire(); tick(B.duration); const second = owner(); await second.acquire();
  const value = lease(second); expect(value.generation).toBe(2); expect(() => first.assertActive()).toThrow();
  await expect(first.withAuthority(() => first.db.runTransaction(tx => first.assertTransaction(tx), { maxAttempts: 1 }))).rejects.toThrow();
  const packet = clone(db.documents.get(second.path)); await first.close(); expect(db.documents.get(second.path)).toEqual(packet); second.assertActive();
});

test("explicit close revokes synchronously and retains a released generation for safe immediate handoff", async () => {
  const first = owner(); await first.acquire(); const close = first.close(); expect(() => first.assertActive()).toThrow(); await close;
  expect(lease(first).state).toBe("RELEASED");
  const second = owner(); await second.acquire(); expect(lease(second).generation).toBe(2); second.assertActive();
});

test("close drains an acknowledged authority operation without turning its closed final-entry guard into lease uncertainty", async () => {
  const storage = owner(); await storage.acquire();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const operation = storage.withAuthority(async () => { enter(); await gate; return "acknowledged"; });
  await entered; const closing = storage.close(); resume();
  const outcomes = await Promise.allSettled([operation, closing]);
  expect(outcomes[0]!.status).toBe("rejected"); expect(outcomes[1]!.status).toBe("fulfilled");
  expect(storage.failureReason).toBeNull(); expect(lease(storage).state).toBe("RELEASED");
  const successor = owner(); await successor.acquire(); successor.assertActive(); await successor.close();
});

test("closed transaction entry remains denied but permits exact release of a previously confirmed lease", async () => {
  const storage = owner(); await storage.acquire();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const operation = storage.withAuthority(async () => { enter(); await gate;
    await storage.db.runTransaction(async transaction => { await storage.assertTransaction(transaction);
      transaction.set(storage.db.doc("fixture/never-written"), { payload: Buffer.from("must not write") }); }, { maxAttempts: 1 });
  });
  await entered; const closing = storage.close(); resume();
  const outcomes = await Promise.allSettled([operation, closing]);
  expect(outcomes[0]!.status).toBe("rejected"); expect(outcomes[1]!.status).toBe("fulfilled");
  expect(db.documents.has("fixture/never-written")).toBe(false);
  expect(storage.failureReason).toBeNull(); expect(lease(storage).state).toBe("RELEASED");
});

test("a renewal queued before shutdown is denied without stranding the confirmed lease", async () => {
  const storage = owner(); await storage.acquire();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const operation = storage.withAuthority(async () => { enter(); await gate; });
  await entered; const renewing = storage.renew(), closing = storage.close(); resume();
  const outcomes = await Promise.allSettled([operation, renewing, closing]);
  expect(outcomes.map(value => value.status)).toEqual(["rejected", "rejected", "fulfilled"]);
  expect(storage.failureReason).toBeNull(); expect(lease(storage).state).toBe("RELEASED");
  const successor = owner(); await successor.acquire(); await successor.close();
});

test.each(["lease", "anchor"])("shutdown during the awaited transaction %s read rejects writes but releases the confirmed lease", async phase => {
  const storage = owner(); await storage.acquire();
  const original = storage.db.runTransaction.bind(storage.db);
  let enter!: () => void, resume!: () => void, gated = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  storage.db.runTransaction = (async (callback: any, options: any) => original(async (transaction: any) => {
    const get = transaction.get.bind(transaction);
    transaction.get = async (reference: any) => {
      const row = await get(reference);
      if (!gated && reference.path === (phase === "lease" ? storage.path : storage.anchorPath)) { gated = true; enter(); await gate; }
      return row;
    };
    return callback(transaction);
  }, options)) as any;
  const operation = storage.withAuthority(() => storage.db.runTransaction(async transaction => {
    await storage.assertTransaction(transaction);
    transaction.set(storage.db.doc("fixture/never-written"), { payload: Buffer.from("must not write") });
  }, { maxAttempts: 1 }));
  await entered; const closing = storage.close(); resume();
  const outcomes = await Promise.allSettled([operation, closing]);
  expect(outcomes.map(value => value.status)).toEqual(["rejected", "fulfilled"]);
  expect(db.documents.has("fixture/never-written")).toBe(false);
  expect(storage.failureReason).toBeNull(); expect(lease(storage).state).toBe("RELEASED");
  const successor = owner(); await successor.acquire(); await successor.close();
});

test.each(["before-callback", "after-commit"])("close drains an acknowledged in-flight renewal at %s before exact release", async phase => {
  const storage = owner(); await storage.acquire(); tick(5_000);
  const original = storage.db.runTransaction.bind(storage.db);
  let enter!: () => void, resume!: () => void, gated = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  storage.db.runTransaction = (async (callback: any, options: any) => {
    if (gated) return original(callback, options);
    gated = true;
    if (phase === "before-callback") { enter(); await gate; }
    const result = await original(callback, options);
    if (phase === "after-commit") { enter(); await gate; }
    return result;
  }) as any;
  const renewing = storage.renew(); await entered;
  const closing = storage.close(); expect(() => storage.assertActive()).toThrow("fenced");
  resume();
  const outcomes = await Promise.allSettled([renewing, closing]);
  expect(outcomes.every(result => result.status === "fulfilled")).toBe(true);
  expect(storage.failureReason).toBeNull(); expect(lease(storage).state).toBe("RELEASED");
  const successor = owner(); await successor.acquire(); expect(successor.generation).toBe(2); await successor.close();
});

test("shutdown during a genuinely unacknowledged renewal never releases or overwrites the uncertain lease", async () => {
  const storage = owner(); await storage.acquire(); tick(5_000);
  const original = storage.db.runTransaction.bind(storage.db);
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  storage.db.runTransaction = (async (callback: any, options: any) => {
    const result = await original(callback, options); enter(); await gate;
    throw new Error(`Synthetic lost ACK ${String(result)}`);
  }) as any;
  const renewing = storage.renew(); await entered; const closing = storage.close(); resume();
  const outcomes = await Promise.allSettled([renewing, closing]);
  expect(outcomes[0]!.status).toBe("rejected"); expect(outcomes[1]!.status).toBe("fulfilled");
  expect(storage.failureReason).toBe("UNCONFIRMED"); expect(lease(storage)).toMatchObject({ state: "HELD", sequence: 2 });
  const saved = clone(db.documents.get(storage.path)), contender = owner();
  await expect(contender.acquire()).rejects.toMatchObject({ reason: "WRITER_HELD" });
  expect(db.documents.get(storage.path)).toEqual(saved); await contender.close();
});

test("a failed release retains a bounded reason and never overwrites its last confirmed lease", async () => {
  const storage = owner(); await storage.acquire(); const saved = clone(db.documents.get(storage.path));
  db.serverTime--;
  await storage.close();
  expect(storage.failureReason).toBe("SERVER_TIME_REGRESSED");
  expect(db.documents.get(storage.path)).toEqual(saved);
  expect(() => storage.assertActive()).toThrow("fenced");
});

test("unconfirmed SDK acquisition is sanitized and the reason remains latched", async () => {
  const storage = owner(), sensitive = "synthetic-credential-must-not-appear";
  storage.db.runTransaction = (async () => { throw new Error(sensitive); }) as any;
  let failure: unknown;
  try { await storage.acquire(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ reason: "UNCONFIRMED" });
  expect(String(failure)).not.toContain(sensitive); expect(JSON.stringify(failure)).not.toContain(sensitive);
  expect(storage.failureReason).toBe("UNCONFIRMED"); await storage.close();
  expect(storage.failureReason).toBe("UNCONFIRMED");
});

test("a competing live writer reports held without exposing or changing its identity", async () => {
  const first = owner(); await first.acquire(); const saved = clone(db.documents.get(first.path)), second = owner();
  await expect(second.acquire()).rejects.toMatchObject({ reason: "WRITER_HELD" });
  expect(second.failureReason).toBe("WRITER_HELD"); expect(db.documents.get(first.path)).toEqual(saved);
  await second.close(); first.assertActive(); await first.close(); expect(first.failureReason).toBeNull();
});

test.each(["wall-backward", "monotonic-backward", "wall-jump", "nan"])("%s clock uncertainty latches denial without relying on timers", async mode => {
  const storage = owner(); await storage.acquire(); tick(100);
  if (mode === "wall-backward") wall -= 200;
  if (mode === "monotonic-backward") monotonic -= 200;
  if (mode === "wall-jump") wall += B.clockTolerance + 1;
  if (mode === "nan") monotonic = NaN;
  expect(() => storage.assertActive()).toThrow(); wall = 100_000_100; monotonic = 1_100; expect(() => storage.assertActive()).toThrow();
});

test("late acquisition acknowledgement cannot grant a fresh lease deadline", async () => {
  const storage = owner(), original = storage.db.runTransaction.bind(storage.db);
  storage.db.runTransaction = (async (callback: any, options: any) => { const result = await original(callback, options); tick(B.duration); return result; }) as any;
  await expect(storage.acquire()).rejects.toThrow(); expect(() => storage.assertActive()).toThrow(); expect(lease(storage).state).toBe("HELD");
});

test.each(["ciphertext", "plaintext", "extra-field", "future-time", "copied-scope"])("%s persisted lease damage denies takeover without overwrite", async damage => {
  const first = owner(); await first.acquire(); const document = db.documents.get(first.path), value = lease(first);
  if (damage === "ciphertext") document.payload[80] ^= 1;
  if (damage === "plaintext") document.payload = Buffer.from(JSON.stringify(value));
  if (damage === "extra-field") db.documents.set(first.path, codec.encodeHead({ ...value, extra: true }));
  if (damage === "future-time") db.documents.set(first.path, codec.encodeHead({ ...value, state: "RELEASED", acquiredAt: db.serverTime + B.duration + 1, issuedAt: db.serverTime + B.duration + 1, expiresAt: db.serverTime + B.duration + 1 }));
  if (damage === "copied-scope") db.documents.set(first.path, new FirestoreRecordCodec("k".repeat(32), { ...scope, workspaceId: "other" }).encodeHead(value));
  const saved = clone(db.documents.get(first.path)); tick(B.duration); const second = owner();
  await expect(second.acquire()).rejects.toThrow(); expect(db.documents.get(first.path)).toEqual(saved);
});

test("a scoped transaction checks acknowledged ownership before any data writes", async () => {
  const storage = owner(); await storage.acquire();
  await storage.withAuthority(() => storage.db.runTransaction(async tx => { await storage.assertTransaction(tx); tx.set(storage.db.doc("fixture/data"), { profile: "fixture", payload: Buffer.from("fixture") }); }, { maxAttempts: 1 }));
  const value = lease(storage); db.documents.set(storage.path, codec.encodeHead({ ...value, ownerId: "a".repeat(32) }));
  await expect(storage.withAuthority(() => storage.db.runTransaction(async tx => { await storage.assertTransaction(tx); tx.set(storage.db.doc("fixture/data"), { payload: Buffer.from("must not write") }); }, { maxAttempts: 1 }))).rejects.toThrow();
  expect(db.documents.get("fixture/data").payload.toString()).toBe("fixture"); expect(() => storage.assertActive()).toThrow();
});

test.each(["lease", "anchor"])("a deleted %s cannot create another controller while old cached authority may still exist", async deleted => {
  const first = owner(); await first.acquire(); db.documents.delete(deleted === "lease" ? first.path : first.anchorPath);
  const second = owner(), before = new Map(db.documents); await expect(second.acquire()).rejects.toThrow(); expect(db.documents).toEqual(before);
  await expect(first.withAuthority(() => first.db.runTransaction(tx => first.assertTransaction(tx), { readOnly: true }))).rejects.toThrow();
  expect(() => first.assertActive()).toThrow();
});
