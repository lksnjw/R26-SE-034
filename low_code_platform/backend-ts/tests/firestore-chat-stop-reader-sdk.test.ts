import { Server, ServerCredentials, status as grpcStatus, type ServerWritableStream } from "@grpc/grpc-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import firestore from "@google-cloud/firestore";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { FirestoreChatStopReader } from "../src/storage/firestore-chat-stop-reader.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { chatCancellationIntent } from "../src/agent/chat-cancellation.js";
import { loadConfig } from "../src/config/config.js";
import type { ChatOperation } from "../src/repository/store.js";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";

// This suite deliberately uses the installed real GAPIC, gax and grpc transport.
// Only an ephemeral loopback server is owned here; no emulator/cloud is used.
const { v1 } = firestore;
type Request = NonNullable<Parameters<InstanceType<typeof v1.FirestoreClient>["batchGetDocuments"]>[0]>;
type Response = { found?: { name: string; fields: Record<string, { stringValue?: string; bytesValue?: Uint8Array }> }; missing?: string };
type WireCodec<T> = { encode(value: T): { finish(): Uint8Array }; decode(bytes: Buffer): T };
// Public root runtime export, missing from 9.3.1's root .d.ts. No private SDK
// path or undeclared transitive dependency is imported to bridge that mismatch.
const api = (firestore as typeof firestore & { protos: { google: { firestore: { v1: {
  BatchGetDocumentsRequest: WireCodec<Request>; BatchGetDocumentsResponse: WireCodec<Response>;
} } } } }).protos.google.firestore.v1;
const namespace = { projectId: "demo-stop-sdk", databaseId: "(default)", workspaceId: "observer" }, key = "x".repeat(32);
const codec = new FirestoreRecordCodec(key, namespace);
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", STORAGE_ENCRYPTION_KEY: key,
  FIRESTORE_PROJECT_ID: namespace.projectId, FIRESTORE_DATABASE_ID: namespace.databaseId, FIRESTORE_WORKSPACE_ID: namespace.workspaceId, MCP_MODE: "mock" });
let operation: ChatOperation;
const closers: Array<() => Promise<void>> = [];
beforeAll(async () => { const f = await boundedChatFixture(); try { await f.send(); operation = Object.values((await f.repository.snapshot()).chatOperations)[0]!; } finally { await f.close(); } });
afterEach(async () => { try { for (const close of closers.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); } });
type Call = ServerWritableStream<Request, Response>;
test("native Node ESM imports the reader without any client construction or network", async () => {
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e",
    "await import('./src/storage/firestore-chat-stop-reader.ts'); process.stdout.write('stop-reader-import-ok')"],
  { cwd: process.cwd(), timeout: 5_000, maxBuffer: 16_384 });
  expect(result.stdout).toBe("stop-reader-import-ok"); expect(result.stderr).toBe("");
});
async function fixture(handler: (call: Call) => void, afterCreation?: () => void) {
  const server = new Server(); let calls = 0;
  server.addService({ batchGetDocuments: { path: "/google.firestore.v1.Firestore/BatchGetDocuments", requestStream: false, responseStream: true,
    requestSerialize: value => Buffer.from(api.BatchGetDocumentsRequest.encode(value).finish()), requestDeserialize: bytes => api.BatchGetDocumentsRequest.decode(bytes),
    responseSerialize: value => Buffer.from(api.BatchGetDocumentsResponse.encode(value).finish()), responseDeserialize: bytes => api.BatchGetDocumentsResponse.decode(bytes),
  } }, { batchGetDocuments: (call: Call) => { calls++; handler(call); } });
  closers.push(() => new Promise<void>(resolve => { const timer = setTimeout(() => { server.forceShutdown(); resolve(); }, 500);
    server.tryShutdown(() => { clearTimeout(timer); resolve(); }); }));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Loopback fixture bind timed out")), 1_000);
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) => { clearTimeout(timer); error ? reject(error) : resolve(bound); });
  });
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", `127.0.0.1:${port}`);
  // A successful call despite invalid ADC/key inputs demonstrates the explicit
  // emulator path does not attempt a real credential file or metadata lookup.
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "Z:/nonexistent-stop-observer-test-credentials.json");
  const events: string[] = [], statuses: number[] = [], options: any[] = [];
  const original = v1.FirestoreClient.prototype.batchGetDocuments;
  vi.spyOn(v1.FirestoreClient.prototype, "batchGetDocuments").mockImplementation(function (this: InstanceType<typeof v1.FirestoreClient>, request, callOptions) {
    options.push(callOptions); const stream = original.call(this, request, callOptions);
    stream.on("data", () => events.push("data")); stream.on("end", () => events.push("end")); stream.on("close", () => events.push("close"));
    stream.on("status", (transport: { code: number }) => { statuses.push(transport.code); events.push("status"); });
    stream.on("error", () => events.push("error")); afterCreation?.(); return stream;
  });
  const reader = new FirestoreChatStopReader({ ...config, firestoreKeyFile: "Z:/not-used.json", firestoreKeyJson: { private_key: "not-used" } }, codec);
  closers.push(() => reader.close().catch(() => {}));
  return { reader, events, statuses, options, calls: () => calls };
}
function found(call: Call) {
  const packet = codec.encodeHead({ profile: "chat-cancellation-record/v1", intent: chatCancellationIntent(operation), requestedAt: new Date().toISOString() });
  return { found: { name: call.request.documents![0]!, fields: { profile: { stringValue: packet.profile }, payload: { bytesValue: packet.payload } } } };
}

test.each(["found", "missing"])("real SDK %s exposes successful terminal status and readable completion without ADC", async kind => {
  const f = await fixture(call => {
    expect(call.metadata.get("authorization")).toEqual(["Bearer owner"]);
    expect(call.request.documents).toHaveLength(1); expect(call.request.database).toBe(`projects/${namespace.projectId}/databases/${namespace.databaseId}`);
    call.write(kind === "found" ? found(call) : { missing: call.request.documents![0]! }); call.end();
  });
  expect(await f.reader.requested(operation)).toBe(kind === "found"); await f.reader.close();
  expect(f.calls()).toBe(1); expect(f.statuses).toEqual([grpcStatus.OK]); expect(f.events).toContain("end");
});
test.each(["before-headers", "after-found"])("real SDK cancellation %s confirms CANCELLED plus readable closure", async stage => {
  const f = await fixture(call => { if (stage === "after-found") call.write(found(call)); });
  const controller = new AbortController(), pending = f.reader.requested(operation, controller.signal), failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(f.calls()).toBe(1), { timeout: 1_000 }); if (stage === "after-found") await vi.waitFor(() => expect(f.events).toContain("data"));
  controller.abort(); await failed; await f.reader.close();
  expect(f.statuses).toEqual([grpcStatus.CANCELLED]); expect(f.events.some(event => event === "end" || event === "close")).toBe(true); expect(f.calls()).toBe(1);
});
test("real SDK remaining deadline is enforced and does not retry a held stream", async () => {
  let deadline = 0;
  const initialize = v1.FirestoreClient.prototype.initialize;
  vi.spyOn(v1.FirestoreClient.prototype, "initialize").mockImplementation(async function (this: InstanceType<typeof v1.FirestoreClient>) {
    await new Promise(resolve => setTimeout(resolve, 80)); return initialize.call(this);
  });
  const f = await fixture(call => { deadline = Number(call.getDeadline()); });
  const started = Date.now(), pending = f.reader.requested(operation), failed = expect(pending).rejects.toThrow();
  await failed; await f.reader.close();
  expect(f.options[0].timeout).toBeLessThan(9_950); expect(deadline).toBeLessThanOrEqual(started + 10_050);
  // The absolute caller guard may win the few-ms race with the SDK deadline;
  // either real terminal status still proves disposal, never an error alone.
  expect([grpcStatus.DEADLINE_EXCEEDED, grpcStatus.CANCELLED]).toContain(f.statuses[0]);
  expect(f.events.some(event => event === "end" || event === "close")).toBe(true); expect(f.calls()).toBe(1);
}, 15_000);
test("real SDK UNAVAILABLE is terminal and all streaming retry layers stay disabled", async () => {
  const f = await fixture(call => call.emit("error", Object.assign(new Error("synthetic unavailable"), { code: grpcStatus.UNAVAILABLE })));
  await expect(f.reader.requested(operation)).rejects.toThrow(); await f.reader.close();
  expect(f.statuses).toEqual([grpcStatus.UNAVAILABLE]); expect(f.calls()).toBe(1);
});
test.each(["empty", "foreign", "duplicate"])("real SDK %s response cannot become a no-stop result", async kind => {
  const f = await fixture(call => {
    if (kind !== "empty") call.write({ missing: call.request.documents![0]! + (kind === "foreign" ? "-foreign" : "") });
    if (kind === "duplicate") call.write({ missing: call.request.documents![0]! }); call.end();
  });
  await expect(f.reader.requested(operation)).rejects.toThrow(); await f.reader.close();
  expect(f.calls()).toBe(1); expect(f.statuses).toHaveLength(1);
  expect(f.events.some(event => event === "end" || event === "close")).toBe(true);
});
test("real SDK pre-binding cancel is not assumed to produce a terminal status", async () => {
  const controller = new AbortController(), f = await fixture(call => call.end(), () => queueMicrotask(() => controller.abort()));
  await expect(f.reader.requested(operation, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  if (!f.statuses.length) await expect(f.reader.close()).rejects.toThrow("cleanup unconfirmed");
  else { await f.reader.close(); expect(f.events.some(event => event === "end" || event === "close")).toBe(true); }
  expect(f.calls()).toBeLessThanOrEqual(1);
});
