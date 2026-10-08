import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { FirestoreChatStopReader } from "../src/storage/firestore-chat-stop-reader.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { chatCancellationIntent } from "../src/agent/chat-cancellation.js";
import type { ChatOperation } from "../src/repository/store.js";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";

const runtime = vi.hoisted(() => ({ client: null as any, options: null as any }));
vi.mock("@google-cloud/firestore", () => ({ default: { v1: { FirestoreClient: class {
  constructor(options: unknown) { runtime.options = options; return runtime.client; }
} } } }));
const namespace = { projectId: "demo-stop-reader", databaseId: "(default)", workspaceId: "observer" }, key = "x".repeat(32);
const codec = new FirestoreRecordCodec(key, namespace);
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", STORAGE_ENCRYPTION_KEY: key,
  FIRESTORE_PROJECT_ID: namespace.projectId, FIRESTORE_DATABASE_ID: namespace.databaseId, FIRESTORE_WORKSPACE_ID: namespace.workspaceId, MCP_MODE: "mock" });
let operation: ChatOperation, stream: EventEmitter & { cancel: ReturnType<typeof vi.fn> }, client: any;
const readers: FirestoreChatStopReader[] = [];
const deferred = () => { let resolve!: (value?: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeAll(async () => { const f = await boundedChatFixture(); try { await f.send(); operation = Object.values((await f.repository.snapshot()).chatOperations)[0]!; } finally { await f.close(); } });
beforeEach(() => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
  stream = Object.assign(new EventEmitter(), { cancel: vi.fn(() => { queueMicrotask(() => { stream.emit("status", { code: 1 }); stream.emit("close"); }); }) });
  client = { locationsClient: { initialize: vi.fn(async () => ({})), close: vi.fn(async () => {}) }, initialize: vi.fn(async () => ({})),
    close: vi.fn(async () => {}), batchGetDocuments: vi.fn(() => stream) };
  runtime.client = client;
});
afterEach(async () => {
  // A pending bounded failure is always consumed, including under fake time.
  const pending = readers.splice(0).map(reader => reader.close().catch(() => {}));
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1_001);
  await Promise.all(pending); vi.useRealTimers(); vi.unstubAllEnvs();
});
function reader(settings = config) { const result = new FirestoreChatStopReader(settings, codec); readers.push(result); return result; }
async function entered() { await vi.waitFor(() => expect(client.batchGetDocuments).toHaveBeenCalledOnce()); }
const name = () => client.batchGetDocuments.mock.calls[0][0].documents[0];
function found(override?: unknown) {
  const packet = codec.encodeHead(override ?? { profile: "chat-cancellation-record/v1", intent: chatCancellationIntent(operation), requestedAt: new Date().toISOString() });
  return { found: { name: name(), fields: { profile: { stringValue: packet.profile }, payload: { bytesValue: packet.payload } } } };
}

test.each(["status-first", "end-first"])("exact encrypted found waits for OK status and readable end: %s", async order => {
  const r = reader(), pending = r.requested(operation); let settled = false; void pending.then(() => { settled = true; }); await entered();
  stream.emit("data", found()); stream.emit(order === "status-first" ? "status" : "end", { code: 0 });
  await Promise.resolve(); expect(settled).toBe(false);
  stream.emit(order === "status-first" ? "end" : "status", { code: 0 }); expect(await pending).toBe(true);
  await r.close(); expect(stream.cancel).not.toHaveBeenCalled();
  expect(client.locationsClient.initialize.mock.invocationCallOrder[0]).toBeLessThan(client.initialize.mock.invocationCallOrder[0]);
  expect(client.locationsClient.close.mock.invocationCallOrder[0]).toBeLessThan(client.close.mock.invocationCallOrder[0]);
});
test("missing is provisional, client is reused, and all retry layers/deadline are explicit", async () => {
  const r = reader();
  for (let index = 0; index < 2; index++) {
    const pending = r.requested(operation); await vi.waitFor(() => expect(client.batchGetDocuments).toHaveBeenCalledTimes(index + 1));
    stream.emit("data", { missing: name() }); stream.emit("end"); stream.emit("status", { code: 0 }); expect(await pending).toBe(false);
  }
  expect(client.initialize).toHaveBeenCalledOnce(); expect(client.locationsClient.initialize).toHaveBeenCalledOnce();
  expect(runtime.options).toMatchObject({ fallback: false, gaxServerStreamingRetries: false, "grpc.enable_retries": 0 });
  const options = client.batchGetDocuments.mock.calls[0][1];
  expect(options.timeout).toBeGreaterThan(0); expect(options.timeout).toBeLessThanOrEqual(10_000);
  expect(options.retry).toBeNull(); expect(options.retryRequestOptions).toMatchObject({ retries: 0, noResponseRetries: 0 });
  expect(options.retryRequestOptions.shouldRetryFn()).toBe(false);
  expect(options.otherArgs.headers.Authorization).toBeUndefined(); await r.close();
});
test.each(["empty", "foreign-missing", "foreign-found", "ambiguous", "duplicate", "fields", "ciphertext", "binding", "namespace", "wrong-value-type", "oversize"])("%s cannot become no-stop or authority", async kind => {
  const r = reader(), pending = r.requested(operation), rejected = expect(pending).rejects.toThrow(); await entered();
  let row: any = found();
  if (kind === "empty") row = {};
  if (kind === "foreign-missing") row = { missing: name() + "-foreign" };
  if (kind === "foreign-found") row.found.name += "-foreign";
  if (kind === "ambiguous") row.missing = name();
  if (kind === "fields") row.found.fields.extra = { stringValue: "extra" };
  if (kind === "ciphertext") row.found.fields.payload.bytesValue[0] ^= 1;
  if (kind === "binding") row = found({ profile: "chat-cancellation-record/v1", intent: { ...chatCancellationIntent(operation), actorId: "foreign" }, requestedAt: new Date().toISOString() });
  if (kind === "namespace") row.found.fields.payload.bytesValue = new FirestoreRecordCodec(key, { ...namespace, workspaceId: "foreign" }).encodeHead({}).payload;
  if (kind === "wrong-value-type") row.found.fields.payload.valueType = "stringValue";
  if (kind === "oversize") row.found.fields.payload.bytesValue = new Uint8Array(786_433);
  stream.emit("data", row); if (kind === "duplicate") stream.emit("data", row);
  stream.emit("status", { code: 0 }); stream.emit("end"); await rejected; await r.close(); expect(stream.cancel).toHaveBeenCalledOnce();
  await expect(r.requested(operation)).rejects.toThrow(); expect(client.batchGetDocuments).toHaveBeenCalledOnce();
});
test.each(["before-headers", "after-found"])("abort %s rejects caller and waits for actual terminal disposal", async stage => {
  stream.cancel.mockImplementation(() => {}); const r = reader(), controller = new AbortController();
  const pending = r.requested(operation, controller.signal), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" }); await entered();
  if (stage === "after-found") stream.emit("data", found()); controller.abort(); await rejected;
  let closed = false; const close = r.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  stream.emit("error", new Error("cancel error without terminal status")); stream.emit("close"); await Promise.resolve(); expect(closed).toBe(false);
  stream.emit("status", { code: 1 }); await close; expect(stream.cancel).toHaveBeenCalledOnce();
});
test.each(["no-status", "invalid-status", "error-only", "prebinding"])("%s is bounded unconfirmed cleanup, never cancel-return proof", async kind => {
  vi.useFakeTimers(); stream.cancel.mockImplementation(() => {}); const r = reader(), controller = new AbortController();
  const pending = r.requested(operation, controller.signal), rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0); expect(client.batchGetDocuments).toHaveBeenCalledOnce();
  if (kind === "invalid-status") stream.emit("status", { code: "0" });
  else if (kind === "error-only") stream.emit("error", new Error("SDK read rejected")); else controller.abort();
  await rejected; if (kind !== "prebinding") stream.emit("close");
  const close = r.close(), failed = expect(close).rejects.toThrow("cleanup unconfirmed");
  await vi.advanceTimersByTimeAsync(1_000); await failed;
  expect(r.close()).toBe(close); await expect(r.close()).rejects.toThrow("cleanup unconfirmed");
  expect(client.close).not.toHaveBeenCalled(); expect(stream.cancel).toHaveBeenCalledOnce();
  // Late terminal proof permits cleanup, but never repairs the cached outcome.
  stream.emit("status", { code: 1 }); stream.emit("close"); await vi.advanceTimersByTimeAsync(0);
  expect(client.close).toHaveBeenCalledOnce(); await expect(r.close()).rejects.toThrow();
});
test("one read budget covers held initialization; no late main/read entry", async () => {
  vi.useFakeTimers(); const held = deferred(); client.locationsClient.initialize.mockReturnValue(held.promise);
  const r = reader(), pending = r.requested(operation), failed = expect(pending).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(10_000); await failed;
  const closing = r.close(), unconfirmed = expect(closing).rejects.toThrow("cleanup unconfirmed"); await vi.advanceTimersByTimeAsync(1_000); await unconfirmed;
  held.resolve({}); await vi.advanceTimersByTimeAsync(0);
  expect(client.initialize).not.toHaveBeenCalled(); expect(client.batchGetDocuments).not.toHaveBeenCalled();
  expect(client.locationsClient.close).toHaveBeenCalledOnce(); expect(client.close).not.toHaveBeenCalled();
});
test.each(["aux-reject", "aux-held", "main-reject", "main-held"])("%s init is consumed/fenced and never starts a late read", async kind => {
  vi.useFakeTimers(); const held = deferred(), auxiliary = kind.startsWith("aux");
  (auxiliary ? client.locationsClient.initialize : client.initialize).mockReturnValue(held.promise);
  const r = reader(), controller = new AbortController(), pending = r.requested(operation, controller.signal), failed = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  if (kind.endsWith("reject")) held.reject(new Error("initialization rejected")); else controller.abort();
  await failed; const close = r.close(), outcome = kind === "main-reject" ? expect(close).resolves.toBeUndefined() : expect(close).rejects.toThrow("cleanup unconfirmed");
  await vi.advanceTimersByTimeAsync(1_000); await outcome;
  if (kind.endsWith("held")) { held.resolve({}); await vi.advanceTimersByTimeAsync(0); }
  expect(client.batchGetDocuments).not.toHaveBeenCalled();
  if (auxiliary) { expect(client.initialize).not.toHaveBeenCalled(); expect(client.close).not.toHaveBeenCalled(); }
  if (kind === "aux-reject") expect(client.locationsClient.close).not.toHaveBeenCalled();
});
test.each(["aux-reject", "aux-held", "main-reject", "main-held"])("%s close is bounded, cached and avoids unsafe detached auxiliary closure", async kind => {
  vi.useFakeTimers(); const r = reader(), pending = r.requested(operation); await vi.advanceTimersByTimeAsync(0);
  stream.emit("data", { missing: name() }); stream.emit("status", { code: 0 }); stream.emit("end"); expect(await pending).toBe(false);
  const held = deferred(), auxiliary = kind.startsWith("aux"); (auxiliary ? client.locationsClient.close : client.close).mockReturnValue(held.promise);
  const close = r.close(), failed = expect(close).rejects.toThrow("cleanup unconfirmed");
  if (kind.endsWith("reject")) held.reject(new Error("close rejected"));
  await vi.advanceTimersByTimeAsync(1_000); await failed; expect(r.close()).toBe(close);
  if (kind.endsWith("held")) { held.resolve(); await vi.advanceTimersByTimeAsync(0); }
  if (kind === "aux-reject") expect(client.close).not.toHaveBeenCalled();
  await expect(r.close()).rejects.toThrow();
});
test("cleanup has one common deadline, not a fresh second per close stage", async () => {
  vi.useFakeTimers(); const r = reader(), pending = r.requested(operation); await vi.advanceTimersByTimeAsync(0);
  stream.emit("data", { missing: name() }); stream.emit("end"); stream.emit("status", { code: 0 }); await pending;
  const aux = deferred(), main = deferred(); client.locationsClient.close.mockReturnValue(aux.promise); client.close.mockReturnValue(main.promise);
  const closing = r.close(), failed = expect(closing).rejects.toThrow("cleanup unconfirmed"); await vi.advanceTimersByTimeAsync(900); aux.resolve();
  await vi.advanceTimersByTimeAsync(100); await failed; expect(client.close).toHaveBeenCalledOnce(); main.resolve(); await vi.advanceTimersByTimeAsync(0);
});
test("already cancelled and close-during-init cannot create late SDK work", async () => {
  const r = reader(), controller = new AbortController(); controller.abort(); await expect(r.requested(operation, controller.signal)).rejects.toThrow();
  expect(client.locationsClient.initialize).not.toHaveBeenCalled(); await r.close(); await expect(r.requested(operation)).rejects.toThrow();
});
test("close during held initialization immediately abandons caller and never starts a late main/read", async () => {
  vi.useFakeTimers(); const held = deferred(); client.locationsClient.initialize.mockReturnValue(held.promise);
  const r = reader(), pending = r.requested(operation), failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0); const closing = r.close(), uncertain = expect(closing).rejects.toThrow("cleanup unconfirmed");
  await failed; await vi.advanceTimersByTimeAsync(1_000); await uncertain;
  held.resolve({}); await vi.advanceTimersByTimeAsync(0); expect(client.initialize).not.toHaveBeenCalled(); expect(client.batchGetDocuments).not.toHaveBeenCalled();
});
test("SDK stream creation throw is consumed without a second read", async () => {
  client.batchGetDocuments.mockImplementation(() => { throw new Error("synthetic stream acquisition failure"); });
  const r = reader(); await expect(r.requested(operation)).rejects.toThrow("acquisition failure"); await r.close();
  await expect(r.requested(operation)).rejects.toThrow(); expect(client.batchGetDocuments).toHaveBeenCalledOnce();
});
test("original intent is captured before initialization and cannot be rebound by caller mutation", async () => {
  const held = deferred(); client.locationsClient.initialize.mockReturnValue(held.promise);
  const original = structuredClone(operation), changed = structuredClone(operation), r = reader();
  const pending = r.requested(changed), outcome = pending.then(value => ({ value }), error => ({ error }));
  try {
    changed.actorId = "late-foreign-actor"; held.resolve({}); await entered();
    expect(name().endsWith(codec.identity("chat-stop-intent/v1", chatCancellationIntent(original)))).toBe(true);
    stream.emit("data", found()); stream.emit("status", { code: 0 }); stream.emit("end"); expect(await outcome).toEqual({ value: true });
  } finally { held.resolve({}); await r.close(); await outcome; }
});
test("one failed concurrent observation fences every other caller; late missing cannot escape", async () => {
  const firstStream = stream, secondStream = Object.assign(new EventEmitter(), { cancel: vi.fn(() => {
    queueMicrotask(() => { secondStream.emit("status", { code: 1 }); secondStream.emit("close"); });
  }) });
  client.batchGetDocuments.mockReturnValueOnce(firstStream).mockReturnValueOnce(secondStream);
  const r = reader(), controller = new AbortController(), first = r.requested(operation, controller.signal), second = r.requested(operation);
  const rejected = [expect(first).rejects.toThrow(), expect(second).rejects.toThrow()];
  await vi.waitFor(() => expect(client.batchGetDocuments).toHaveBeenCalledTimes(2)); controller.abort();
  secondStream.emit("data", { missing: name() }); await Promise.all(rejected); await r.close();
  expect(firstStream.cancel).toHaveBeenCalledOnce(); expect(secondStream.cancel).toHaveBeenCalledOnce();
});
test("read deadline cancels a held stream once and cannot return a late valid response", async () => {
  vi.useFakeTimers(); const r = reader(), pending = r.requested(operation), failed = expect(pending).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(10_000); await failed;
  stream.emit("data", found()); stream.emit("end"); await r.close(); expect(stream.cancel).toHaveBeenCalledOnce();
});
test.each(["empty", "close-without-end", "nonzero", "duplicate-status"])("%s terminal stream cannot report missing", async kind => {
  const r = reader(), pending = r.requested(operation), failed = expect(pending).rejects.toThrow(); await entered();
  if (kind !== "empty") stream.emit("data", { missing: name() });
  stream.emit("status", { code: kind === "nonzero" ? 14 : 0 });
  if (kind === "duplicate-status") stream.emit("status", { code: 0 });
  stream.emit(kind === "close-without-end" ? "close" : "end"); await failed; await r.close(); expect(stream.cancel).toHaveBeenCalledOnce();
});
test.each(["http://localhost:8080", "localhost", "localhost:0", "localhost:65536", "user@localhost:80", "localhost:80/path", "localhost:80?x", " localhost:80", "a..b:80", "[bad:ip]:80", ""])("invalid emulator endpoint is rejected without cloud fallback: %s", endpoint => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", endpoint); expect(() => reader()).toThrow("endpoint");
});
test.each(["localhost:8080", "127.0.0.1:8080", "[::1]:8080", "firestore.internal:8080"])("explicit emulator %s omits credentials and bypasses ADC securely scoped to emulator", async endpoint => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", endpoint); const r = reader({ ...config, firestoreKeyFile: "not-used.json", firestoreKeyJson: { private_key: "not-used" } });
  expect(runtime.options).toMatchObject({ universeDomain: "googleapis.com", port: 8080 });
  expect(runtime.options.sslCreds).toBeDefined(); expect(runtime.options.credentials).toBeUndefined(); expect(runtime.options.keyFilename).toBeUndefined();
  const pending = r.requested(operation); await entered(); expect(client.batchGetDocuments.mock.calls[0][1].otherArgs.headers.Authorization).toBe("Bearer owner");
  stream.emit("data", { missing: name() }); stream.emit("end"); stream.emit("status", { code: 0 }); expect(await pending).toBe(false); await r.close();
});
test.each(["json", "file", "adc", "both"])("non-emulator %s preserves public SDK auth/default TLS configuration", async mode => {
  const credentials = { client_email: "test@example.invalid", private_key: "test-only" };
  const r = reader({ ...config, ...(mode === "json" || mode === "both" ? { firestoreKeyJson: credentials } : {}),
    ...(mode === "file" || mode === "both" ? { firestoreKeyFile: "test-only.json" } : {}) });
  expect(runtime.options.credentials).toEqual(mode === "json" || mode === "both" ? credentials : undefined);
  expect(runtime.options.keyFilename).toBe(mode === "file" || mode === "both" ? "test-only.json" : undefined);
  for (const option of ["sslCreds", "servicePath", "port", "universeDomain"]) expect(runtime.options[option]).toBeUndefined(); await r.close();
});
