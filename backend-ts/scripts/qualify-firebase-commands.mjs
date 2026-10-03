import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { openFirestoreProgressReader } from "../src/storage/firestore-progress-reader.js";

const slowNetwork = process.argv[2] === "--slow-network";
const leanCreation = process.argv[2] === "--lean-creation";
assert(process.argv.length === 2 || (process.argv.length === 3 && (slowNetwork || leanCreation)), "Choose the explicit slow-network/lean-creation mode or the unchanged baseline");
const reportSuffix = slowNetwork ? "-slow-network" : leanCreation ? "-lean-creation" : "";
const writerAdmissionTimeoutMs = slowNetwork ? 30_000 : 5000, httpTimeoutMs = slowNetwork ? 90_000 : 20_000;

// Separate from read acceptance: six actual writable native HTTP invocations,
// each sent once with a unique original identity. No HTTP retry, business task,
// model, ERP action, owner namespace or live credential is permitted here.
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
const session = JSON.parse(await readFile(".functions/qa-session.json", "utf8")), config = session.config;
assert.equal(session.profile, "lcwe-native-functions-qa/v1"); assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records");
assert(/^test_[a-f0-9]{32}_native$/.test(config.FIRESTORE_WORKSPACE_ID));
assert.equal(config.APP_ENV, "test"); assert.equal(config.MCP_MODE, "mock"); assert.equal(config.MCP_TRANSPORT, "bridge-v1");
assert.equal(Number(config.FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS ?? 30_000), writerAdmissionTimeoutMs, "Preparation must match the measured admission budget");
assert(!config.GENERATION_BASE_URL && !config.GENERATION_API_KEY && !config.LCWE_LOCAL_DOCKER_QA);
const actor = "native_owner", prefix = `native-concurrent-create-${randomUUID()}`;
const reader = openFirestoreProgressReader({ storageDriver: "firestore-records", storageEncryptionKey: config.STORAGE_ENCRYPTION_KEY,
  firestoreProjectId: config.FIRESTORE_PROJECT_ID, firestoreDatabaseId: config.FIRESTORE_DATABASE_ID, firestoreWorkspaceId: config.FIRESTORE_WORKSPACE_ID });
try {
  const before = await reader.snapshot(); assert.equal(before.users[actor]?.email, "native@example.test");
  const token = jwt.sign({}, config.JWT_SECRET, { algorithm: "HS256", subject: actor, expiresIn: 3600 });
  const outcomes = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const command = { title: `${prefix}-${index}`, idempotencyKey: `${prefix}-${index}` }, started = performance.now();
    let response;
    try { response = await fetch("http://127.0.0.1:23675/demo-lcwe-records/asia-south1/api/api/chat/sessions", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(command),
      signal: AbortSignal.timeout(httpTimeoutMs), redirect: "error" }); }
    catch (error) {
      // Client observation ending does not prove that server work was rejected.
      // Observe all original commands and their committed receipts; never resend.
      return { index, command, status: null, durationMs: Math.round(performance.now() - started), sessionId: null,
        code: error?.name === "TimeoutError" ? "HTTP_OBSERVATION_TIMEOUT" : "HTTP_CONNECTION_UNCONFIRMED" };
    }
    const body = await response.text();
    assert(!body.includes(config.JWT_SECRET) && !body.includes(config.STORAGE_ENCRYPTION_KEY));
    const value = JSON.parse(body);
    return { index, command, status: response.status, durationMs: Math.round(performance.now() - started),
      sessionId: value.data?.id ?? null, code: value.meta?.code ?? null };
  }));
  const after = await reader.snapshot();
  const results = outcomes.map(outcome => {
    assert([201, 503, null].includes(outcome.status), `Unexpected native command status ${outcome.status}`);
    if (outcome.status === 503) assert.equal(outcome.code, "FUNCTIONS_INVOCATION_UNCONFIRMED");
    const scope = createHash("sha256").update(JSON.stringify(["chat-creation/v1", actor, outcome.command.idempotencyKey])).digest("hex");
    const receipt = after.chatCreationReceipts[scope], original = receipt ? after.chats[receipt.sessionId] : null;
    const matches = Object.values(after.chats).filter(chat => chat.ownerId === actor && chat.title === outcome.command.title);
    assert(matches.length <= 1, "One command created duplicate chats");
    if (receipt) { assert.equal(receipt.ownerId, actor); assert.equal(original?.title, outcome.command.title); assert.equal(matches.length, 1); }
    if (outcome.status === 201) { assert(receipt, "Acknowledged creation has no durable original receipt"); assert.equal(outcome.sessionId, receipt.sessionId); }
    return { index: outcome.index, status: outcome.status, durationMs: outcome.durationMs, code: outcome.code,
      originalReceiptCommitted: Boolean(receipt), matchingChats: matches.length };
  });
  assert.deepEqual(after.chatOperations, before.chatOperations, "Creating chats dispatched chat work");
  assert.deepEqual(after.executions, before.executions, "Creating chats dispatched a workflow");
  assert.deepEqual(after.invocationProvenance, before.invocationProvenance, "Creating chats invoked a provider");
  const passed = results.every(result => result.status === 201);
  await writeFile(`../docs/evidence/2026-10-12/native-command-concurrency${reportSuffix}.json`, JSON.stringify({ profile: "native-saved-chat-command-concurrency/v1",
    createdAt: new Date().toISOString(), passed, clients: 6, httpRetries: 0, writerAdmissionTimeoutMs, httpTimeoutMs, results,
    observation: "A client timeout/connection failure is an unknown HTTP outcome. Missing receipts in this sampled committed image do not prove that late server work cannot commit.",
    scope: "Native Functions/Firestore saved-chat mutations only; not model/ERP/tool/cancellation/schedule/deployment or load-SLO acceptance" }, null, 2), { flag: "wx" });
  console.log(`${passed ? "PASS" : "FAIL"}: ${results.filter(result => result.status === 201).length}/6 native concurrent saved-chat commands acknowledged; no HTTP retries, duplicate chats or model/ERP/workflow dispatch. Read-catalog success does not close this command gate.`);
  if (!passed) process.exitCode = 1;
} finally { await reader.close(); }
