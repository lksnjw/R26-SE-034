import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { FirestoreChatCancellation } from "../src/storage/firestore-chat-cancellation.js";
import { Repository, effectiveUserFromState } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";

const runtime = vi.hoisted(() => ({ db: null as any }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { constructor(settings: any) { return new FakeClient(runtime.db, settings); } },
  default: { v1: { FirestoreClient: class { constructor(settings: any) { return new FakeStopClient(runtime.db, settings); } } } } }));
const namespace = { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "stop_disposal_fixture" }, key = "x".repeat(32);
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", STORAGE_ENCRYPTION_KEY: key, FIRESTORE_PROJECT_ID: namespace.projectId,
  FIRESTORE_DATABASE_ID: namespace.databaseId, FIRESTORE_WORKSPACE_ID: namespace.workspaceId, MCP_MODE: "mock" });
let db: Database;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => { db = new Database(); runtime.db = db; FakeStopClient.hold = false; FakeStopClient.onRead = undefined; FakeStopClient.instances = []; });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(closers.splice(0).map(close => close())); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type Outcome<T> = { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown };
function observe<T>(promise: Promise<T>) {
  let current: Outcome<T> | undefined;
  const done = promise.then(value => { current = { kind: "resolved", value }; return current; }, error => { current = { kind: "rejected", error }; return current; });
  return { done, current: () => current };
}
async function setup(ownsRecords = false) {
  const fixture = await boundedChatFixture(); let seed;
  try { await fixture.send(); seed = await fixture.repository.snapshot(); } finally { await fixture.close(); }
  const persistence = await FirestoreRecordPersistence.open(key, namespace), repository = await Repository.open(persistence);
  closers.push(() => repository.close()); await repository.mutate(state => { Object.assign(state, seed); });
  const records = FirestoreRecordStore.create(key, namespace), control = new FirestoreChatCancellation(records, config, ownsRecords);
  closers.push(() => records.close());
  const state = await control.snapshot(), actor = effectiveUserFromState(state, "owner")!, operation = Object.values(state.chatOperations)[0]!;
  return { records, control, state, actor, operation };
}
const intents = () => [...db.documents.keys()].filter(path => path.includes("/lcwe_chat_stop_intents/"));
function expectUnconfirmed(outcome: Outcome<void> | undefined) {
  expect.soft(outcome, "close must reject safely within the one-second cleanup budget while raw work is held").toMatchObject({
    kind: "rejected", error: { message: expect.stringMatching(/cleanup unconfirmed/i) },
  });
}

test("aborted held snapshot has bounded uncertain close and no late record decoding", async () => {
  const f = await setup(), entered = gate(), held = gate(), originalLoad = f.records.load.bind(f.records);
  const load = vi.spyOn(f.records, "load").mockImplementation(async () => {
    const image = await originalLoad(); entered.release(); await held.promise; return image;
  });
  const decode = vi.spyOn(f.records, "readRecords"), recordsClose = vi.spyOn(f.records, "close");
  const controller = new AbortController(); vi.useFakeTimers();
  const caller = observe(f.control.snapshot(controller.signal)); let closing: ReturnType<typeof observe<void>> | undefined;
  let withinBudget: Outcome<void> | undefined, decodedAfterRelease = -1;
  try {
    await entered.promise; controller.abort();
    expect(await caller.done).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
    closing = observe(f.control.close()); await vi.advanceTimersByTimeAsync(1_000); withinBudget = closing.current();
  } finally {
    held.release(); await vi.advanceTimersByTimeAsync(0); decodedAfterRelease = decode.mock.calls.length;
    await caller.done; await (closing ?? observe(f.control.close())).done;
  }
  expectUnconfirmed(withinBudget);
  expect.soft(decodedAfterRelease, "abandoned load continuation must not decode/register a late authority image").toBe(0);
  expect.soft(load).toHaveBeenCalledOnce(); expect.soft(recordsClose, "borrowed record store must remain open").not.toHaveBeenCalled();
  expect.soft((f.records.db as unknown as FakeClient).closed).toBe(false); expect.soft(intents()).toHaveLength(0);
});

test.each(["abort", "deadline", "close"] as const)("%s while transaction head read is held cannot start later intent reads or writes", async abandonment => {
  const f = await setup(), entered = gate(), held = gate(), client = f.records.db as unknown as FakeClient;
  const original = client.runTransaction.bind(client); let lateReads = 0, lateSets = 0, abandoned = false, calls = 0;
  const intercepted = vi.spyOn(client, "runTransaction").mockImplementation((callback, options) => {
    calls++;
    return original(async transaction => callback({ ...transaction,
      get: async (ref: any) => {
        if (abandoned) lateReads++;
        const row = await transaction.get(ref);
        if (ref.path === f.records.headPath) { entered.release(); await held.promise; }
        return row;
      },
      set: (ref: any, value: any) => { if (abandoned) lateSets++; transaction.set(ref, value); },
    }), options);
  });
  const recordsClose = vi.spyOn(f.records, "close"), controller = new AbortController(); vi.useFakeTimers();
  const caller = observe(f.control.request(f.state, f.actor, f.operation.id, abandonment === "abort" ? controller.signal : undefined));
  let closing: ReturnType<typeof observe<void>> | undefined, withinBudget: Outcome<void> | undefined, abandonedCaller: Outcome<unknown> | undefined;
  try {
    await entered.promise; abandoned = true;
    if (abandonment === "abort") controller.abort();
    if (abandonment === "deadline") await vi.advanceTimersByTimeAsync(10_000);
    closing = observe(f.control.close()); await vi.advanceTimersByTimeAsync(1_000);
    withinBudget = closing.current(); abandonedCaller = caller.current();
  } finally {
    held.release(); await vi.advanceTimersByTimeAsync(0);
    await caller.done; await (closing ?? observe(f.control.close())).done; intercepted.mockRestore();
  }
  expectUnconfirmed(withinBudget);
  expect.soft(abandonedCaller, "explicit close must also abandon an entered caller without a supplied signal").toMatchObject({ kind: "rejected" });
  expect.soft(lateReads, "no new SDK intent read may start after abandonment").toBe(0);
  expect.soft(lateSets, "no new SDK set may be staged after abandonment").toBe(0);
  expect.soft(calls, "disposal must never replay the business transaction").toBe(1);
  expect.soft(recordsClose).not.toHaveBeenCalled(); expect.soft(client.closed).toBe(false);
  expect.soft(intents(), "the held head-read boundary has not submitted a stop intent before abandonment").toHaveLength(0);
});

test("deadline after intent read but before set cannot stage a late stop write", async () => {
  const f = await setup(), entered = gate(), held = gate(), client = f.records.db as unknown as FakeClient, original = client.runTransaction.bind(client);
  let lateSets = 0, abandoned = false;
  const intercepted = vi.spyOn(client, "runTransaction").mockImplementation((callback, options) => original(async transaction => callback({ ...transaction,
    get: async (ref: any) => { const row = await transaction.get(ref); if (ref.path.includes("/lcwe_chat_stop_intents/")) { entered.release(); await held.promise; } return row; },
    set: (ref: any, value: any) => { if (abandoned) lateSets++; transaction.set(ref, value); },
  }), options));
  const recordsClose = vi.spyOn(f.records, "close"); vi.useFakeTimers();
  const caller = observe(f.control.request(f.state, f.actor, f.operation.id));
  let closing: ReturnType<typeof observe<void>> | undefined, withinBudget: Outcome<void> | undefined;
  try {
    await entered.promise; await vi.advanceTimersByTimeAsync(10_000); abandoned = true;
    expect(await caller.done).toMatchObject({ kind: "rejected", error: { name: "OperationDeadlineExceeded" } });
    closing = observe(f.control.close()); await vi.advanceTimersByTimeAsync(1_000); withinBudget = closing.current();
  } finally {
    held.release(); await vi.advanceTimersByTimeAsync(0); await caller.done; await (closing ?? observe(f.control.close())).done; intercepted.mockRestore();
  }
  expectUnconfirmed(withinBudget); expect.soft(lateSets, "deadline must fence the continuation immediately before set").toBe(0);
  expect.soft(intents()).toHaveLength(0); expect.soft(recordsClose).not.toHaveBeenCalled(); expect.soft(client.closed).toBe(false);
});

test.each(["ack", "lost-ack"] as const)("abort after possible commit with held %s never fabricates success, rolls back, or replays", async acknowledgement => {
  const f = await setup(), committed = gate(), held = gate(), client = f.records.db as unknown as FakeClient, original = client.runTransaction.bind(client);
  let calls = 0;
  const intercepted = vi.spyOn(client, "runTransaction").mockImplementation(async (callback, options) => {
    calls++; const result = await original(callback, options); committed.release(); await held.promise;
    if (acknowledgement === "lost-ack") throw new Error("synthetic acknowledgement lost after commit");
    return result;
  });
  const recordsClose = vi.spyOn(f.records, "close"), controller = new AbortController(); vi.useFakeTimers();
  const caller = observe(f.control.request(f.state, f.actor, f.operation.id, controller.signal));
  let closing: ReturnType<typeof observe<void>> | undefined, withinBudget: Outcome<void> | undefined;
  try {
    await committed.promise; expect(intents()).toHaveLength(1); controller.abort();
    expect(await caller.done).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
    closing = observe(f.control.close()); await vi.advanceTimersByTimeAsync(1_000); withinBudget = closing.current();
  } finally {
    held.release(); await vi.advanceTimersByTimeAsync(0); await caller.done; await (closing ?? observe(f.control.close())).done; intercepted.mockRestore();
  }
  expectUnconfirmed(withinBudget);
  expect.soft(caller.current()).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
  expect.soft(calls, "uncertain acknowledgement cannot replay the transaction").toBe(1);
  expect.soft(intents(), "a possibly committed original intent remains immutable despite caller abandonment").toHaveLength(1);
  expect.soft(recordsClose).not.toHaveBeenCalled(); expect.soft(client.closed).toBe(false);
});
import { performance } from "node:perf_hooks";

test("one abandoned parallel snapshot fences every caller and consumes a late raw rejection", async () => {
  const f = await setup(), entered = gate(), held = gate(), original = f.records.load.bind(f.records);
  let calls = 0;
  vi.spyOn(f.records, "load").mockImplementation(async () => {
    const image = await original(), index = ++calls; if (calls === 2) entered.release(); await held.promise;
    if (index === 2) throw new Error("private late SDK rejection"); return image;
  });
  const decode = vi.spyOn(f.records, "readRecords"), recordsClose = vi.spyOn(f.records, "close"), controller = new AbortController(); vi.useFakeTimers();
  const first = observe(f.control.snapshot(controller.signal)), second = observe(f.control.snapshot());
  let closing: ReturnType<typeof observe<void>> | undefined;
  try {
    await entered.promise; controller.abort();
    expect(await first.done).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
    expect(await second.done).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
    closing = observe(f.control.close()); await vi.advanceTimersByTimeAsync(1_000); expectUnconfirmed(closing.current());
  } finally {
    held.release(); await vi.advanceTimersByTimeAsync(0); await Promise.all([first.done, second.done]); await (closing ?? observe(f.control.close())).done;
  }
  expect(decode).not.toHaveBeenCalled(); expect(recordsClose).not.toHaveBeenCalled();
  await expect(f.control.close()).rejects.toThrow("cleanup unconfirmed");
});

test("owned termination starts while raw work is held and shares one cached cleanup deadline", async () => {
  const f = await setup(true), entered = gate(), raw = gate(), termination = gate(), originalLoad = f.records.load.bind(f.records);
  vi.spyOn(f.records, "load").mockImplementation(async () => { const image = await originalLoad(); entered.release(); await raw.promise; return image; });
  const client = f.records.db as unknown as FakeClient, originalTerminate = client.terminate.bind(client);
  const terminate = vi.spyOn(client, "terminate").mockImplementation(async () => { await termination.promise; await originalTerminate(); });
  const recordsClose = vi.spyOn(f.records, "close"); vi.useFakeTimers();
  const caller = observe(f.control.snapshot()); let closing: Promise<void> | undefined, observed: ReturnType<typeof observe<void>> | undefined;
  try {
    await entered.promise; closing = f.control.close(); observed = observe(closing);
    await vi.advanceTimersByTimeAsync(0); expect(terminate).toHaveBeenCalledOnce(); expect(recordsClose).toHaveBeenCalledOnce();
    expect(await caller.done).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
    expect(f.control.close()).toBe(closing); await vi.advanceTimersByTimeAsync(900); raw.release(); await vi.advanceTimersByTimeAsync(100);
    expectUnconfirmed(observed.current()); expect(client.closed).toBe(false);
  } finally {
    raw.release(); termination.release(); await vi.advanceTimersByTimeAsync(0); await caller.done; await (observed ?? observe(f.control.close())).done;
  }
  expect(client.closed).toBe(true); expect(terminate).toHaveBeenCalledOnce(); expect(recordsClose).toHaveBeenCalledOnce();
  expect(f.control.close()).toBe(closing); await expect(f.control.close()).rejects.toThrow("cleanup unconfirmed");
});

test("owned cleanup failure is sanitized and cached without repeated termination", async () => {
  const f = await setup(true), client = f.records.db as unknown as FakeClient;
  const terminate = vi.spyOn(client, "terminate").mockRejectedValue(new Error("private termination diagnostic"));
  const closing = f.control.close(); expect(f.control.close()).toBe(closing);
  await expect(closing).rejects.toThrow(/^Chat cancellation control cleanup unconfirmed$/);
  await expect(f.control.close()).rejects.toThrow(/^Chat cancellation control cleanup unconfirmed$/); expect(terminate).toHaveBeenCalledOnce();
});

test.each(["abort", "elapsed-before-timer"] as const)("%s immediately before set fences write without requiring a timer callback", async kind => {
  const f = await setup(), entered = gate(), held = gate(), client = f.records.db as unknown as FakeClient, original = client.runTransaction.bind(client);
  let now = 0, sets = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(client, "runTransaction").mockImplementation((callback, options) => original(async transaction => callback({ ...transaction,
    get: async (ref: any) => { const row = await transaction.get(ref); if (ref.path.includes("/lcwe_chat_stop_intents/")) { entered.release(); await held.promise; } return row; },
    set: (ref: any, value: any) => { sets++; transaction.set(ref, value); },
  }), options));
  const controller = new AbortController(); vi.useFakeTimers();
  const caller = observe(f.control.request(f.state, f.actor, f.operation.id, controller.signal));
  try {
    await entered.promise;
    if (kind === "abort") controller.abort(); else now = 10_001;
  } finally { held.release(); await vi.advanceTimersByTimeAsync(0); await caller.done; await f.control.close(); }
  expect(caller.current()).toMatchObject({ kind: "rejected" }); expect(sets).toBe(0); expect(intents()).toHaveLength(0);
});

test("an SDK retry callback entered after abandonment performs no further control reads", async () => {
  const f = await setup(), retryEntered = gate(), held = gate(), client = f.records.db as unknown as FakeClient, original = client.runTransaction.bind(client);
  let callbacks = 0, readsAtAbort = 0;
  db.fault = "retry";
  vi.spyOn(client, "runTransaction").mockImplementation((callback, options) => original(async transaction => {
    if (++callbacks === 2) { retryEntered.release(); await held.promise; }
    return callback(transaction);
  }, options));
  const controller = new AbortController(); vi.useFakeTimers();
  const caller = observe(f.control.request(f.state, f.actor, f.operation.id, controller.signal));
  try { await retryEntered.promise; readsAtAbort = db.reads.length; controller.abort(); }
  finally { held.release(); await vi.advanceTimersByTimeAsync(0); await caller.done; await f.control.close(); }
  expect(caller.current()).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
  expect(callbacks).toBe(2); expect(db.reads).toHaveLength(readsAtAbort); expect(intents()).toHaveLength(0);
});
