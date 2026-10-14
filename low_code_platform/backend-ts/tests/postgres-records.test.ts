import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
import { Repository, initialState, type Execution } from "../src/repository/store.js";
import { PostgresRecordPersistence } from "../src/storage/postgres-records.js";
import { PostgresPersistence } from "../src/storage/postgres.js";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import { recordKey } from "../src/storage/execution-record-layout.js";
import { loadConfig } from "../src/config/config.js";

const runtime = vi.hoisted(() => ({ database: null as any }));
vi.mock("pg", () => ({ Pool: class { readonly client: FakeClient; constructor() { this.client = new FakeClient(runtime.database); runtime.database.clients.push(this.client); } async connect() { return this.client; } async end() { this.client.db.poolEnds++; } } }));
type Image = { head: { revision: number; payload: Buffer } | null; records: Map<string, Buffer> };
class Database {
  image: Image = { head: null, records: new Map() }; legacy: Buffer | null = null; owner: FakeClient | null = null; poolEnds = 0; clients: FakeClient[] = [];
  fail: "rows" | "commit-before" | "commit-after" | "cas" | null = null;
  queries: Array<{ sql: string; values: any[] }> = [];
}
class FakeClient extends EventEmitter {
  pending: Image | null = null; constructor(readonly db: Database) { super(); }
  release(destroy = false) { if (destroy && this.db.owner === this) this.db.owner = null; }
  async query(sql: string, values: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    this.db.queries.push({ sql, values }); const empty = { rows: [], rowCount: 0 };
    if (sql.includes("pg_try_advisory_lock")) { const locked = !this.db.owner || this.db.owner === this; if (locked) this.db.owner = this; return { rows: [{ locked }], rowCount: 1 }; }
    if (sql.includes("pg_advisory_unlock")) { if (this.db.owner === this) this.db.owner = null; return empty; }
    if (sql.startsWith("BEGIN")) { if (this.pending) throw new Error("already in transaction"); this.pending = { head: this.db.image.head && { ...this.db.image.head }, records: new Map(this.db.image.records) }; return empty; }
    if (sql === "ROLLBACK") { this.pending = null; return empty; }
    if (sql === "COMMIT") {
      if (this.db.fail === "commit-before") { this.db.fail = null; throw new Error("commit unavailable"); }
      if (this.pending) this.db.image = this.pending; this.pending = null;
      if (this.db.fail === "commit-after") { this.db.fail = null; throw new Error("commit acknowledgement lost"); } return empty;
    }
    const image = this.pending ?? this.db.image;
    if (sql.startsWith("SELECT to_regclass")) return { rows: [sql.includes("runtime_state") ? { legacy: this.db.legacy ? "runtime_state" : null } : { records: "runtime_record_head" }], rowCount: 1 };
    if (sql.startsWith("SELECT payload FROM runtime_state")) return { rows: this.db.legacy ? [{ payload: this.db.legacy }] : [], rowCount: this.db.legacy ? 1 : 0 };
    if (sql.startsWith("SELECT revision,payload FROM runtime_record_head")) return { rows: image.head ? [{ revision: String(image.head.revision), payload: image.head.payload }] : [], rowCount: image.head ? 1 : 0 };
    if (sql.startsWith("SELECT state_key FROM runtime_record_head")) return { rows: image.head ? [{ state_key: "default" }] : [], rowCount: image.head ? 1 : 0 };
    if (sql.startsWith("SELECT record_key,payload FROM runtime_records")) return { rows: [...image.records].map(([record_key, payload]) => ({ record_key, payload })), rowCount: image.records.size };
    if (sql.startsWith("INSERT INTO runtime_records")) { if (this.db.fail === "rows") { this.db.fail = null; throw new Error("row write lost"); } values[0].forEach((key: string, index: number) => image.records.set(key, values[1][index])); return empty; }
    if (sql.startsWith("DELETE FROM runtime_records")) { values[0].forEach((key: string) => image.records.delete(key)); return empty; }
    if (sql.startsWith("INSERT INTO runtime_record_head")) { if (image.head) throw new Error("head already exists"); image.head = { revision: values[1], payload: values[2] }; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("UPDATE runtime_record_head")) { if (this.db.fail === "cas") { this.db.fail = null; return empty; } if (image.head?.revision !== values[3]) return empty; image.head = { revision: values[0], payload: values[1] }; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("SET ") || sql === "SELECT 1" || sql.includes("pg_advisory_xact_lock")) return empty;
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  }
}
const key = "x".repeat(32), codec = new AESGCMCodec(key);
const run = (id: string): Execution => ({ id, workflowId: "flow", workflowName: "Example", status: "RUNNING", startedAt: "2026-10-05T00:00:00Z", completedAt: null, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: "actor", name: "Actor" },
  readProgress: { profile: "read-progress-v1", epoch: 1, nextStepIndex: 0, lastSequence: 0, persistence: "durable", attempts: {} }, stepOutputs: {} });
let db: Database;
beforeEach(() => { db = new Database(); runtime.database = db; });
async function setup() { const persistence = await PostgresRecordPersistence.open("postgres://offline-fixture", key), repo = await Repository.open(persistence);
  await repo.mutate(state => { state.executions.run = run("run"); state.executions.other = run("other"); state.timelines.run = []; state.executionEvents.run = []; state.settings.private = { token: "offline-sensitive-fixture" }; state.auditLogs.push({ id: "old" }); });
  return { persistence, repo }; }

test("record storage is opt-in and requires the existing PostgreSQL encryption/connection prerequisites", () => {
  expect(loadConfig({}).storageDriver).toBe("memory");
  expect(() => loadConfig({ STORAGE_DRIVER: "postgres-records" })).toThrow("DATABASE_URL");
  expect(() => loadConfig({ STORAGE_DRIVER: "postgres-records", DATABASE_URL: "postgres://offline" })).toThrow("STORAGE_ENCRYPTION_KEY");
  expect(loadConfig({ STORAGE_DRIVER: "postgres-records", DATABASE_URL: "postgres://offline", STORAGE_ENCRYPTION_KEY: key }).storageDriver).toBe("postgres-records");
});
test("encrypted run rows atomically commit through real repository scoped checkpoints and survive authoritative reload", async () => {
  const { persistence, repo } = await setup(), original = await repo.snapshot(); db.queries = [];
  await repo.mutateExecution("run", state => { state.executions.run!.readProgress!.attempts.node = { id: "attempt", nodeId: "node", stepIndex: 0, status: "DONE", startedAt: "now" };
    state.executions.run!.stepOutputs!.node = { content: [], structuredContent: { value: false } }; state.timelines.run!.push({ id: "attempt", output: { value: false } }); state.auditLogs.push({ id: "new" }); });
  const writes = db.queries.filter(query => query.sql.startsWith("INSERT INTO runtime_records")).flatMap(query => query.values[0]);
  expect(writes).toContain(recordKey(["attempts", "run", "node"])); expect(writes).toContain(recordKey(["outputs", "run", "node"])); expect(writes).not.toContain(recordKey(["root"]));
  expect(writes.some((value: string) => value.includes('"other"'))).toBe(false); expect(writes).not.toContain(recordKey(["audit-entry", "0"]));
  expect(db.queries.findIndex(query => query.sql.includes("FOR UPDATE"))).toBeLessThan(db.queries.findIndex(query => query.sql.startsWith("INSERT INTO runtime_records")));
  expect(db.queries.at(-1)!.sql).toBe("COMMIT");
  const snapshot = await repo.snapshot(), restored = await Repository.open(persistence); expect(await restored.snapshot()).toEqual(snapshot); expect(snapshot.executions.other).toEqual(original.executions.other);
  for (const payload of db.image.records.values()) expect(payload.toString("utf8")).not.toContain("offline-sensitive-fixture");
  const values = [...db.image.records.values()].map(payload => JSON.parse(codec.decode(payload).toString("utf8"))); expect(values.find(value => value.path[0] === "root").value.settings.private.token).toBe("offline-sensitive-fixture");
});
test.each(["rows", "commit-before", "commit-after", "cas"] as const)("%s fault never overwrites uncertain durable state and authoritative recovery chooses the actual committed image", async fault => {
  const { persistence, repo } = await setup(), revision = db.image.head!.revision; db.fail = fault;
  await expect(repo.mutateExecution("run", state => { state.executions.run!.status = "DONE"; })).rejects.toThrow();
  expect((await repo.snapshot()).executions.run!.status).toBe("RUNNING");
  await expect(repo.readAuthoritative(() => true)).rejects.toThrow(); await expect(persistence.save(Buffer.from(JSON.stringify(await repo.snapshot())))).rejects.toThrow("reloaded");
  await repo.recoverPersistenceState(); const committed = fault === "commit-after"; expect((await repo.snapshot()).executions.run!.status).toBe(committed ? "DONE" : "RUNNING"); expect(db.image.head!.revision).toBe(revision + (committed ? 1 : 0));
  await repo.mutateExecution("run", state => { state.executions.run!.status = "CANCELLED"; }); expect((await repo.snapshot()).executions.run!.status).toBe("CANCELLED");
});
test.each(["missing", "swapped", "corrupted", "head-revision", "replayed"])("%s normalized evidence fails authentication/layout recovery", async fault => {
  const { persistence, repo } = await setup(), rows = [...db.image.records];
  if (fault === "missing") db.image.records.delete(rows[0]![0]);
  if (fault === "swapped") db.image.records.set(rows[0]![0], rows[1]![1]);
  if (fault === "corrupted") { const bytes = Buffer.from(rows[0]![1]); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; db.image.records.set(rows[0]![0], bytes); }
  if (fault === "head-revision") db.image.head!.revision++;
  if (fault === "replayed") { const old = db.image.records.get(recordKey(["executions", "run"]))!; await repo.mutateExecution("run", state => { state.executions.run!.status = "DONE"; }); db.image.records.set(recordKey(["executions", "run"]), old); }
  await expect(persistence.load()).rejects.toThrow(); await expect(persistence.probe()).rejects.toThrow();
});
test("stale encrypted head CAS fences writes before changing any records", async () => {
  const { repo } = await setup(), before = new Map(db.image.records), witness = JSON.parse(codec.decode(db.image.head!.payload).toString("utf8"));
  witness.revision++; db.image.head = { revision: witness.revision, payload: codec.encode(Buffer.from(JSON.stringify(witness))) };
  await expect(repo.mutateExecution("run", state => { state.executions.run!.status = "DONE"; })).rejects.toThrow("revision changed"); expect(db.image.records).toEqual(before);
});
test("startup never auto-migrates an existing aggregate; explicit exact-hash migration keeps the source and rejects legacy fallback", async () => {
  const original = initialState(); original.executions.run = run("run"); const plaintext = Buffer.from(JSON.stringify(original)); db.legacy = codec.encode(plaintext); const legacy = Buffer.from(db.legacy);
  const persistence = await PostgresRecordPersistence.open("postgres://offline", key);
  await expect(Repository.open(persistence)).rejects.toThrow("explicit backed-up migration"); expect(db.image.records.size).toBe(0);
  await expect(persistence.migrateLegacy(`sha256:${"0".repeat(64)}`)).rejects.toThrow("backup hash"); expect(db.image.records.size).toBe(0);
  await persistence.migrateLegacy(`sha256:${createHash("sha256").update(plaintext).digest("hex")}`);
  expect(await Repository.open(persistence).then(value => value.snapshot())).toEqual(original); expect(db.legacy).toEqual(legacy);
  await expect(persistence.migrateLegacy(`sha256:${"0".repeat(64)}`)).rejects.toThrow("empty target");
  await persistence.close(); await expect(PostgresPersistence.open("postgres://offline", key)).rejects.toThrow("normalized record storage is active");
});
test("a second writer, lost connection and closed writer cannot continue committing", async () => {
  const { persistence, repo } = await setup(); await expect(PostgresRecordPersistence.open("postgres://offline", key)).rejects.toThrow("exclusive writer");
  await expect(PostgresPersistence.open("postgres://offline", key)).rejects.toThrow("another backend writer");
  db.clients[0]!.emit("error", new Error("connection terminated"));
  await expect(repo.mutateExecution("run", state => { state.executions.run!.status = "DONE"; })).rejects.toThrow("unavailable");
  await expect(repo.recoverPersistenceState()).rejects.toThrow("unavailable"); await persistence.close(); await expect(persistence.load()).rejects.toThrow("unavailable");
});
test("many unrelated saved answers and chats never enter the selected run's SQL write batch", async () => {
  const { repo } = await setup(); await repo.mutate(state => {
    state.settings.largeUnrelated = "x".repeat(2_000_000);
    for (let index = 0; index < 100; index++) { const id = `other-${index}`; state.executions[id] = run(id); state.executions[id]!.stepOutputs!.node = { value: "x".repeat(1000) }; }
  }); db.queries = [];
  await repo.mutateExecution("run", state => { state.executions.run!.status = "DONE"; });
  const writes = db.queries.filter(query => query.sql.startsWith("INSERT INTO runtime_records")); expect(writes).toHaveLength(1); expect(writes[0]!.values[0]).toEqual([recordKey(["executions", "run"])]);
  expect(writes[0]!.values[1][0].byteLength).toBeLessThan(1000);
});
