import { Server, ServerCredentials, status as grpcStatus, type MethodDefinition, type ServerUnaryCall, type ServerWritableStream, type sendUnaryData } from "@grpc/grpc-js";
import firestore from "@google-cloud/firestore";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { FirestoreChatCancellation } from "../src/storage/firestore-chat-cancellation.js";
import { FirestoreRecordStore, FirestoreSnapshotChanged } from "../src/storage/firestore-record-store.js";
import { FirestoreRecordCodec, type PrivateFirestoreDocument } from "../src/storage/firestore-record-codec.js";
import { splitFirestoreState } from "../src/storage/firestore-record-layout.js";
import { RuntimeRecordIndex } from "../src/storage/runtime-record-index.js";
import { effectiveUserFromState, type RepositoryState } from "../src/repository/store.js";
import { chatCancellationIntent } from "../src/agent/chat-cancellation.js";
import { loadConfig } from "../src/config/config.js";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";

// The installed high-level Firestore 9.3.1 client owns its actual GAPIC/gax/gRPC
// calls. Only the server's synthetic protocol responses are controlled here.
// No SDK private path, client-pool patch, fake client, or cloud service is used.
type Timestamp = { seconds: number; nanos: number };
type Document = { name: string; fields: Record<string, { stringValue?: string; bytesValue?: Uint8Array }>; createTime: Timestamp; updateTime: Timestamp };
type BatchRequest = { database?: string; documents?: string[]; newTransaction?: object; transaction?: Uint8Array };
type BatchResponse = { found?: Document; missing?: string; transaction?: Uint8Array; readTime: Timestamp };
type QueryRequest = { parent?: string; structuredQuery?: { from?: Array<{ collectionId?: string }>; limit?: { value?: number } }; transaction?: Uint8Array };
type QueryResponse = { document?: Document; readTime: Timestamp };
type CommitRequest = { database?: string; writes?: Array<{ update?: Document }>; transaction?: Uint8Array };
type CommitResponse = { writeResults: Array<{ updateTime: Timestamp }>; commitTime: Timestamp };
type RollbackRequest = { database?: string; transaction?: Uint8Array };
type WireCodec<T> = { encode(value: T): { finish(): Uint8Array }; decode(bytes: Buffer): T };
type Api = {
  BatchGetDocumentsRequest: WireCodec<BatchRequest>; BatchGetDocumentsResponse: WireCodec<BatchResponse>;
  RunQueryRequest: WireCodec<QueryRequest>; RunQueryResponse: WireCodec<QueryResponse>;
  CommitRequest: WireCodec<CommitRequest>; CommitResponse: WireCodec<CommitResponse>;
  RollbackRequest: WireCodec<RollbackRequest>;
};
// Public runtime root export; 9.3.1's root .d.ts omits this runtime property.
const api = (firestore as typeof firestore & { protos: { google: { firestore: { v1: Api }; protobuf: { Empty: WireCodec<object> } } } }).protos;
const namespace = { projectId: "demo-control-disposal", databaseId: "(default)", workspaceId: "control_disposal" }, key = "x".repeat(32);
const codec = new FirestoreRecordCodec(key, namespace), timestamp: Timestamp = { seconds: 1_800_000_000, nanos: 0 };
const database = `projects/${namespace.projectId}/databases/${namespace.databaseId}`, prefix = `${database}/documents/`;
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", STORAGE_ENCRYPTION_KEY: key,
  FIRESTORE_PROJECT_ID: namespace.projectId, FIRESTORE_DATABASE_ID: namespace.databaseId, FIRESTORE_WORKSPACE_ID: namespace.workspaceId, MCP_MODE: "mock" });
let seed: RepositoryState;
const closers: Array<() => Promise<void>> = [];
beforeAll(async () => {
  const f = await boundedChatFixture();
  try { expect((await f.send()).statusCode).toBe(202); seed = await f.repository.snapshot(); }
  finally { await f.close(); }
});
afterEach(async () => {
  try { for (const close of closers.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

function method<Request, Response>(name: string, request: WireCodec<Request>, response: WireCodec<Response>, responseStream: boolean): MethodDefinition<Request, Response> {
  return { path: `/google.firestore.v1.Firestore/${name}`, requestStream: false, responseStream,
    requestSerialize: value => Buffer.from(request.encode(value).finish()), requestDeserialize: bytes => request.decode(bytes),
    responseSerialize: value => Buffer.from(response.encode(value).finish()), responseDeserialize: bytes => response.decode(bytes) };
}
function wireDocument(path: string, packet: PrivateFirestoreDocument): Document {
  return { name: prefix + path, fields: { profile: { stringValue: packet.profile }, payload: { bytesValue: packet.payload } }, createTime: timestamp, updateTime: timestamp };
}
function packet(document: Document): PrivateFirestoreDocument {
  expect(document.fields.profile?.stringValue).toBe("firestore-private/v1");
  return { profile: "firestore-private/v1", payload: Buffer.from(document.fields.payload!.bytesValue!) };
}
// Source-faithful pure fixture construction mirrors migrateStaged's head,
// manifest and chunk format. All authority comes through records.load(), not a
// substituted snapshot, WeakMap insertion, or mocked authorization method.
function committedImage() {
  const documents = new Map<string, Document>(), entries = splitFirestoreState(seed).map(record => codec.encodeRecord(record));
  let index = new RuntimeRecordIndex();
  const headPath = `workspaces/${namespace.workspaceId}/lcwe_runtime/head`;
  for (const entry of entries) {
    index = index.with(entry.key, entry.hash);
    documents.set(prefix + `${headPath}/lcwe_private_records/${codec.manifestId(entry.key)}`, wireDocument(`${headPath}/lcwe_private_records/${codec.manifestId(entry.key)}`,
      codec.encodeHead({ profile: "firestore-record-manifest/v1", key: entry.key, hash: entry.hash, bytes: entry.bytes.length, chunks: entry.chunks.map(chunk => chunk.id) })));
    for (const chunk of entry.chunks) documents.set(prefix + `${headPath}/lcwe_record_chunks/${chunk.id}`, wireDocument(`${headPath}/lcwe_record_chunks/${chunk.id}`, chunk.document));
  }
  const totals = { fingerprint: index.fingerprint, records: entries.length, chunks: entries.reduce((sum, entry) => sum + entry.chunks.length, 0), bytes: entries.reduce((sum, entry) => sum + entry.bytes.length, 0) };
  const head = { profile: "firestore-record-head/v2", revision: 1, ...totals, writerGeneration: null, transition: {
    identity: codec.identity("transition", "control-sdk-fixture-v1"), inputHash: codec.identity("migration", totals), previousRevision: 0, previousFingerprint: new RuntimeRecordIndex().fingerprint } };
  documents.set(prefix + headPath, wireDocument(headPath, codec.encodeHead(head)));
  return { documents, head, headPath };
}
type BatchCall = ServerWritableStream<BatchRequest, BatchResponse>;
type CommitCall = ServerUnaryCall<CommitRequest, CommitResponse>;
type Hooks = {
  batch?: (call: BatchCall, respond: () => void) => boolean;
  commit?: (call: CommitCall, acknowledge: (error?: Error & { code: number }) => void) => void;
  rollback?: (respond: () => void) => void;
};
async function fixture(hooks: Hooks = {}) {
  const server = new Server(), image = committedImage(), before = new Map(image.documents), releases = new Set<() => void>();
  const events: string[] = [], requests = { batch: 0, query: 0, commit: 0, rollback: 0 }, commits: CommitRequest[] = [];
  let transactionId = 0;
  const checkMetadata = (call: { metadata: { get(name: string): unknown[] } }) => expect(call.metadata.get("authorization")).toEqual(["Bearer owner"]);
  server.addService({
    batchGetDocuments: method("BatchGetDocuments", api.google.firestore.v1.BatchGetDocumentsRequest, api.google.firestore.v1.BatchGetDocumentsResponse, true),
    runQuery: method("RunQuery", api.google.firestore.v1.RunQueryRequest, api.google.firestore.v1.RunQueryResponse, true),
    commit: method("Commit", api.google.firestore.v1.CommitRequest, api.google.firestore.v1.CommitResponse, false),
    rollback: method("Rollback", api.google.firestore.v1.RollbackRequest, api.google.protobuf.Empty, false),
  }, {
    batchGetDocuments(call: BatchCall) {
      checkMetadata(call); requests.batch++; expect(call.request.database).toBe(database);
      const tx = call.request.newTransaction ? Buffer.from(`synthetic-transaction-${++transactionId}`) : undefined;
      const respond = () => {
        releases.delete(respond);
        for (const name of call.request.documents ?? []) {
          const found = image.documents.get(name);
          call.write({ ...(found ? { found } : { missing: name }), ...(tx ? { transaction: tx } : {}), readTime: timestamp });
        }
        call.end();
      };
      releases.add(respond); if (!hooks.batch?.(call, respond)) respond();
    },
    runQuery(call: ServerWritableStream<QueryRequest, QueryResponse>) {
      checkMetadata(call); requests.query++;
      const query = call.request.structuredQuery!, collection = `${call.request.parent}/${query.from![0]!.collectionId}/`;
      const rows = [...image.documents].filter(([name]) => name.startsWith(collection) && !name.slice(collection.length).includes("/"));
      for (const [, document] of rows.slice(0, query.limit?.value ?? rows.length)) call.write({ document, readTime: timestamp });
      if (!rows.length) call.write({ readTime: timestamp }); call.end();
    },
    commit(call: CommitCall, callback: sendUnaryData<CommitResponse>) {
      checkMetadata(call); requests.commit++; commits.push(call.request); expect(call.request.database).toBe(database);
      // Only Stop mailbox writes are admitted; any business/head write fails.
      for (const write of call.request.writes ?? []) {
        expect(write.update?.name).toContain(`/workspaces/${namespace.workspaceId}/lcwe_chat_stop_intents/`);
        image.documents.set(write.update!.name, { ...write.update!, createTime: timestamp, updateTime: timestamp });
      }
      let answered = false;
      const acknowledge = (error?: Error & { code: number }) => {
        if (answered) return; answered = true; releases.delete(release);
        callback(error ?? null, error ? undefined : { writeResults: (call.request.writes ?? []).map(() => ({ updateTime: timestamp })), commitTime: timestamp });
      };
      const release = () => acknowledge(); releases.add(release);
      if (hooks.commit) hooks.commit(call, acknowledge); else acknowledge();
    },
    rollback(call: ServerUnaryCall<RollbackRequest, object>, callback: sendUnaryData<object>) {
      checkMetadata(call); requests.rollback++; expect(call.request.transaction?.length).toBeGreaterThan(0);
      const respond = () => { releases.delete(respond); callback(null, {}); };
      releases.add(respond); if (hooks.rollback) hooks.rollback(respond); else respond();
    },
  });
  const shutdown = () => new Promise<void>(resolve => {
    const timer = setTimeout(() => { server.forceShutdown(); resolve(); }, 500);
    server.tryShutdown(() => { clearTimeout(timer); resolve(); });
  });
  closers.push(shutdown);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Control SDK loopback bind timed out")), 1_000);
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) => { clearTimeout(timer); error ? reject(error) : resolve(bound); });
  });
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", `127.0.0.1:${port}`);
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "Z:/nonexistent-control-sdk-test-credentials.json");
  const records = FirestoreRecordStore.create(key, namespace), control = new FirestoreChatCancellation(records, config, true);
  // These public-method observations preserve and await the actual SDK promise.
  // A spy records completion; it never supplies fake disposal success.
  const terminate = records.db.terminate.bind(records.db), close = records.close.bind(records);
  const termination = vi.spyOn(records.db, "terminate").mockImplementation(async () => {
    events.push("terminate-start"); await terminate(); events.push("terminate-complete");
  });
  const transactions = vi.spyOn(records.db, "runTransaction");
  let ownedClosing: Promise<void> | undefined;
  const ownedClose = vi.spyOn(records, "close").mockImplementation(() => {
    events.push("records-close-start"); const pending = close(); ownedClosing ??= pending;
    void pending.then(() => events.push("records-close-complete"), () => events.push("records-close-failed")); return pending;
  });
  const releaseAll = () => { for (const release of [...releases]) release(); };
  const drain = async () => {
    releaseAll();
    await control.close().catch(() => {});
    // A timed-out control.close is permanently rejected. Drain the originally
    // started owned close instead of treating a second records.close as proof.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        await (ownedClosing ?? records.close());
        // A unary ACK may release the SDK pool before its transaction runner
        // finishes a retry/backoff continuation. Also drain that real promise.
        await Promise.allSettled(transactions.mock.results.filter(result => result.type === "return").map(result => result.value));
      })(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Actual owned SDK cleanup did not drain")), 4_000);
      })]);
    } finally { clearTimeout(timer); }
    expect(events).toContain("terminate-complete");
  };
  closers.push(drain);
  const authority = async () => {
    const state = await control.snapshot(); expect(state).toEqual(seed);
    return { state, actor: effectiveUserFromState(state, "owner")!, operation: Object.values(state.chatOperations)[0]! };
  };
  return { control, records, image, before, requests, commits, events, termination, ownedClose, authority, drain, releaseAll };
}
async function cleanupFailsOnce(f: Awaited<ReturnType<typeof fixture>>) {
  const started = Date.now(), closing = f.control.close(), repeated = f.control.close();
  expect(repeated).toBe(closing);
  await expect(closing).rejects.toThrow("cleanup unconfirmed");
  expect(Date.now() - started).toBeGreaterThanOrEqual(900); expect(Date.now() - started).toBeLessThan(2_000);
  expect(f.ownedClose).toHaveBeenCalledTimes(1); expect(f.events).not.toContain("records-close-complete");
  expect(f.control.close()).toBe(closing); await expect(f.control.close()).rejects.toThrow("cleanup unconfirmed");
}
function assertOriginalImage(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [name, document] of f.before) expect(f.image.documents.get(name)).toEqual(document);
}

test("real high-level held snapshot abort reports one cleanup failure, then owned SDK drains naturally", async () => {
  let held: (() => void) | undefined;
  const f = await fixture({ batch: (_call, respond) => { if (!held) { held = respond; return true; } return false; } });
  try {
    const abort = new AbortController(), pending = f.control.snapshot(abort.signal);
    const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(f.requests.batch).toBe(1), { timeout: 1_000 }); abort.abort(); await failed;
    await cleanupFailsOnce(f); expect(f.requests.commit).toBe(0);
    held!(); await f.drain();
    expect(f.termination).toHaveBeenCalledTimes(1); expect(f.requests.commit).toBe(0); assertOriginalImage(f);
    expect(() => f.control.snapshot()).toThrow("closed");
    // records.load may perform SDK-internal reads after caller abort. The
    // control's post-await guard must never resume its authority continuation.
    expect(f.events.indexOf("terminate-complete")).toBeLessThan(f.events.indexOf("records-close-complete"));
  } finally { f.releaseAll(); }
}, 10_000);

test.each(["acknowledged-late", "unknown-ack-lost"] as const)("real committed Stop intent with %s stays failed after abort and cannot replay a commit", async outcome => {
  let finish: ((error?: Error & { code: number }) => void) | undefined;
  const f = await fixture({ commit: (_call, acknowledge) => { finish = acknowledge; } });
  try {
    const { state, actor, operation } = await f.authority(), abort = new AbortController();
    const pending = f.control.request(state, actor, operation.id, abort.signal), failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(f.requests.commit).toBe(1), { timeout: 1_000 });
    expect(f.commits[0]!.writes).toHaveLength(1); abort.abort(); await failed; await cleanupFailsOnce(f);
    expect(f.events).toContain("terminate-start"); expect(f.events).not.toContain("terminate-complete");
    const countBeforeRelease = { ...f.requests };
    finish!(outcome === "unknown-ack-lost" ? Object.assign(new Error("Synthetic acknowledgement lost after commit"), { code: grpcStatus.UNKNOWN }) : undefined);
    await f.drain();
    expect(f.requests.batch).toBe(countBeforeRelease.batch); expect(f.requests.query).toBe(countBeforeRelease.query); expect(f.requests.commit).toBe(1);
    expect(f.termination).toHaveBeenCalledTimes(1); assertOriginalImage(f);
    const intents = [...f.image.documents].filter(([name]) => name.includes("/lcwe_chat_stop_intents/")); expect(intents).toHaveLength(1);
    expect(codec.decodeHead(packet(intents[0]![1]))).toMatchObject({ profile: "chat-cancellation-record/v1", intent: chatCancellationIntent(operation) });
    expect(state.chatOperations[operation.id]).toEqual(seed.chatOperations[operation.id]); expect(state.chatOperations[operation.id]!.status).toBe("QUEUED");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(() => f.control.request(state, actor, operation.id)).toThrow("closed");
    // UNKNOWN can make the SDK try its callback again; checkActive fences that
    // callback before another control read/write. This does not claim to disable
    // the SDK's transaction retry mechanism or establish remote cancellation.
  } finally { f.releaseAll(); }
}, 10_000);

test("actual detached rollback outlives runTransaction and prevents successful disposal until the RPC drains", async () => {
  let rollback: (() => void) | undefined;
  const f = await fixture({ rollback: respond => { rollback = respond; } });
  try {
    const { state, actor, operation } = await f.authority();
    const changed = { ...f.image.head, revision: 2, transition: { ...f.image.head.transition, previousRevision: 1, previousFingerprint: f.image.head.fingerprint } };
    f.image.documents.set(prefix + f.image.headPath, wireDocument(f.image.headPath, codec.encodeHead(changed)));
    await expect(f.control.request(state, actor, operation.id)).rejects.toBeInstanceOf(FirestoreSnapshotChanged);
    await vi.waitFor(() => expect(f.requests.rollback).toBe(1), { timeout: 1_000 });
    await cleanupFailsOnce(f); expect(f.events).toContain("terminate-start"); expect(f.events).not.toContain("terminate-complete");
    rollback!(); await f.drain(); expect(f.termination).toHaveBeenCalledTimes(1); expect(f.requests.commit).toBe(0);
  } finally { f.releaseAll(); }
}, 10_000);

test("real coherent Stop acknowledgement preserves original task state and close awaits its owned high-level client", async () => {
  const f = await fixture();
  try {
    const { state, actor, operation } = await f.authority();
    expect(await f.control.request(state, actor, operation.id)).toMatchObject({ status: "QUEUED", cancellationRequested: true });
    expect(state.chatOperations[operation.id]).toEqual(seed.chatOperations[operation.id]); assertOriginalImage(f);
    expect(f.requests.commit).toBe(1); expect(f.commits[0]!.writes).toHaveLength(1);
    const closing = f.control.close(); expect(f.control.close()).toBe(closing); await closing;
    expect(f.events).toEqual(["records-close-start", "terminate-start", "terminate-complete", "records-close-complete"]);
    expect(f.ownedClose).toHaveBeenCalledTimes(1); expect(f.termination).toHaveBeenCalledTimes(1);
    expect(() => f.control.requested(operation)).toThrow("closed");
  } finally { f.releaseAll(); }
});
