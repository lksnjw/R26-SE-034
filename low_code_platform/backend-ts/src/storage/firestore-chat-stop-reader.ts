import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import firestore from "@google-cloud/firestore";
import { ChannelCredentials } from "@grpc/grpc-js";
import type { AppConfig } from "../config/config.js";
import type { ChatOperation } from "../repository/store.js";
import { chatCancellationIntent, chatCancellationRecordSchema, type ChatCancellationIntent } from "../agent/chat-cancellation.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { FIRESTORE_RECORD_BOUNDS, FirestoreRecordCodec } from "./firestore-record-codec.js";

const { v1 } = firestore;
const READ_MS = 10_000, CLOSE_MS = 1_000;
const abandoned = () => new DOMException("Stop observation abandoned", "AbortError");
const uncertain = () => new Error("Stop observer SDK cleanup unconfirmed");
type Client = InstanceType<typeof v1.FirestoreClient>;
type Stream = ReturnType<Client["batchGetDocuments"]>;
type Observation = { stop(error: Error): void; disposed: Promise<void> };

/** The GAPIC does not inherit the high-level SDK's emulator configuration. */
function emulatorEndpoint(value: string) {
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  if (!match) throw new Error("Invalid Firestore stop observer emulator endpoint");
  const host = match[1]!, port = Number(match[2]);
  if (port < 1 || port > 65535 || (host.startsWith("[") ? isIP(host.slice(1, -1)) !== 6 :
    host.length > 253 || host.split(".").some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))))
    throw new Error("Invalid Firestore stop observer emulator endpoint");
  return { servicePath: host, port };
}

/** Stop-only, exact-document transport. Caller completion is distinct from
 * terminal SDK disposal; cancellation alone is never disposal evidence. */
export class FirestoreChatStopReader {
  readonly #codec: FirestoreRecordCodec;
  readonly #client: Client;
  readonly #database: string;
  readonly #emulator: boolean;
  readonly #observations = new Set<Observation>();
  #fenced = false;
  #auxiliary: Promise<unknown> | undefined;
  #main: Promise<unknown> | undefined;
  #initialization: Promise<void> | undefined;
  #closing: Promise<void> | undefined;

  constructor(config: AppConfig, codec: FirestoreRecordCodec) {
    this.#codec = codec;
    this.#database = `projects/${codec.namespace.projectId}/databases/${codec.namespace.databaseId}`;
    const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
    this.#emulator = endpoint !== undefined;
    this.#client = new v1.FirestoreClient({ projectId: codec.namespace.projectId, fallback: false,
      gaxServerStreamingRetries: false, "grpc.enable_retries": 0,
      ...(endpoint !== undefined ? { ...emulatorEndpoint(endpoint), sslCreds: ChannelCredentials.createInsecure(), universeDomain: "googleapis.com" } : {
        ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}),
        ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}),
      }),
    });
  }
  private initialize() {
    return this.#initialization ??= (async () => {
      // This installed main close detaches Locations.close(). Establish the
      // public auxiliary promise first, so cleanup can safely order both closes.
      this.#auxiliary = Promise.resolve().then(() => this.#client.locationsClient.initialize());
      await this.#auxiliary;
      if (this.#fenced) throw abandoned();
      this.#main = Promise.resolve().then(() => {
        if (this.#fenced) throw abandoned();
        return this.#client.initialize();
      });
      await this.#main;
      if (this.#fenced) throw abandoned();
    })();
  }
  private decode(response: unknown, name: string, intent: ChatCancellationIntent): boolean {
    if (!response || typeof response !== "object") throw new Error("Invalid stop observation response");
    const row = response as { found?: { name?: unknown; fields?: Record<string, any> } | null; missing?: unknown };
    if (row.found != null) {
      if (row.missing != null && row.missing !== "" || row.found.name !== name) throw new Error("Foreign or ambiguous stop observation");
      const fields = row.found.fields;
      if (!fields || Object.keys(fields).sort().join("|") !== "payload|profile") throw new Error("Invalid stop observation fields");
      const profile = fields.profile, payload = fields.payload;
      const only = (value: any, type: string) => value && typeof value === "object" &&
        Object.keys(value).every(key => key === type || key === "valueType") && (value.valueType === undefined || value.valueType === type);
      if (!only(profile, "stringValue") || profile.stringValue !== "firestore-private/v1" || !only(payload, "bytesValue") ||
        !(payload.bytesValue instanceof Uint8Array) || payload.bytesValue.byteLength + 8192 > FIRESTORE_RECORD_BOUNDS.documentBytes)
        throw new Error("Invalid stop observation ciphertext");
      const saved = chatCancellationRecordSchema.parse(this.#codec.decodeHead({
        profile: "firestore-private/v1", payload: Buffer.from(payload.bytesValue),
      })).intent;
      if (!canonicalJSONBytes(saved).equals(canonicalJSONBytes(intent))) throw new Error("Original chat cancellation identity changed");
      return true;
    }
    if (row.missing !== name) throw new Error("Empty or foreign stop observation");
    return false;
  }
  requested(operation: ChatOperation, signal?: AbortSignal): Promise<boolean> {
    if (this.#fenced) return Promise.reject(abandoned());
    if (signal?.aborted) return Promise.reject(abandoned());
    // Capture original identity before any await; a caller mutating its object
    // cannot rebind an already admitted observation to a different intent.
    let intent: ChatCancellationIntent;
    try { intent = chatCancellationIntent(operation); } catch (error) { return Promise.reject(error); }
    const deadline = performance.now() + READ_MS;
    let settle!: (value: boolean) => void, reject!: (error: Error) => void, done = false;
    let stream: Stream | undefined, cancelCalled = false, status: number | undefined, complete = false, ended = false, count = 0, value = false;
    let disposed!: () => void;
    const disposal = new Promise<void>(resolve => { disposed = resolve; });
    const result = new Promise<boolean>((resolve, fail) => { settle = resolve; reject = fail; });
    const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: Error) => {
      if (!done) {
        done = true; clear(); reject(error);
        if (!this.#fenced) {
          this.#fenced = true;
          for (const other of this.#observations) if (other !== observation) other.stop(abandoned());
        }
      }
      if (stream && !cancelCalled) { cancelCalled = true; try { stream.cancel(); } catch { /* Not terminal evidence. */ } }
    };
    const observation: Observation = { stop: fail, disposed: disposal };
    this.#observations.add(observation);
    const terminal = () => {
      if (status === undefined || !complete) return;
      disposed(); this.#observations.delete(observation);
      if (!done && status === 0 && ended && count === 1) { done = true; clear(); settle(value); }
      else if (!done) fail(new Error("Stop observation transport did not complete successfully"));
    };
    const abort = () => fail(abandoned());
    const timer = setTimeout(() => fail(new Error("Stop observation deadline exceeded")), READ_MS);
    signal?.addEventListener("abort", abort, { once: true });
    // Initialization remains tracked even after the caller abandons it. No late
    // continuation may create a main client or a read after the fence.
    void (async () => {
      await this.initialize();
      if (done || this.#fenced || signal?.aborted || performance.now() >= deadline) throw abandoned();
      const name = `${this.#database}/documents/workspaces/${this.#codec.namespace.workspaceId}/lcwe_chat_stop_intents/${this.#codec.identity("chat-stop-intent/v1", intent)}`;
      stream = this.#client.batchGetDocuments({ database: this.#database, documents: [name] }, {
        timeout: Math.max(1, Math.floor(deadline - performance.now())), retry: null,
        retryRequestOptions: { retries: 0, noResponseRetries: 0, shouldRetryFn: () => false },
        otherArgs: { headers: { "google-cloud-resource-prefix": this.#database, ...(this.#emulator ? { Authorization: "Bearer owner" } : {}) } },
      });
      stream.on("data", (row: unknown) => {
        if (done) return;
        try { if (++count !== 1) throw new Error("Duplicate stop observation"); value = this.decode(row, name, intent); }
        catch (error) { fail(error instanceof Error ? error : new Error("Invalid stop observation")); }
      });
      stream.on("status", (transport: { code?: unknown }) => {
        if (status !== undefined || !Number.isInteger(transport?.code) || Number(transport.code) < 0 || Number(transport.code) > 16) {
          fail(new Error("Invalid stop observation terminal status")); return;
        }
        status = Number(transport.code);
        if (status !== 0) fail(new Error("Stop observation transport failed"));
        terminal();
      });
      stream.on("end", () => { ended = true; complete = true; terminal(); });
      stream.on("close", () => { complete = true; if (!ended && !done) fail(new Error("Stop observation closed before readable completion")); terminal(); });
      // Keep this handler attached through late SDK events, including after a
      // failed bounded close; detached SDK errors must always be consumed.
      stream.on("error", (error: Error) => fail(error));
      if (done || this.#fenced || signal?.aborted) fail(abandoned());
    })().catch(error => {
      fail(error instanceof Error ? error : new Error("Stop observer initialization failed"));
      if (!stream) { disposed(); this.#observations.delete(observation); }
    });
    return result;
  }
  close(): Promise<void> {
    this.#fenced = true;
    if (this.#closing) return this.#closing;
    for (const observation of this.#observations) observation.stop(abandoned());
    const cleanup = (async () => {
      // Snapshot stream disposal after synchronously fencing creation.
      await Promise.all([...this.#observations].map(item => item.disposed));
      if (!this.#auxiliary) return; // Unused lazy transport owns no initialized stub.
      await this.#auxiliary; // Never close a rejected/held auxiliary initializer.
      await this.#client.locationsClient.close(); // Never launch main's detached failure path.
      if (this.#main) {
        try { await this.#main; } catch { /* Still attempt the public main close. */ }
        await this.#client.close();
      }
    })();
    this.#closing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(uncertain()), CLOSE_MS);
      cleanup.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(uncertain()); });
    });
    return this.#closing;
  }
}
