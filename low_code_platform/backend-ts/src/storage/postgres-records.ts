import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { AsyncMutex } from "../repository/async-mutex.js";
import { restoreState, type PersistenceBackend } from "../repository/store.js";
import type { ExecutionCheckpoint } from "../repository/execution-transaction.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { AESGCMCodec } from "./aes-gcm.js";
import { assembleRuntimeState, splitRuntimeState, checkpointRecords, executionRecordScope, recordKey, type RuntimeRecord } from "./execution-record-layout.js";
import { RuntimeRecordIndex } from "./runtime-record-index.js";

const writerLockID = 1_279_477_061; // Same lock as the legacy aggregate writer.
type Head = { profile: "runtime-record-head/v1"; revision: number; count: number; fingerprint: string; legacySourceHash?: string };
type Cached = { record: RuntimeRecord; json: string; hash: Buffer };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const cached = (record: RuntimeRecord): Cached => { const bytes = canonicalJSONBytes(record); return { record: JSON.parse(bytes.toString("utf8")), json: bytes.toString("utf8"), hash: hash(bytes) }; };

/** Opt-in normalized run records. A head CAS and all encrypted row changes
 * share one PostgreSQL transaction. No automatic legacy import, replay,
 * worker-pool claim or live execution admission is provided by this store. */
export class PostgresRecordPersistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  readonly #mutex = new AsyncMutex();
  #closed = false; #connectionLost = false; #loaded = false; #uncertain = false;
  #head: Head | null = null;
  #index = new RuntimeRecordIndex();
  #recordBytes = 0;
  readonly #records = new Map<string, Cached>();
  readonly #scopes = new Map<string, Set<string>>();
  private constructor(readonly pool: Pool, readonly client: PoolClient, readonly codec: AESGCMCodec) {
    client.on("error", () => { this.#connectionLost = true; this.#uncertain = true; });
  }
  static async open(databaseURL: string, encryptionKey: string): Promise<PostgresRecordPersistence> {
    const codec = new AESGCMCodec(encryptionKey);
    const pool = new Pool({ connectionString: databaseURL, max: 2, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [writerLockID]);
      if (locked.rows[0]?.locked !== true) throw new Error("Runtime writer is already owned");
      await client.query("SET statement_timeout = '10000ms'");
      await client.query("BEGIN");
      await client.query("CREATE TABLE IF NOT EXISTS runtime_record_head (state_key TEXT PRIMARY KEY, revision BIGINT NOT NULL, payload BYTEA NOT NULL)");
      await client.query("CREATE TABLE IF NOT EXISTS runtime_records (record_key TEXT PRIMARY KEY, payload BYTEA NOT NULL)");
      await client.query("COMMIT");
      return new PostgresRecordPersistence(pool, client, codec);
    } catch {
      if (client) { try { await client.query("ROLLBACK"); await client.query("SELECT pg_advisory_unlock($1)", [writerLockID]); } catch { /* failed connection */ } client.release(true); }
      await pool.end(); throw new Error("PostgreSQL record storage could not acquire a healthy exclusive writer or initialize its schema");
    }
  }
  private assertOpen() { if (this.#closed || this.#connectionLost) throw new Error("PostgreSQL record writer is unavailable"); }
  private assertLoaded() { this.assertOpen(); if (!this.#loaded || this.#uncertain) throw new Error("PostgreSQL records must be authoritatively reloaded before writing"); }
  private decodeHead(row: { revision: string | number; payload: Buffer }): Head {
    const value = JSON.parse(this.codec.decode(row.payload).toString("utf8")) as Head;
    if (value.profile !== "runtime-record-head/v1" || !Number.isSafeInteger(value.revision) || value.revision < 1 || Number(row.revision) !== value.revision ||
        !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 1_000_000 || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
        value.legacySourceHash !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.legacySourceHash)) throw new Error("Invalid encrypted record head");
    return value;
  }
  private async legacyPayload(): Promise<Buffer | null> {
    const table = await this.client.query<{ legacy: string | null }>("SELECT to_regclass('runtime_state') AS legacy");
    if (!table.rows[0]?.legacy) return null;
    const legacy = await this.client.query<{ payload: Buffer }>("SELECT payload FROM runtime_state WHERE state_key = $1", ["default"]);
    return legacy.rows[0]?.payload ?? null;
  }
  async load(): Promise<Uint8Array | null> {
    return this.#mutex.runExclusive(async () => {
      this.assertOpen();
      try {
        if (this.#uncertain) await this.client.query("ROLLBACK");
        await this.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const heads = await this.client.query<{ revision: string; payload: Buffer }>("SELECT revision,payload FROM runtime_record_head WHERE state_key = $1", ["default"]);
        const rows = await this.client.query<{ record_key: string; payload: Buffer }>("SELECT record_key,payload FROM runtime_records");
        let payload: Buffer | null = null, head: Head | null = null; const records = new Map<string, Cached>(); let index = new RuntimeRecordIndex();
        if (!heads.rows.length) {
          if (rows.rows.length) throw new Error("Normalized rows have no authoritative head");
          if (await this.legacyPayload()) throw new Error("Legacy aggregate exists; explicit backed-up migration is required");
        } else {
          head = this.decodeHead(heads.rows[0]!);
          if (rows.rows.length !== head.count) throw new Error("Normalized record count differs from its authenticated head");
          let bytes = 0;
          for (const row of rows.rows) {
            bytes += row.payload.byteLength; if (bytes > 256_000_000) throw new Error("Normalized startup image exceeds its bounded memory profile");
            const record = JSON.parse(this.codec.decode(row.payload).toString("utf8")) as RuntimeRecord;
            if (!Array.isArray(record.path) || row.record_key !== recordKey(record.path) || records.has(row.record_key)) throw new Error("Encrypted record address changed or duplicated");
            const value = cached(record); records.set(row.record_key, value); index = index.with(row.record_key, value.hash.toString("hex"));
          }
          if (index.fingerprint !== head.fingerprint) throw new Error("Normalized record content differs from its authenticated head");
          payload = Buffer.from(JSON.stringify(assembleRuntimeState([...records.values()].map(value => value.record))));
          restoreState(payload); // Same repository restoration checks before un-fencing this writer.
        }
        await this.client.query("COMMIT");
        this.#records.clear(); this.#scopes.clear(); this.#head = head; this.#index = index; this.#recordBytes = 0;
        for (const [key, value] of records) this.install(key, value);
        this.#loaded = true; this.#uncertain = false; return payload;
      } catch (error) { this.#uncertain = true; try { await this.client.query("ROLLBACK"); } catch { /* remain fenced */ } throw error; }
    });
  }
  private install(key: string, value: Cached) {
    this.#records.set(key, value); this.#recordBytes += Buffer.byteLength(value.json) + 41; const scope = executionRecordScope(value.record);
    if (scope !== null) { let keys = this.#scopes.get(scope); if (!keys) this.#scopes.set(scope, keys = new Set()); keys.add(key); }
  }
  private remove(key: string) {
    const value = this.#records.get(key); if (!value) return;
    const scope = executionRecordScope(value.record); if (scope !== null) { const keys = this.#scopes.get(scope); keys?.delete(key); if (!keys?.size) this.#scopes.delete(scope); }
    this.#records.delete(key); this.#recordBytes -= Buffer.byteLength(value.json) + 41;
  }
  async save(payload: Uint8Array): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertLoaded(); const records = splitRuntimeState(restoreState(payload));
      await this.commit(records, new Set(this.#records.keys()));
    });
  }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertLoaded();
      const audit = this.#records.get(recordKey(["auditLogs"]))?.record.value;
      if (audit !== checkpoint.auditStart) throw new Error("Scoped audit append does not match the committed history");
      await this.commit(checkpointRecords(checkpoint), new Set(this.#scopes.get(checkpoint.executionId) ?? []));
    });
  }
  private async commit(records: RuntimeRecord[], replaced: Set<string>, legacySourceHash?: string): Promise<void> {
    const changed = new Map<string, Cached>(), seen = new Set<string>(); let index = this.#index, bytes = this.#recordBytes;
    for (const record of records) {
      const key = recordKey(record.path), value = cached(record); if (seen.has(key)) throw new Error("Duplicate normalized write address"); seen.add(key);
      replaced.delete(key); const old = this.#records.get(key);
      if (old?.json === value.json) continue;
      bytes += Buffer.byteLength(value.json) + 41 - (old ? Buffer.byteLength(old.json) + 41 : 0);
      index = index.with(key, value.hash.toString("hex")); changed.set(key, value);
    }
    for (const key of replaced) { index = index.without(key); bytes -= Buffer.byteLength(this.#records.get(key)!.json) + 41; }
    if (!changed.size && !replaced.size) return;
    const revision = (this.#head?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision) || index.size < 1 || index.size > 1_000_000 || bytes > 256_000_000) throw new Error("Normalized storage bounds exceeded");
    const head: Head = { profile: "runtime-record-head/v1", revision, count: index.size, fingerprint: index.fingerprint,
      ...(legacySourceHash ?? this.#head?.legacySourceHash ? { legacySourceHash: legacySourceHash ?? this.#head!.legacySourceHash! } : {}) };
    try {
      await this.client.query("BEGIN");
      const current = await this.client.query<{ revision: string; payload: Buffer }>("SELECT revision,payload FROM runtime_record_head WHERE state_key = $1 FOR UPDATE", ["default"]);
      const actual = current.rows[0] ? this.decodeHead(current.rows[0]) : null;
      if (!canonicalJSONBytes(actual).equals(canonicalJSONBytes(this.#head))) throw new Error("Normalized writer revision changed");
      if (replaced.size) await this.client.query("DELETE FROM runtime_records WHERE record_key = ANY($1::text[])", [[...replaced]]);
      if (changed.size) await this.client.query("INSERT INTO runtime_records(record_key,payload) SELECT record_key,payload FROM unnest($1::text[],$2::bytea[]) AS changes(record_key,payload) ON CONFLICT(record_key) DO UPDATE SET payload=EXCLUDED.payload",
        [[...changed.keys()], [...changed.values()].map(value => this.codec.encode(Buffer.from(value.json)))]);
      const encrypted = this.codec.encode(canonicalJSONBytes(head));
      if (this.#head) {
        const updated = await this.client.query("UPDATE runtime_record_head SET revision=$1,payload=$2 WHERE state_key=$3 AND revision=$4", [revision, encrypted, "default", this.#head.revision]);
        if (updated.rowCount !== 1) throw new Error("Normalized writer compare-and-set failed");
      } else await this.client.query("INSERT INTO runtime_record_head(state_key,revision,payload) VALUES($1,$2,$3)", ["default", revision, encrypted]);
      await this.client.query("COMMIT");
      for (const key of replaced) this.remove(key); for (const [key, value] of changed) { this.remove(key); this.install(key, value); } this.#head = head; this.#index = index;
    } catch (error) { this.#uncertain = true; try { await this.client.query("ROLLBACK"); } catch { /* commit acknowledgement may already be lost */ } throw error; }
  }
  /** Explicit migration only. The caller must first retain an external backup
   * and supply its plaintext SHA-256. The old encrypted default blob is kept.
   * No credentials, ERP calls or implicit restart migration are involved. */
  async migrateLegacy(expectedSourceHash: string): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertOpen();
      if (!/^sha256:[a-f0-9]{64}$/.test(expectedSourceHash)) throw new Error("An explicit legacy backup hash is required");
      const heads = await this.client.query("SELECT revision,payload FROM runtime_record_head WHERE state_key = $1", ["default"]);
      const rows = await this.client.query("SELECT record_key,payload FROM runtime_records");
      if (heads.rows.length || rows.rows.length) throw new Error("Record migration requires an empty target; existing records are not overwritten");
      const encrypted = await this.legacyPayload(); if (!encrypted) throw new Error("Legacy source is unavailable");
      const payload = this.codec.decode(encrypted); if (`sha256:${hash(payload).toString("hex")}` !== expectedSourceHash) throw new Error("Legacy source no longer matches its external backup hash");
      const records = splitRuntimeState(restoreState(payload)); assembleRuntimeState(records);
      this.#head = null; this.#records.clear(); this.#scopes.clear(); this.#index = new RuntimeRecordIndex(); this.#recordBytes = 0; this.#uncertain = false;
      await this.commit(records, new Set(), expectedSourceHash); this.#loaded = true;
    });
  }
  async probe(): Promise<void> { await this.#mutex.runExclusive(async () => { this.assertLoaded(); await this.client.query("SELECT 1"); }); }
  async close(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      if (this.#closed) return; this.#closed = true;
      try { if (!this.#connectionLost) await this.client.query("SELECT pg_advisory_unlock($1)", [writerLockID]); }
      finally { this.client.release(this.#connectionLost); await this.pool.end(); }
    });
  }
}
