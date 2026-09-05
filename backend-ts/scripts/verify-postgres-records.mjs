import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { Repository, initialState } from "../src/repository/store.js";
import { PostgresRecordPersistence } from "../src/storage/postgres-records.js";
import { PostgresPersistence } from "../src/storage/postgres.js";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import { recordKey } from "../src/storage/execution-record-layout.js";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { compileReadWorkflow, readCompilationReceipt } from "../src/workflows/compiled-read.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { ReadIterationCheckpoints, newReadIterationLedger } from "../src/runner/read-iteration-checkpoints.js";
import { issueReadWorkerLease, renewReadWorkerLease, assertReadWorkerLease } from "../src/runner/read-worker-lease.js";
import jwt from "jsonwebtoken";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { capabilityContractHash, admissionAuthorizer, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { exactBridgeName, bridgeTransportSchema } from "../src/tools/erpbridge-contract.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";

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
  let repo = await Repository.open(persistence); assert.deepEqual(await repo.snapshot(), legacy);
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
    state.readContinuations.run = { profile: 'read-continuation/v1', executionId: 'run', ciphertext: codec.encode(Buffer.from(`private cursor fixture ${index}`)).toString('base64') };
  });
  const checkpointOnlyMs = performance.now() - start;
  assert.deepEqual((await pool.query("SELECT payload FROM runtime_records WHERE record_key=$1", [recordKey(['root'])])).rows[0].payload, rootBefore, 'unrelated root ciphertext must not be rewritten by checkpoints');
  // Actual SQL round trips for the real private incremental journal, not just
  // synthetic record writes. Only local fixture responses; no SDK or ERP calls.
  const role = 'Platform Admin', bindingKey = 'isolated-iteration-fixture-server-key-32-bytes';
  const tool = toolSchema.parse({ tool_id: 'READ', name: 'read', mcp_tool_name: 'read', is_read_only: true, allowed_roles: [role], input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } });
  const array = { type: 'array', items: { type: 'string' } }, ref = (nodeId, path) => ({ kind: 'ref', source: 'nodeOutput', nodeId, path });
  const yaml = stringify({ name: 'Actual SQL journal', description: 'Isolated fixture', trigger: { type: 'manual' }, steps: [{ id: 'read', action: 'read', parameters: { id: '{{each.item}}' } }], metadata: { controlFlow: { schemaVersion: 'read-control-flow/v3', root: { kind: 'sequence', nodes: [
    { kind: 'foreach', id: 'each', items: { schema: array, value: { kind: 'ref', source: 'workflowInput', path: ['rows'] } }, maxItems: 3, body: { kind: 'sequence', nodes: [{ kind: 'action', nodeId: 'read' }] }, collect: { schema: { type: 'string' }, value: ref('read', ['structuredContent', 'id']) } },
    { kind: 'return', id: 'answer', output: { schema: array, value: ref('each', ['value']) } },
  ] } } } });
  const input = { rows: ['a', 'b', 'c'], private_token: 'private-real-pg-journal-fixture' }, plan = compileReadWorkflow(yaml, [tool], role), now = new Date().toISOString();
  await repo.mutate(state => {
    state.users['test-actor'] = { id: 'test-actor', name: 'Test actor', email: 'fixture@example.test', roleId: 'role_admin', permissionOverrides: [], status: 'Active', initials: 'T', departmentId: null, lastLoginAt: null, createdAt: now };
    state.workflows.flow = { id: 'flow', name: 'Fixture', owner: { id: 'test-actor', name: 'Test actor' }, assignedUserIds: ['test-actor'], archived: false };
    state.executions.collection = { ...run, id: 'collection', readProgress: newReadProgress(repo), stepOutputs: {}, workflowSnapshot: { version: 1, contentHash: plan.sourceHash, registryHash: 'fixture-registry', yaml, input: {}, executionProfile: 'collection-read-v1', compilation: readCompilationReceipt(plan, 'fixture-registry', 'PUBLICATION', 'fixture-legacy') }, iterationProgress: newReadIterationLedger('collection', plan, input, role, bindingKey) };
  });
  const journal = () => new ReadIterationCheckpoints(repo, 'collection', 1, yaml, plan, input, [tool], bindingKey);
  const fixtureInvocations = []; let journalAcknowledgementLost = false, reopenedMidFlow = false;
  for (let boundary = 0; boundary < 30; boundary++) {
    const point = await journal().advance(); if (!point) break;
    if (point.kind !== 'action') continue;
    await journal().dispatchIntent(point.visit, role); fixtureInvocations.push(point.visit.invocationId);
    const result = { content: [], structuredContent: { id: point.arguments.id.toUpperCase() } };
    if (!journalAcknowledgementLost) {
      const originalQuery = persistence.client.query.bind(persistence.client); let loseOnce = true;
      persistence.client.query = async (...args) => { const value = await originalQuery(...args); if (args[0] === 'COMMIT' && loseOnce) { loseOnce = false; throw new Error('Isolated journal acknowledgement lost'); } return value; };
      await assert.rejects(journal().completed(point.visit, result), /could not be committed/); await assert.rejects(journal().advance(), /could not be committed/);
      await repo.recoverPersistenceState(); journalAcknowledgementLost = true;
      const receipt = (await repo.snapshot()).executions.collection.iterationProgress.receipts['action:each/0/read']; assert.equal(receipt.status, 'DONE');
    } else await journal().completed(point.visit, result);
    assert((await repo.snapshot()).readContinuations.collection, 'private cursor must accompany the committed result');
    assert(!JSON.stringify(await repo.snapshot()).includes(input.private_token), 'private inputs must not enter plaintext aggregate state');
    if (!reopenedMidFlow) { await persistence.close(); persistence = await PostgresRecordPersistence.open(databaseURL, key); repo = await Repository.open(persistence); reopenedMidFlow = true; }
  }
  const completed = await journal().finish(); assert.equal(completed.status, 'DONE'); assert.deepEqual(completed.finalOutput, ['A', 'B', 'C']);
  assert.deepEqual(fixtureInvocations, ['each/0/read', 'each/1/read', 'each/2/read']); assert.equal((await repo.snapshot()).readContinuations.collection, undefined);
  assert.equal((await pool.query("SELECT record_key FROM runtime_records WHERE record_key=$1", [recordKey(['readContinuations', 'collection'])])).rows.length, 0);
  // Actual normalized-record lease transactions and uncertain renewal ACK.
  // This proves private ownership persistence, not a live/SDK worker or replay.
  const leaseKey = 'isolated-server-held-worker-lease-fixture-key-32-bytes', leaseDuration = 30_000, owner = 'isolated-worker';
  await repo.mutate(state => {
    state.executions['lease-run'] = { ...run, id: 'lease-run', readProgress: newReadProgress(repo), workflowSnapshot: structuredClone(state.executions.collection.workflowSnapshot) };
    state.readJobs['lease-run'] = { version: 1, executionId: 'lease-run', actorId: 'test-actor', admittedRole: role, state: 'CLAIMED', workerId: owner,
      inputCiphertext: codec.encode(Buffer.from('private lease input fixture')).toString('base64'), requestFingerprint: 'fixture-request', idempotencyScope: 'fixture-scope',
      connectionFingerprint: 'fixture-connection', createdAt: now, claimedAt: now, queueSequence: ++state.counter };
  });
  const expectedLease = await repo.mutateExecution('lease-run', state => {
    const job = state.readJobs['lease-run']; return job.lease = issueReadWorkerLease(leaseKey, job, state.executions['lease-run'], owner, Date.now(), leaseDuration);
  });
  await repo.mutateExecution('lease-run', state => {
    const job = state.readJobs['lease-run']; job.lease = renewReadWorkerLease(leaseKey, job, state.executions['lease-run'], expectedLease, Date.now(), leaseDuration);
  });
  const beforeRenewal = (await repo.snapshot()).readJobs['lease-run'].lease;
  const leaseQuery = persistence.client.query.bind(persistence.client); let loseRenewalAcknowledgement = true, observedUnavailable = false;
  const unobserve = repo.observeCommits({ committed: () => {}, unavailable: () => { observedUnavailable = true; } });
  persistence.client.query = async (...args) => { const value = await leaseQuery(...args); if (args[0] === 'COMMIT' && loseRenewalAcknowledgement) { loseRenewalAcknowledgement = false; throw new Error('Isolated lease renewal acknowledgement lost'); } return value; };
  await assert.rejects(repo.mutateExecution('lease-run', state => {
    const job = state.readJobs['lease-run']; job.lease = renewReadWorkerLease(leaseKey, job, state.executions['lease-run'], expectedLease, Date.now(), leaseDuration);
  }), /renewal acknowledgement lost/);
  assert(observedUnavailable); await assert.rejects(repo.readAuthoritative(() => true), /unavailable/);
  assert.deepEqual((await repo.snapshot()).readJobs['lease-run'].lease, beforeRenewal, 'unacknowledged lease must not become local ownership');
  await repo.recoverPersistenceState(); unobserve();
  const reloadedLease = await repo.readAuthoritative(state => assertReadWorkerLease(leaseKey, state.readJobs['lease-run'], state.executions['lease-run'], expectedLease, Date.now(), leaseDuration));
  assert.equal(reloadedLease.leaseId, expectedLease.leaseId); assert.equal(reloadedLease.epoch, expectedLease.epoch);
  await repo.mutateExecution('lease-run', state => {
    const item = state.executions['lease-run'], job = state.readJobs['lease-run']; item.status = 'DONE'; item.readProgress.epoch++;
    job.state = 'FINISHED'; delete job.inputCiphertext; delete job.lease;
  });
  await assert.rejects(repo.readAuthoritative(state => assertReadWorkerLease(leaseKey, state.readJobs['lease-run'], state.executions['lease-run'], expectedLease, Date.now(), leaseDuration)), /ownership/);
  assert.equal((await repo.snapshot()).readJobs['lease-run'].lease, undefined);
  const query = persistence.client.query.bind(persistence.client); let loseAcknowledgement = true;
  persistence.client.query = async (...args) => { const value = await query(...args); if (args[0] === 'COMMIT' && loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Isolated lost acknowledgement fixture'); } return value; };
  await assert.rejects(repo.mutateExecution('run', state => { state.executions.run.status = 'DONE'; delete state.readContinuations.run; }), /lost acknowledgement/);
  assert.equal((await repo.snapshot()).executions.run.status, 'RUNNING'); await assert.rejects(repo.readAuthoritative(() => true), /unavailable/);
  await repo.recoverPersistenceState(); assert.equal((await repo.snapshot()).executions.run.status, 'DONE');
  assert.equal((await repo.snapshot()).readContinuations.run, undefined, 'terminal cursor deletion must be atomic despite lost acknowledgement');
  const snapshot = await repo.snapshot(); await persistence.close(); persistence = undefined;
  await assert.rejects(PostgresPersistence.open(databaseURL, key), /normalized record storage is active/);
  persistence = await PostgresRecordPersistence.open(databaseURL, key); repo = await Repository.open(persistence); assert.deepEqual(await repo.snapshot(), snapshot);
  // Normal publication + sync/queued HTTP admission on actual normalized SQL.
  // The MCP SDK is an explicit in-process fixture; no network/ERP/provider.
  const modernTool = toolSchema.parse({ ...tool, risk_level: 'low', side_effects: [], bridge_contract: { profile: 'toolplane-v1', resource_version: '1.0.0', resource_digest: 'a'.repeat(64), remote_roles: ['platform_admin'] } });
  const registries = { snapshot: () => ({ tools: [modernTool], rules: [], versions: { tools: 'fixture-v1', rules: 'fixture-v1' } }), hash: () => capabilityContractHash(modernTool),
    findTool: name => [modernTool.name, modernTool.mcp_tool_name].includes(name) ? modernTool : undefined, enabledRules: () => [], findRule: () => undefined };
  const validator = new RegistryValidator(registries, repo), httpFixtureCalls = [];
  const session = await createErpbridgeMcpSession({ baseURL: 'https://isolated.fixture.example.test', token: 'fixture-only-not-a-real-token', timeoutMs: 10_000, validator,
    admissionAuthorizer: admissionAuthorizer(repo, registries), sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {},
      listTools: async () => [{ name: exactBridgeName(modernTool), inputSchema: bridgeTransportSchema(modernTool), _meta: { 'toolplane.resourceVersion': '1.0.0', 'toolplane.resourceDigest': 'a'.repeat(64), 'io.erpbridge/allowedRoles': ['platform_admin'] } }],
      callTool: async (name, args, meta) => { assert.equal(name, exactBridgeName(modernTool)); assert.equal(meta['toolplane.resourceDigest'], 'a'.repeat(64)); assert.equal(args.role, 'platform_admin'); httpFixtureCalls.push(args.id); return { content: [], structuredContent: { id: args.id.toUpperCase() } }; } } });
  const config = loadConfig({ APP_ENV: 'test', STORAGE_DRIVER: 'postgres-records', DATABASE_URL: databaseURL, STORAGE_ENCRYPTION_KEY: key, MCP_MODE: 'mock',
    MCP_TRANSPORT: 'erpbridge-mcp', ERPBRIDGE_BASE_URL: 'https://isolated.fixture.example.test', ERPBRIDGE_MCP_TOKEN: 'fixture-only-not-a-real-token',
    JWT_SECRET: 'isolated-http-fixture-secret-32-bytes', ERPBRIDGE_ROLE_MAP: JSON.stringify({ [role]: 'platform_admin' }) });
  assert.deepEqual(config.erpbridgeRoleMap, { [role]: 'platform_admin' }, 'guarded fixture must use the ERPBridge transport role map');
  const services = { config, repository: repo, registries, validator, executor: new Executor(new ToolRegistry(), validator), erpbridgeSession: session }, actor = await repo.effectiveUser('test-actor');
  const observations = (await observeCapabilities({ repository: repo, registries, session, user: actor })).observations;
  for (const observation of observations) await reviewCapability({ repository: repo, registries, session, user: actor, capabilityId: observation.capabilityId, body: {
    observationId: observation.id, contractHash: observation.contractHash, decisionKey: 'isolated-normal-collection-review', effectClass: 'read', riskClass: 'low', dataClass: 'internal', retryPolicy: 'never', note: 'Isolated fake SDK qualification only' } });
  await repo.mutate(state => { state.workflows['normal-collection'] = { id: 'normal-collection', name: 'Normal fixture', description: '', owner: { id: 'test-actor', name: 'Test actor' }, assignedUserIds: [], status: 'PENDING', trigger: { type: 'manual' }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml, archived: false }; state.versions['normal-collection'] = []; });
  const app = await buildApp(services), headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: 'test-actor', expiresIn: 3600 })}` };
  let normalCollectionId;
  try {
    const published = await app.inject({ method: 'POST', url: '/api/workflows/normal-collection/publish', headers, payload: {} }); assert.equal(published.statusCode, 200, published.body); assert.equal(published.json().data.compiledRead.schemaVersion, 'workflow-read-ir/v4');
    const sync = await app.inject({ method: 'POST', url: '/api/workflows/normal-collection/run', headers, payload: { input: { rows: ['sync-a', 'sync-b'] } } });
    assert.equal(sync.statusCode, 200, sync.body); assert.equal(sync.json().data.status, 'DONE'); assert.deepEqual(sync.json().data.finalOutput, ['SYNC-A', 'SYNC-B']);
    assert.deepEqual(httpFixtureCalls, ['sync-a', 'sync-b']); assert.equal((await repo.snapshot()).readContinuations[sync.json().data.id], undefined);
    const payload = { mode: 'async-read', idempotencyKey: 'isolated-http-collection-job-0001', input: { rows: ['a', 'b', 'c'], private_token: 'private-http-fixture-input' } };
    const admitted = await app.inject({ method: 'POST', url: '/api/workflows/normal-collection/run', headers, payload }); assert.equal(admitted.statusCode, 202, admitted.body); normalCollectionId = admitted.json().data.id;
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) { const current = await repo.snapshot(); if (current.readJobs[normalCollectionId].state === 'FINISHED') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const current = await repo.snapshot(), completedRun = current.executions[normalCollectionId]; assert.equal(completedRun.status, 'DONE', JSON.stringify(completedRun.failure)); assert.deepEqual(completedRun.finalOutput, ['A', 'B', 'C']);
    assert.deepEqual(httpFixtureCalls, ['sync-a', 'sync-b', 'a', 'b', 'c']); assert.equal(current.readContinuations[normalCollectionId], undefined); assert.equal(current.readJobs[normalCollectionId].lease, undefined); assert.equal(current.readJobs[normalCollectionId].inputCiphertext, undefined);
    assert(!JSON.stringify(completedRun).includes('private-http-fixture-input'));
    const duplicate = await app.inject({ method: 'POST', url: '/api/workflows/normal-collection/run', headers, payload }); assert.equal(duplicate.statusCode, 202); assert.equal(duplicate.json().data.id, normalCollectionId); assert.equal(httpFixtureCalls.length, 5);
  } finally { await app.close(); await session.close(); }
  const rows = await pool.query("SELECT record_key,payload FROM runtime_records");
  assert(rows.rows.every(row => !row.payload.toString('utf8').includes('unrelatedHistory')));
  const target = rows.rows.find(row => row.record_key === recordKey(['outputs', 'run', 'node-0']));
  const broken = Buffer.from(target.payload); broken[broken.length - 1] ^= 1;
  await pool.query("UPDATE runtime_records SET payload=$1 WHERE record_key=$2", [broken, target.record_key]);
  await assert.rejects(persistence.load(), /tampering/); await assert.rejects(persistence.probe(), /reloaded/);
  console.log(JSON.stringify({ profile: 'isolated-postgres-records-check/v1', passed: true, records: rows.rows.length, checkpointOnlyCount: 100,
    checkpointOnlyMs: Math.round(checkpointOnlyMs), noERPOrProviderCalls: true,
    privateJournal: { confirmedFixtureInvocations: fixtureInvocations.length, journalAcknowledgementLost, reopenedMidFlow, finalCursorRemoved: true },
    workerLease: { renewed: true, acknowledgementLost: true, unavailableObserverDelivered: observedUnavailable, reloadedExactLease: true, terminalLeaseRemoved: true, noDispatchOrReplay: true },
    normalCollection: { publicationProfile: 'workflow-read-ir/v4', admittedProfile: 'collection-read-v1', syncHTTP: true, queuedHTTP: true, confirmedFakeSDKCalls: httpFixtureCalls.length, idempotentAdmission: true, terminalPrivateStateRemoved: true },
    limitations: 'Timing covers synthetic checkpoints only. The journal uses supplied results; the normal HTTP queue uses an in-process fake SDK. No live ERP/provider/network calls. Not a process crash/power-loss test, concurrency/load qualification or production SLO.' }));
} finally { if (persistence) await persistence.close(); await pool.end(); }
