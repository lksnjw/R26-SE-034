import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordStore, FirestoreSnapshotChanged } from "../src/storage/firestore-record-store.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { FirestoreChatCancellation } from "../src/storage/firestore-chat-cancellation.js";
import { Repository, effectiveUserFromState } from "../src/repository/store.js";
import { chatCancellationIntent } from "../src/agent/chat-cancellation.js";
import { loadConfig } from "../src/config/config.js";

const runtime = vi.hoisted(() => ({ db: null as any }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { constructor(settings: any) { return new FakeClient(runtime.db, settings); } },
  default: { v1: { FirestoreClient: class { constructor(settings: any) { return new FakeStopClient(runtime.db, settings); } } } } }));
const namespace = { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "stop_fixture" }, key = "x".repeat(32);
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", STORAGE_ENCRYPTION_KEY: key, FIRESTORE_PROJECT_ID: namespace.projectId,
  FIRESTORE_DATABASE_ID: namespace.databaseId, FIRESTORE_WORKSPACE_ID: namespace.workspaceId, MCP_MODE: "mock" });
let db: Database; const closers: Array<() => Promise<void>> = [];
beforeEach(() => { db = new Database(); runtime.db = db; FakeStopClient.hold = false; FakeStopClient.instances = []; });
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function setup() {
  const fixture = await boundedChatFixture(); let seed;
  try { await fixture.send(); seed = await fixture.repository.snapshot(); } finally { await fixture.close(); }
  const persistence = await FirestoreRecordPersistence.open(key, namespace), repository = await Repository.open(persistence);
  closers.push(() => repository.close()); await repository.mutate(state => { Object.assign(state, seed); });
  const make = () => {
    const control = new FirestoreChatCancellation(FirestoreRecordStore.create(key, namespace), config, true);
    closers.push(() => control.close()); return control;
  };
  const control = make(), state = await control.snapshot(), actor = effectiveUserFromState(state, "owner")!;
  const operation = Object.values(state.chatOperations)[0]!;
  return { persistence, repository, control, state, actor, operation, make };
}
const intents = () => [...db.documents.entries()].filter(([path]) => path.includes("/lcwe_chat_stop_intents/"));

test("encrypted stop intent is writable during a held namespace writer without changing its head/generation/application records", async () => {
  const f = await setup(), before = new Map(db.documents), snapshot = await f.repository.snapshot();
  const result = await f.control.request(f.state, f.actor, f.operation.id);
  expect(result).toMatchObject({ status: "QUEUED", cancellationRequested: true });
  expect(await f.repository.snapshot()).toEqual(snapshot); f.repository.assertAuthority();
  for (const [path, document] of before) expect(db.documents.get(path)).toEqual(document);
  expect(intents()).toHaveLength(1);
  const [path, document] = intents()[0]!; expect(path).not.toContain(f.operation.id); expect(path).not.toContain("owner");
  expect(document.payload.includes(Buffer.from(f.operation.id))).toBe(false);
  expect(document.payload.includes(Buffer.from("chat-cancellation-intent/v1"))).toBe(false);
  expect(await f.control.requested(f.operation)).toBe(true);
  const ownerReader = new FirestoreChatCancellation(f.persistence.records, config);
  expect(await ownerReader.requested(f.operation)).toBe(true); await ownerReader.close(); f.repository.assertAuthority();
});

test("concurrent duplicate stop requests recover exactly one immutable intent and leave original identity unchanged", async () => {
  const f = await setup();
  await Promise.all([f.control.request(f.state, f.actor, f.operation.id), f.control.request(f.state, f.actor, f.operation.id)]);
  const before = intents()[0]![1]; const reopened = f.make(), current = await reopened.snapshot();
  await reopened.request(current, effectiveUserFromState(current, "owner")!, f.operation.id);
  expect(intents()).toHaveLength(1); expect(intents()[0]![1]).toEqual(before);
  expect((await f.repository.snapshot()).chatOperations[f.operation.id]!.cancellationRequested).not.toBe(true);
});

test("task-owned observer closes its GAPIC transport without closing borrowed record storage", async () => {
  const f = await setup(), reader = new FirestoreChatCancellation(f.persistence.records, config);
  expect(await reader.requested(f.operation)).toBe(false); await reader.close();
  expect(FakeStopClient.instances.at(-1)?.closed).toBe(true);
  expect((f.persistence.records.db as unknown as FakeClient).closed).toBe(false);
  expect((await f.repository.snapshot()).chatOperations[f.operation.id]?.id).toBe(f.operation.id);
});

test("a coherent image from another reader cannot be supplied as cancellation authority", async () => {
  const f = await setup(); await expect(f.make().request(f.state, f.actor, f.operation.id)).rejects.toThrow("own coherent");
  expect(intents()).toHaveLength(0);
});

test("concurrent account/head changes refuse stale authorization before any stop intent is committed", async () => {
  const f = await setup(); await f.repository.mutate(state => { state.users.owner!.status = "Inactive"; });
  await expect(f.control.request(f.state, f.actor, f.operation.id)).rejects.toBeInstanceOf(FirestoreSnapshotChanged);
  const fresh = await f.control.snapshot(); await expect(f.control.request(fresh, effectiveUserFromState(fresh, "owner")!, f.operation.id)).rejects.toThrow("authority changed");
  expect(intents()).toHaveLength(0);
});

test("unrelated head changes still require fresh coherent authorization instead of reusing an old image", async () => {
  const f = await setup(); await f.repository.mutate(state => { state.settings.changed = { value: true }; });
  await expect(f.control.request(f.state, f.actor, f.operation.id)).rejects.toBeInstanceOf(FirestoreSnapshotChanged);
  const fresh = await f.control.snapshot(); expect((await f.control.request(fresh, effectiveUserFromState(fresh, "owner")!, f.operation.id)).cancellationRequested).toBe(true);
});

test("other accounts cannot cancel an owner's operation even with administration permissions", async () => {
  const f = await setup(); await f.repository.mutate(state => { state.users.other = { ...state.users.owner!, id: "other", email: "other@example.test" }; });
  const current = await f.control.snapshot(); await expect(f.control.request(current, effectiveUserFromState(current, "other")!, f.operation.id)).rejects.toThrow("not found");
  expect(intents()).toHaveLength(0);
});

test.each(["role", "chat", "operation"])("changed or deleted %s authority cannot create an intent", async kind => {
  const f = await setup(); await f.repository.mutate(state => {
    if (kind === "role") state.roles.role_admin!.permissions.push("changed:permission");
    if (kind === "chat") delete state.chats[f.operation.sessionId];
    if (kind === "operation") delete state.chatOperations[f.operation.id];
  });
  const current = await f.control.snapshot(); await expect(f.control.request(current, effectiveUserFromState(current, "owner")!, f.operation.id)).rejects.toThrow();
  expect(intents()).toHaveLength(0);
});

test.each(["before-commit", "after-commit"] as const)("lost %s acknowledgement never reports successful cancellation; fresh original-intent recovery is idempotent", async fault => {
  const f = await setup(); db.fault = fault;
  await expect(f.control.request(f.state, f.actor, f.operation.id)).rejects.toThrow();
  expect(intents()).toHaveLength(fault === "after-commit" ? 1 : 0);
  const reopened = f.make(), current = await reopened.snapshot();
  expect((await reopened.request(current, effectiveUserFromState(current, "owner")!, f.operation.id)).cancellationRequested).toBe(true);
  expect(intents()).toHaveLength(1); expect(await reopened.requested(f.operation)).toBe(true);
});

test.each(["ciphertext", "namespace", "binding"])("tampered %s intent is refused rather than treated as a valid request", async kind => {
  const f = await setup(); await f.control.request(f.state, f.actor, f.operation.id); const [path, document] = intents()[0]!;
  const codec = new FirestoreRecordCodec(key, kind === "namespace" ? { ...namespace, workspaceId: "foreign" } : namespace);
  if (kind === "ciphertext") { document.payload = Buffer.from(document.payload); document.payload[document.payload.length - 1] ^= 1; }
  else db.documents.set(path, codec.encodeHead({ ...chatCancellationIntent(f.operation), ...(kind === "binding" ? { actorId: "other" } : {}) }));
  await expect(f.control.requested(f.operation)).rejects.toThrow(); await expect(f.control.request(f.state, f.actor, f.operation.id)).rejects.toThrow();
});

test("terminal operations return their saved state without a new stop intent", async () => {
  const f = await setup(); await f.repository.mutate(state => { state.chatOperations[f.operation.id]!.status = "FAILED"; });
  const current = await f.control.snapshot(); expect((await f.control.request(current, effectiveUserFromState(current, "owner")!, f.operation.id)).status).toBe("FAILED");
  expect(intents()).toHaveLength(0);
});

test("foreign namespaces and closed clients cannot be used as stop authority", async () => {
  const f = await setup(); expect(() => new FirestoreChatCancellation(f.persistence.records, { ...config, firestoreProjectId: "demo-other-project" })).toThrow("namespace");
  await f.control.close(); expect(() => f.control.snapshot()).toThrow("closed"); expect(() => f.control.requested(f.operation)).toThrow("closed");
  expect(intents()).toHaveLength(0);
});

test("an already abandoned request never starts a cancellation storage operation", async () => {
  const f = await setup(), controller = new AbortController(); controller.abort(); const before = db.invocations;
  await expect(f.control.request(f.state, f.actor, f.operation.id, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(db.invocations).toBe(before); expect(intents()).toHaveLength(0);
});

test("abandoned stop observation confirms SDK cancellation before bounded control teardown", async () => {
  const f = await setup(); let finish!: (row: object) => void, closed = false;
  const original = FakeClient.prototype.doc, get = vi.fn(() => new Promise<object>(resolve => { finish = resolve; }));
  const interception = vi.spyOn(FakeClient.prototype, "doc").mockImplementation(function (this: FakeClient, path: string) {
    const ref = original.call(this, path); return path.includes("/lcwe_chat_stop_intents/") ? { ...ref, get } as any : ref;
  });
  try {
    FakeStopClient.hold = true;
    const controller = new AbortController(), pending = f.control.requested(f.operation, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(get.mock.calls.length + FakeStopClient.instances.reduce((n, client) => n + client.calls, 0)).toBe(1));
    controller.abort(); await rejected;
    const closing = f.control.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 40)); const observed = closed;
    // Release the old raw SDK promise even on RED, so this causal test cannot leak.
    finish?.({ exists: false }); await closing;
    expect(observed).toBe(true);
    expect(FakeStopClient.instances[0]?.cancels).toBe(1);
    expect(FakeStopClient.instances[0]?.closed).toBe(true);
  } finally { FakeStopClient.hold = false; interception.mockRestore(); }
});
