import { Firestore, type Settings, type Transaction } from "@google-cloud/firestore";
import { AsyncMutex } from "../repository/async-mutex.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { recordKey, type RuntimeRecord } from "./execution-record-layout.js";
import { RuntimeRecordIndex } from "./runtime-record-index.js";
import { FirestoreRecordCodec, validateFirestoreNamespace, FIRESTORE_RECORD_BOUNDS as B, type FirestoreNamespace, type EncodedFirestoreRecord, type PrivateFirestoreDocument, type RecordChunk } from "./firestore-record-codec.js";
import { FirestoreWriterOwnership, FirestoreOwnershipFailure, type FirestoreWriterClock } from "./firestore-writer-ownership.js";

type Transition = { identity: string; inputHash: string; previousRevision: number; previousFingerprint: string };
type Head = { profile: "firestore-record-head/v2"; revision: number; records: number; chunks: number; bytes: number; fingerprint: string; writerGeneration: number | null; transition: Transition };
type Manifest = { profile: "firestore-record-manifest/v1"; key: string; hash: string; bytes: number; chunks: string[] };
type Entry = EncodedFirestoreRecord & { manifest: PrivateFirestoreDocument };
type View = { head: Head | null; index: RuntimeRecordIndex; entries: Map<string, Entry> };
export type FirestoreRecordSnapshot = Readonly<{ profile: "firestore-record-snapshot/v1"; revision: number; recordCount: number; chunkCount: number; bytes: number; fingerprint: string; transitionIdentity: string | null }>;
export type FirestoreRecordMutation = { transitionId: string; upsert: readonly RuntimeRecord[]; remove?: readonly string[][] };
const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|"));
const fingerprint = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const bounded = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const sameDocument = (actual: unknown, expected: PrivateFirestoreDocument) => exact(actual, ["profile", "payload"]) && actual.profile === expected.profile && Buffer.isBuffer(actual.payload) && actual.payload.equals(expected.payload);
const copyDocument = (document: PrivateFirestoreDocument): PrivateFirestoreDocument => ({ profile: "firestore-private/v1", payload: Buffer.from(document.payload) });

/** Lower-level encrypted record store, deliberately NOT a qualified
 * PersistenceBackend. Immutable bodies are prepared first; only the atomic
 * head/manifest transaction makes them authoritative. CAS is not an exclusive
 * lease, membership authority, semantic validation or final SDK ownership proof.
 * No ERP/model call or application callback runs in transaction retries. */
export class FirestoreRecordStore {
  readonly #codec: FirestoreRecordCodec;
  readonly #mutex = new AsyncMutex();
  readonly #views = new WeakMap<FirestoreRecordSnapshot, View>();
  #uncertain = false;
  #closed = false;
  #writer: FirestoreWriterOwnership | null = null;
  readonly collectionPath: string;
  readonly chunkCollectionPath: string;
  readonly headPath: string;
  readonly writerPath: string;
  readonly writerGenerationPath: string;
  private constructor(readonly db: Firestore, codec: FirestoreRecordCodec) {
    this.#codec = codec; const namespace = codec.namespace;
    if (db.databaseId !== namespace.databaseId) throw new Error("Firestore client and explicit namespace differ");
    this.headPath = `workspaces/${namespace.workspaceId}/lcwe_runtime/head`;
    this.writerPath = `workspaces/${namespace.workspaceId}/lcwe_runtime/writer`;
    this.writerGenerationPath = `workspaces/${namespace.workspaceId}/lcwe_runtime/writer_generation`;
    this.collectionPath = `${this.headPath}/lcwe_private_records`;
    this.chunkCollectionPath = `${this.headPath}/lcwe_record_chunks`;
  }
  static create(encryptionKey: string, namespace: FirestoreNamespace, authentication: Pick<Settings, "keyFilename" | "credentials"> = {}): FirestoreRecordStore {
    const scope = validateFirestoreNamespace(namespace), codec = new FirestoreRecordCodec(encryptionKey, scope);
    const db = new Firestore({ projectId: scope.projectId, databaseId: scope.databaseId,
      ...(authentication.keyFilename ? { keyFilename: authentication.keyFilename } : {}),
      ...(authentication.credentials ? { credentials: authentication.credentials } : {}) });
    return new FirestoreRecordStore(db, codec);
  }
  private assertOpen() { if (this.#closed) throw new Error("Firestore record store is closed"); }
  async acquireWriter(options: { duration?: number; clock?: FirestoreWriterClock } = {}): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertOpen(); if (this.#writer) throw new FirestoreOwnershipFailure();
      const writer = new FirestoreWriterOwnership(this.db, this.#codec, options.duration, options.clock); this.#writer = writer;
      writer.observeUnavailable(() => { this.#uncertain = true; });
      try { await writer.acquire(); this.assertOpen(); }
      catch (error) { this.#uncertain = true; throw error; }
    });
  }
  assertWriterActive(): void {
    this.assertOpen(); if (!this.#writer || this.#uncertain) throw new FirestoreOwnershipFailure(); this.#writer.assertActive();
  }
  async renewWriter(): Promise<void> {
    this.assertOpen(); if (!this.#writer) throw new FirestoreOwnershipFailure(); await this.#writer.renew();
  }
  observeWriterUnavailable(observer: () => void): () => void {
    if (!this.#writer) throw new FirestoreOwnershipFailure(); return this.#writer.observeUnavailable(observer);
  }
  private withWriter<T>(operation: () => Promise<T>): Promise<T> { return this.#writer ? this.#writer.withAuthority(operation) : operation(); }
  private async assertWriterTransaction(transaction: Transaction): Promise<void> {
    if (this.#writer) await this.#writer.assertTransaction(transaction);
    else if ((await transaction.getAll(this.db.doc(this.writerPath), this.db.doc(this.writerGenerationPath))).some(row => row.exists)) throw new FirestoreOwnershipFailure();
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true;
    const release = this.#writer?.close();
    await this.#mutex.runExclusive(async () => { try { await release; } finally { await this.db.terminate(); } });
  }
  get writeUncertain() { return this.#uncertain; }
  /** Bounded authority/head probe, not a full-image reload or a lease renewal.
   * A probe cannot clear uncertainty or adopt a changed authoritative image. */
  async probeWriter(snapshot: FirestoreRecordSnapshot): Promise<void> {
    await this.#mutex.runExclusive(() => this.withWriter(async () => {
      this.assertWriterActive(); const expected = this.view(snapshot).head;
      try {
        await this.db.runTransaction(async transaction => {
          await this.assertWriterTransaction(transaction);
          const row = await transaction.get(this.db.doc(this.headPath)), actual = row.exists ? this.head(row.data()) : null;
          if (!same(actual, expected)) throw new Error("Firestore authoritative image changed; reload is required");
          this.#writer!.assertTransactionDeadline();
        }, { readOnly: true });
        this.assertWriterActive();
      } catch (error) { this.#uncertain = true; throw error; }
    }));
  }
  private view(snapshot: FirestoreRecordSnapshot): View {
    const view = this.#views.get(snapshot); if (!view) throw new Error("Firestore snapshot does not belong to this store"); return view;
  }
  private snapshot(view: View): FirestoreRecordSnapshot {
    const snapshot = Object.freeze({ profile: "firestore-record-snapshot/v1" as const, revision: view.head?.revision ?? 0,
      recordCount: view.head?.records ?? 0, chunkCount: view.head?.chunks ?? 0, bytes: view.head?.bytes ?? 0,
      fingerprint: view.index.fingerprint, transitionIdentity: view.head?.transition.identity ?? null });
    this.#views.set(snapshot, view); return snapshot;
  }
  readRecords(snapshot: FirestoreRecordSnapshot, paths?: readonly string[][]): RuntimeRecord[] {
    this.assertOpen();
    this.#writer?.assertActive();
    if (this.#uncertain) throw new Error("Firestore snapshot reads are fenced until authoritative reload");
    const view = this.view(snapshot);
    if (!paths) return [...view.entries.values()].map(entry => structuredClone(entry.record));
    return paths.map(path => {
      const key = recordKey(path); this.#codec.manifestId(key);
      const entry = view.entries.get(key); if (!entry) throw new Error("Firestore snapshot record is missing");
      return structuredClone(entry.record);
    });
  }
  private head(document: unknown): Head {
    const value = this.#codec.decodeHead(document);
    if (!exact(value, ["profile", "revision", "records", "chunks", "bytes", "fingerprint", "writerGeneration", "transition"]) || value.profile !== "firestore-record-head/v2" ||
        !bounded(value.revision, 1, Number.MAX_SAFE_INTEGER) || !bounded(value.records, 1, B.recordCount) || !bounded(value.chunks, Number(value.records), B.chunkCount) ||
        !bounded(value.bytes, 1, B.imageBytes) || !fingerprint(value.fingerprint) || value.writerGeneration !== null && !bounded(value.writerGeneration, 1, Number.MAX_SAFE_INTEGER) || !exact(value.transition, ["identity", "inputHash", "previousRevision", "previousFingerprint"]) ||
        !fingerprint(value.transition.identity) || !fingerprint(value.transition.inputHash) || !fingerprint(value.transition.previousFingerprint) || value.transition.previousRevision !== Number(value.revision) - 1) throw new Error("Invalid authenticated Firestore head");
    return value as Head;
  }
  private manifestValue(entry: EncodedFirestoreRecord): Manifest {
    return { profile: "firestore-record-manifest/v1", key: entry.key, hash: entry.hash, bytes: entry.bytes.length, chunks: entry.chunks.map(chunk => chunk.id) };
  }
  private manifest(id: string, document: unknown): Manifest {
    const value = this.#codec.decodeHead(document);
    if (!exact(value, ["profile", "key", "hash", "bytes", "chunks"]) || value.profile !== "firestore-record-manifest/v1" || typeof value.key !== "string" || !fingerprint(value.hash) ||
        !bounded(value.bytes, 1, B.recordBytes) || !Array.isArray(value.chunks) || value.chunks.length !== Math.ceil(Number(value.bytes) / B.chunkBytes) ||
        id !== this.#codec.manifestId(value.key) || value.chunks.some((chunk, at) => chunk !== this.#codec.documentId(value.key as string, at, value.hash as string))) throw new Error("Invalid authenticated Firestore manifest");
    return value as Manifest;
  }
  private sameChunk(id: string, actual: unknown, expected: PrivateFirestoreDocument): boolean {
    const a = this.#codec.decodeChunk(id, actual), b = this.#codec.decodeChunk(id, expected);
    const { body: aBody, ...aMeta } = a, { body: bBody, ...bMeta } = b;
    return same(aMeta, bMeta) && aBody.equals(bBody);
  }
  private async readChunks(transaction: Transaction, ids: string[]): Promise<Map<string, PrivateFirestoreDocument>> {
    const documents = new Map<string, PrivateFirestoreDocument>();
    for (let at = 0; at < ids.length; at += B.readBatch) {
      this.assertOpen();
      const batch = ids.slice(at, at + B.readBatch), rows = await transaction.getAll(...batch.map(id => this.db.collection(this.chunkCollectionPath).doc(id)));
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!; if (!row.exists) throw new Error("Firestore referenced chunk is missing");
        const document = row.data() as PrivateFirestoreDocument; this.#codec.decodeChunk(batch[index]!, document);
        documents.set(batch[index]!, copyDocument(document));
      }
    }
    return documents;
  }
  async load(): Promise<FirestoreRecordSnapshot> {
    return this.#mutex.runExclusive(() => this.withWriter(async () => {
      this.assertOpen();
      try {
        const view = await this.db.runTransaction(async transaction => {
          if (this.#writer) await this.assertWriterTransaction(transaction);
          const headDoc = await transaction.get(this.db.doc(this.headPath)), head = headDoc.exists ? this.head(headDoc.data()) : null;
          if (head?.writerGeneration !== undefined && head.writerGeneration !== null && this.#writer && this.#writer.generation! < head.writerGeneration) throw new FirestoreOwnershipFailure();
          const rows = await transaction.get(this.db.collection(this.collectionPath).limit((head?.records ?? 0) + 1));
          if (!head) {
            if (!rows.empty) throw new Error("Firestore manifests have no authoritative head");
            return { head: null, entries: new Map<string, Entry>(), index: new RuntimeRecordIndex() };
          }
          if (rows.size !== head.records) throw new Error("Firestore manifest count differs from the authenticated head");
          const manifests = rows.docs.map(row => ({ value: this.manifest(row.id, row.data()), document: copyDocument(row.data() as PrivateFirestoreDocument) }));
          const ids = manifests.flatMap(row => row.value.chunks);
          if (ids.length !== head.chunks || new Set(ids).size !== ids.length || manifests.reduce((sum, row) => sum + row.value.bytes, 0) !== head.bytes) throw new Error("Firestore manifest totals differ from their authenticated head");
          // Unreferenced preparation/retirement chunks cannot activate state.
          // Reachability GC is a separate, not-yet-qualified protocol.
          const packets = await this.readChunks(transaction, ids), entries = new Map<string, Entry>(); let index = new RuntimeRecordIndex();
          for (const row of manifests) {
            const chunks = row.value.chunks.map(id => ({ id, document: packets.get(id)! })), decoded = chunks.map(chunk => this.#codec.decodeChunk(chunk.id, chunk.document));
            const record = this.#codec.decodeRecord(decoded), bytes = canonicalJSONBytes(record), key = recordKey(record.path);
            if (key !== row.value.key || bytes.length !== row.value.bytes || decoded[0]!.hash !== row.value.hash || entries.has(key)) throw new Error("Firestore body differs from its authenticated manifest");
            entries.set(key, { key, record, bytes, hash: row.value.hash, chunks, manifest: row.document }); index = index.with(key, row.value.hash);
          }
          if (index.fingerprint !== head.fingerprint) throw new Error("Firestore records differ from their authenticated head");
          return { head, entries, index };
        }, { readOnly: true });
        this.assertOpen(); this.#uncertain = false; return this.snapshot(view);
      } catch (error) { this.#uncertain = true; throw error; }
    }));
  }
  private async stage(chunks: RecordChunk[]): Promise<void> {
    let cursor = 0, failed = false;
    // Drain already-started operations before releasing the mutex. Recovery or
    // close cannot be followed by a late staging write from this operation.
    const results = await Promise.allSettled(Array.from({ length: Math.min(B.stagingConcurrency, chunks.length) }, async () => {
      while (!failed && cursor < chunks.length) {
        const chunk = chunks[cursor++]!;
        try {
          this.assertOpen(); const ref = this.db.collection(this.chunkCollectionPath).doc(chunk.id);
          try { await ref.create(chunk.document); }
          catch (error) {
            if ((error as { code?: number }).code !== 6) throw error;
            const row = await ref.get();
            if (!row.exists || !this.sameChunk(chunk.id, row.data(), chunk.document)) throw new Error("Firestore immutable staged chunk differs");
            chunk.document = copyDocument(row.data() as PrivateFirestoreDocument);
          }
        } catch (error) { failed = true; throw error; }
      }
    }));
    const failure = results.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
  }
  /** One-time empty-target initializer for images larger than a normal atomic
   * checkpoint. Immutable encrypted bodies and manifests are prepared first;
   * one writer-fenced transaction verifies the complete exact manifest set and
   * publishes the authoritative head last. A crash before that head remains
   * unavailable to normal load and an exact retry may reuse identical packets. */
  async initializeStaged(records: readonly RuntimeRecord[], transitionId: string,
    sourceGuard?: Readonly<{ path: "runtime/state"; document: unknown }>): Promise<FirestoreRecordSnapshot> {
    return this.#mutex.runExclusive(() => this.withWriter(async () => {
      this.assertOpen();
      if (this.#uncertain) throw new Error("Firestore must be authoritatively reopened after an uncertain staged migration");
      if (typeof transitionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(transitionId) || !Array.isArray(records) || !records.length || records.length > B.migrationRecords)
        throw new Error("Invalid bounded Firestore staged migration");
      if (sourceGuard && (sourceGuard.path !== "runtime/state" || !sourceGuard.document || typeof sourceGuard.document !== "object" || Array.isArray(sourceGuard.document)))
        throw new Error("Invalid Firestore staged migration source guard");
      const entries = new Map<string, Entry>(), manifests = new Map<string, PrivateFirestoreDocument>();
      let index = new RuntimeRecordIndex(), totalBytes = 0, chunkCount = 0, manifestBytes = 0;
      for (const record of records) {
        const encoded = this.#codec.encodeRecord(record), key = encoded.key, id = this.#codec.manifestId(key);
        if (entries.has(key) || manifests.has(id)) throw new Error("Duplicate Firestore staged migration address");
        totalBytes += encoded.bytes.length; chunkCount += encoded.chunks.length; index = index.with(key, encoded.hash);
        // Conservative read-side serialized document allowance. The normal
        // write budget uses a larger per-write allowance; activation reads the
        // prepared manifests and writes only the head.
        const manifest = this.#codec.encodeHead(this.manifestValue(encoded)); manifestBytes += manifest.payload.length + 1024;
        if (totalBytes > B.imageBytes || chunkCount > B.chunkCount || manifestBytes > B.migrationManifestBytes)
          throw new Error("Firestore staged migration budget exceeded");
        entries.set(key, { ...encoded, manifest }); manifests.set(id, manifest);
      }
      const emptyFingerprint = new RuntimeRecordIndex().fingerprint;
      const transition: Transition = { identity: this.#codec.identity("transition", transitionId), inputHash: this.#codec.identity("migration", {
        fingerprint: index.fingerprint, records: entries.size, chunks: chunkCount, bytes: totalBytes }), previousRevision: 0, previousFingerprint: emptyFingerprint };
      const head: Head = { profile: "firestore-record-head/v2", revision: 1, records: entries.size, chunks: chunkCount, bytes: totalBytes,
        fingerprint: index.fingerprint, writerGeneration: this.#writer?.generation ?? null, transition }, headDocument = this.#codec.encodeHead(head);
      try {
        const headRow = await this.db.doc(this.headPath).get();
        if (headRow.exists) throw new Error("Staged migration requires an empty target; existing records are not overwritten");
        await this.stage([...entries.values()].flatMap(entry => entry.chunks)); this.assertOpen();
        const pending = [...manifests.entries()];
        for (let offset = 0; offset < pending.length; offset += B.stagingConcurrency) await Promise.all(pending.slice(offset, offset + B.stagingConcurrency).map(async ([id, document]) => {
          const ref = this.db.collection(this.collectionPath).doc(id);
          try { await ref.create(document); }
          catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== 6) throw error;
            const existing = await ref.get();
            if (!existing.exists || !same(this.manifest(id, existing.data()), this.manifest(id, document))) throw new Error("Firestore staged manifest address already contains different data");
            const acknowledged = copyDocument(existing.data() as PrivateFirestoreDocument), key = this.manifest(id, acknowledged).key, entry = entries.get(key);
            if (!entry) throw new Error("Firestore staged manifest address is outside the authenticated migration");
            manifests.set(id, acknowledged); entries.set(key, { ...entry, manifest: acknowledged });
          }
          this.assertOpen(); this.#writer?.assertTransactionDeadline();
        }));
        await this.db.runTransaction(async transaction => {
          await this.assertWriterTransaction(transaction);
          const actualHead = await transaction.get(this.db.doc(this.headPath));
          if (actualHead.exists) throw new Error("Staged migration requires an empty target; existing records are not overwritten");
          if (sourceGuard) {
            const source = await transaction.get(this.db.doc(sourceGuard.path));
            if (!source.exists || !same(source.data(), sourceGuard.document)) throw new Error("Legacy Firestore source changed after backup verification; activation denied");
          }
          const rows = await transaction.get(this.db.collection(this.collectionPath).limit(entries.size + 1));
          if (rows.size !== entries.size) throw new Error("Firestore staged manifest set differs from the authenticated migration");
          for (const row of rows.docs) {
            const expected = manifests.get(row.id);
            if (!expected || !sameDocument(row.data(), expected)) throw new Error("Firestore staged manifest set differs from the authenticated migration");
          }
          this.assertOpen(); this.#writer?.assertTransactionDeadline(); transaction.set(this.db.doc(this.headPath), headDocument); return null;
        }, { maxAttempts: 5 });
        this.assertOpen(); return this.snapshot({ head, index, entries });
      } catch (error) { this.#uncertain = true; throw error; }
    }));
  }
  async commit(snapshot: FirestoreRecordSnapshot, mutation: FirestoreRecordMutation): Promise<FirestoreRecordSnapshot> {
    return this.#mutex.runExclusive(() => this.withWriter(async () => {
      this.assertOpen();
      if (this.#uncertain) throw new Error("Firestore must be authoritatively reloaded after an uncertain operation");
      const base = this.view(snapshot);
      if (typeof mutation.transitionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(mutation.transitionId) || !Array.isArray(mutation.upsert) || !Array.isArray(mutation.remove ?? []) || mutation.upsert.length + (mutation.remove?.length ?? 0) > B.transactionWrites) throw new Error("Invalid bounded Firestore mutation");
      const next = new Map(base.entries), seen = new Set<string>(), changed = new Set<string>(), writes = new Map<string, PrivateFirestoreDocument | null>(), expected = new Map<string, PrivateFirestoreDocument | null>();
      let index = base.index, totalBytes = base.head?.bytes ?? 0, chunks = base.head?.chunks ?? 0, preparationBytes = 0;
      const replace = (key: string, value: EncodedFirestoreRecord | null) => {
        if (seen.has(key)) throw new Error("Duplicate Firestore mutation address"); seen.add(key);
        const old = base.entries.get(key);
        if (!old && !value || old && value && old.bytes.equals(value.bytes)) return;
        changed.add(key); const id = this.#codec.manifestId(key); expected.set(id, old?.manifest ?? null);
        if (old) { totalBytes -= old.bytes.length; chunks -= old.chunks.length; index = index.without(key); next.delete(key); }
        if (value) {
          totalBytes += value.bytes.length; chunks += value.chunks.length; index = index.with(key, value.hash);
          const manifest = this.#codec.encodeHead(this.manifestValue(value)); next.set(key, { ...value, manifest }); writes.set(id, manifest);
        } else writes.set(id, null);
        if (totalBytes > B.imageBytes || chunks > B.chunkCount || next.size > B.recordCount) throw new Error("Firestore image budget exceeded");
      };
      // Inputs, identifiers, ciphertext and random nonces are prepared once
      // OUTSIDE SDK callbacks. Never split an authoritative checkpoint.
      for (const path of mutation.remove ?? []) { const key = recordKey(path); this.#codec.manifestId(key); replace(key, null); }
      for (const record of mutation.upsert) {
        const encoded = this.#codec.encodeRecord(record); preparationBytes += encoded.bytes.length;
        if (preparationBytes > B.mutationBytes) throw new Error("Firestore mutation preparation budget exceeded; staged migration is required");
        replace(encoded.key, encoded);
      }
      const revision = (base.head?.revision ?? 0) + 1;
      if (!bounded(revision, 1, Number.MAX_SAFE_INTEGER) || next.size < 1) throw new Error("Firestore image budget exceeded");
      const transition: Transition = { identity: this.#codec.identity("transition", mutation.transitionId),
        inputHash: this.#codec.identity("mutation", { revision: base.head?.revision ?? 0, fingerprint: base.index.fingerprint,
          upsert: mutation.upsert.map(record => [recordKey(record.path), next.get(recordKey(record.path))!.hash]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0), remove: (mutation.remove ?? []).map(recordKey).sort() }),
        previousRevision: base.head?.revision ?? 0, previousFingerprint: base.index.fingerprint };
      const head: Head = { profile: "firestore-record-head/v2", revision, records: next.size, chunks, bytes: totalBytes, fingerprint: index.fingerprint, writerGeneration: this.#writer?.generation ?? base.head?.writerGeneration ?? null, transition }, headDocument = this.#codec.encodeHead(head);
      let wireBytes = headDocument.payload.length + 8192;
      for (const [id, document] of writes) wireBytes += (document ?? expected.get(id))!.payload.length + 8192;
      if (writes.size + 1 > B.transactionWrites || wireBytes > B.transactionBytes) throw new Error("Firestore atomic transaction budget exceeded; staged migration or a smaller checkpoint is required");
      const prepared = [...changed].flatMap(key => next.get(key)?.chunks ?? []);
      try {
        await this.stage(prepared); this.assertOpen();
        const acknowledged = await this.db.runTransaction(async transaction => {
          await this.assertWriterTransaction(transaction);
          const doc = await transaction.get(this.db.doc(this.headPath)), actual = doc.exists ? this.head(doc.data()) : null;
          if (actual?.writerGeneration !== undefined && actual.writerGeneration !== null && (!this.#writer || this.#writer.generation! < actual.writerGeneration)) throw new FirestoreOwnershipFailure();
          const duplicate = actual?.transition.identity === transition.identity;
          if (duplicate) {
            if (!same(actual, head)) throw new Error("Firestore transition identity was reused with different input");
          } else if (!same(actual, base.head)) throw new Error("Firestore authoritative revision changed");
          const ids = [...writes.keys()], rows = ids.length ? await transaction.getAll(...ids.map(id => this.db.collection(this.collectionPath).doc(id))) : [];
          const acknowledgedDocuments = new Map<string, PrivateFirestoreDocument>();
          for (let at = 0; at < rows.length; at++) {
            const id = ids[at]!, wanted = (duplicate ? writes : expected).get(id)!, row = rows[at]!;
            let valid = wanted === null ? !row.exists : row.exists && sameDocument(row.data(), wanted);
            if (duplicate && wanted && row.exists) {
              valid = same(this.manifest(id, row.data()), this.manifest(id, wanted));
              acknowledgedDocuments.set(id, copyDocument(row.data() as PrivateFirestoreDocument));
            }
            if (!valid) throw new Error("Firestore touched record changed without its authenticated head");
          }
          const active = [...changed].flatMap(key => base.entries.get(key)?.chunks ?? []), referenced = new Map<string, PrivateFirestoreDocument>();
          for (const chunk of [...active, ...prepared]) referenced.set(chunk.id, chunk.document);
          const actualChunks = await this.readChunks(transaction, [...referenced.keys()]);
          for (const [id, wanted] of referenced) if (!sameDocument(actualChunks.get(id), wanted)) throw new Error("Firestore touched record changed without its authenticated head");
          this.assertOpen();
          this.#writer?.assertTransactionDeadline();
          // All reads precede writes. Staged bodies are never copied into this
          // commit request, and preparation is never presented as success.
          if (duplicate) return acknowledgedDocuments;
          for (const [id, document] of writes) {
            const ref = this.db.collection(this.collectionPath).doc(id);
            if (document) transaction.set(ref, document); else transaction.delete(ref);
          }
          transaction.set(this.db.doc(this.headPath), headDocument); return null;
        }, { maxAttempts: 5 });
        if (acknowledged) for (const key of changed) {
          const entry = next.get(key); if (entry) next.set(key, { ...entry, manifest: acknowledged.get(this.#codec.manifestId(key))! });
        }
        this.assertOpen(); return this.snapshot({ head, index, entries: next });
      } catch (error) { this.#uncertain = true; throw error; }
    }));
  }
}
