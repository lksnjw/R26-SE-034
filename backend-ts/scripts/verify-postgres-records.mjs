import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { Repository, initialState } from "../src/repository/store.js";
import { PostgresRecordPersistence } from "../src/storage/postgres-records.js";
import { PostgresPersistence } from "../src/storage/postgres.js";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import { recordKey } from "../src/storage/execution-record-layout.js";

// Never run this against application data. The caller owns an isolated,
// initially empty local test database created specifically for this script.
const databaseURL = process.env.LCWE_RECORD_TEST_DATABASE_URL;
if (!databaseURL) throw new Error("LCWE_RECORD_TEST_DATABASE_URL must name an isolated local test database");
const url = new URL(databaseURL);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.username !== 'lcwe_test' || url.password || url.search || url.hash ||
    !url.port || url.port === '5432' || !/^\/lcwe_records_test_[a-f0-9]{8}$/.test(url.pathname)) throw new Error("Refusing a nonisolated PostgreSQL test target");
const pool = new Pool({ connectionString: databaseURL, max: 1, query_timeout: 10_000, connectionTimeoutMillis: 10_000 });
const key = "x".repeat(32), codec = new AESGCMCodec(key);
let persistence;
try {
  const tables = await pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'");
  assert.equal(tables.rows.length, 0, "test database must initially be empty");
  const legacy = initialState(), run = { id: "run", workflowId: "flow", workflowName: "Isolated fixture", status: "RUNNING", startedAt: new Date().toISOString(), completedAt: null,
    durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "test-actor", name: "Test actor" },
    readProgress: { profile: "read-progress-v1", epoch: 1, nextStepIndex: 0, lastSequence: 0, persistence: "durable", attempts: {} }, stepOutputs: {} };
  legacy.executions.run = run; legacy.timelines.run = []; legacy.executionEvents.run = [];
  const plaintext = Buffer.from(JSON.stringify(legacy)), backupHash = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`, encryptedBackup = codec.encode(plaintext);
  await pool.query("CREATE TABLE runtime_state(state_key TEXT PRIMARY KEY,payload BYTEA NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("INSERT INTO runtime_state(state_key,payload) VALUES($1,$2)", ['default', encryptedBackup]);
  persistence = await PostgresRecordPersistence.open(databaseURL, key);
  await assert.rejects(Repository.open(persistence), /explicit backed-up migration/);
  await assert.rejects(persistence.migrateLegacy(`sha256:${'0'.repeat(64)}`), /backup hash/);
  await persistence.migrateLegacy(backupHash);
  const repo = await Repository.open(persistence); assert.deepEqual(await repo.snapshot(), legacy);
  assert.deepEqual((await pool.query("SELECT payload FROM runtime_state WHERE state_key=$1", ['default'])).rows[0].payload, encryptedBackup);
  await assert.rejects(PostgresRecordPersistence.open(databaseURL, key), /exclusive writer/);
  await assert.rejects(PostgresPersistence.open(databaseURL, key), /another backend writer/);
  await repo.mutate(state => { state.settings.unrelatedHistory = "x".repeat(2_000_000); });
  const rootBefore = (await pool.query("SELECT payload FROM runtime_records WHERE record_key=$1", [recordKey(['root'])])).rows[0].payload;
  const start = performance.now();
  for (let index = 0; index < 100; index++) await repo.mutateExecution('run', state => {
    const id = `node-${index}`; state.executions.run.readProgress.attempts[id] = { id: `attempt-${index}`, nodeId: id, stepIndex: index, status: 'DONE', startedAt: 'fixture' };
    state.executions.run.stepOutputs[id] = { content: [], structuredContent: { value: index % 3 === 0 ? false : index % 3 === 1 ? 0 : null } };
    state.timelines.run.push({ id, status: 'DONE', output: state.executions.run.stepOutputs[id] }); state.auditLogs.push({ id: `audit-${index}` });
  });
  const checkpointOnlyMs = performance.now() - start;
  assert.deepEqual((await pool.query("SELECT payload FROM runtime_records WHERE record_key=$1", [recordKey(['root'])])).rows[0].payload, rootBefore, 'unrelated root ciphertext must not be rewritten by checkpoints');
  const query = persistence.client.query.bind(persistence.client); let loseAcknowledgement = true;
  persistence.client.query = async (...args) => { const value = await query(...args); if (args[0] === 'COMMIT' && loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Isolated lost acknowledgement fixture'); } return value; };
  await assert.rejects(repo.mutateExecution('run', state => { state.executions.run.status = 'DONE'; }), /lost acknowledgement/);
  assert.equal((await repo.snapshot()).executions.run.status, 'RUNNING'); await assert.rejects(repo.readAuthoritative(() => true), /unavailable/);
  await repo.recoverPersistenceState(); assert.equal((await repo.snapshot()).executions.run.status, 'DONE');
  const snapshot = await repo.snapshot(); await persistence.close(); persistence = undefined;
  await assert.rejects(PostgresPersistence.open(databaseURL, key), /normalized record storage is active/);
  persistence = await PostgresRecordPersistence.open(databaseURL, key); const reopened = await Repository.open(persistence); assert.deepEqual(await reopened.snapshot(), snapshot);
  const rows = await pool.query("SELECT record_key,payload FROM runtime_records");
  assert(rows.rows.every(row => !row.payload.toString('utf8').includes('unrelatedHistory')));
  const target = rows.rows.find(row => row.record_key === recordKey(['outputs', 'run', 'node-0']));
  const broken = Buffer.from(target.payload); broken[broken.length - 1] ^= 1;
  await pool.query("UPDATE runtime_records SET payload=$1 WHERE record_key=$2", [broken, target.record_key]);
  await assert.rejects(persistence.load(), /tampering/); await assert.rejects(persistence.probe(), /reloaded/);
  console.log(JSON.stringify({ profile: 'isolated-postgres-records-check/v1', passed: true, records: rows.rows.length, checkpointOnlyCount: 100,
    checkpointOnlyMs: Math.round(checkpointOnlyMs), noERPOrProviderCalls: true,
    limitations: 'Checkpoint-only synthetic timing; not an end-to-end workflow, crash/power-loss test, concurrency/load qualification or production SLO.' }));
} finally { if (persistence) await persistence.close(); await pool.end(); }
