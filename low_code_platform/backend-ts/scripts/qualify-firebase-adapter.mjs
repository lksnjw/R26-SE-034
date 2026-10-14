import assert from "node:assert/strict";
import { access, readFile, writeFile, unlink } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { hashPassword } from "../src/authn/password.js";
import { assertChatTaskOutbox } from "../src/agent/chat-task-outbox.js";
import { openNativeQaInspector } from "./native-functions-read-qa.mjs";
import { safeNativeFailureDiagnostic, createNativeQaContext, createNativeQaReport, createNativePrivatePolicyCapture } from "./native-qa-diagnostics.mjs";

const artifact = resolve(".functions"), sessionPath = resolve(artifact, "qa-session.json"), secretPath = resolve(artifact, ".secret.local");
const mode = process.argv[2];
let campaignReport, campaignSha256, artifactSha256, reportFinished = false, diagnostics = createNativeQaContext();
const dockerOperation = ["--prepare-docker-operation", "--run-docker-operation", "--run-docker-lifecycle", "--prepare-docker-browser", "--run-docker-browser"].includes(mode);
const dockerTen = ["--prepare-docker-ten", "--run-docker-ten", "--prepare-docker-ten-browser", "--run-docker-ten-browser"].includes(mode);
const dockerScale = ["--prepare-docker-scale", "--run-docker-scale", "--prepare-docker-scale-browser", "--run-docker-scale-browser"].includes(mode);
const dockerRead = dockerOperation || dockerTen || dockerScale || ["--prepare-docker-read", "--run-docker-read", "--prepare-docker-model", "--run-docker-model", "--prepare-docker-real-model", "--run-docker-real-model", "--prepare-docker-cancel", "--run-docker-cancel", "--prepare-docker-concurrency", "--run-docker-concurrency"].includes(mode);
const assetDirectory = resolve(artifact, "assets/configs/runtime");
const holdLocalDemo = async () => {
  // A signal listener alone does not keep Node alive (unsettled top-level
  // await exits 13). This operator-owned idle handle performs no work/replay.
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(resolve => process.once("SIGINT", resolve)); }
  finally { clearInterval(timer); }
};
const readSession = async () => {
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  assert.equal(session.profile, "lcwe-native-functions-qa/v1"); assert(/^test_[a-f0-9]{32}_native$/.test(session.config.FIRESTORE_WORKSPACE_ID));
  assert.equal(session.config.FIRESTORE_PROJECT_ID, "demo-lcwe-records"); return session;
};
async function runQualification() {
if (["--prepare", "--prepare-slow-network", "--prepare-docker-read", "--prepare-docker-operation", "--prepare-docker-browser", "--prepare-docker-model", "--prepare-docker-real-model", "--prepare-docker-cancel", "--prepare-docker-concurrency", "--prepare-docker-ten", "--prepare-docker-ten-browser", "--prepare-docker-scale", "--prepare-docker-scale-browser"].includes(mode)) {
  for (const path of [sessionPath, secretPath]) {
    try { await access(path); throw new Error("Existing QA/session secret file was preserved; preparation refused"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const config = { APP_ENV: "test", API_BASE_PATH: "/api", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: "demo-lcwe-records",
    FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: `test_${randomUUID().replaceAll("-", "")}_native`, STORAGE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    JWT_SECRET: randomBytes(48).toString("hex"), MCP_MODE: "mock", MCP_TRANSPORT: "bridge-v1", CORS_ORIGINS: "http://127.0.0.1:23675",
    FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: ["--prepare", "--prepare-docker-cancel", "--prepare-docker-concurrency"].includes(mode) ? "5000" : "30000" };
  const files = dockerOperation ? await import("./native-functions-operation-qa.mjs").then(module => module.nativeOperationFixture()) : dockerScale ? await import("./native-functions-scale-tool-qa.mjs").then(module => module.nativeScaleToolFixture()) : dockerTen ? await import("./native-functions-ten-tool-qa.mjs").then(module => module.nativeTenToolFixture()) :
    dockerRead ? (await import("./native-functions-read-qa.mjs").then(module => module.nativeReadFixture())) : { config: {}, files: {} };
  Object.assign(config, files.config);
  if (["--prepare-docker-browser", "--prepare-docker-real-model", "--prepare-docker-ten-browser", "--prepare-docker-scale-browser"].includes(mode)) config.CORS_ORIGINS = "http://127.0.0.1:5192,http://localhost:5192";
  for (const filename of Object.keys(files.files)) {
    try { await access(resolve(assetDirectory, filename)); throw new Error("Existing QA registry file was preserved"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await writeFile(sessionPath, JSON.stringify({ profile: "lcwe-native-functions-qa/v1", config, files: files.files }), { flag: "wx", mode: 0o600 });
  for (const [filename, bytes] of Object.entries(files.files)) await writeFile(resolve(assetDirectory, filename), bytes, { flag: "wx" });
  await writeFile(secretPath, `LCWE_RUNTIME_CONFIG=${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
  console.log(dockerOperation ? "Prepared exact isolated Docker read/integration-echo configuration and two QA assets; no business write, email or deployment." : dockerRead ? "Prepared exact local Docker read-only fixture configuration and two QA registry assets; release registries preserved, no real provider/business credentials or deployment." : "Prepared local synthetic secret/session files only; no ERP/provider credentials, production writes or deployment.");
} else if (mode === "--cleanup") {
  const session = await readSession(), expected = `LCWE_RUNTIME_CONFIG=${JSON.stringify(session.config)}\n`;
  assert.equal(await readFile(secretPath, "utf8"), expected, "Changed local secret file was preserved");
  for (const [filename, bytes] of Object.entries(session.files ?? {})) {
    assert(["native_qa_tools.json", "native_qa_rules.json"].includes(filename));
    assert.equal(await readFile(resolve(assetDirectory, filename), "utf8"), bytes, "Changed QA registry file was preserved");
  }
  for (const filename of Object.keys(session.files ?? {})) await unlink(resolve(assetDirectory, filename));
  await unlink(secretPath); await unlink(sessionPath);
  console.log("Removed only content-verified generated QA configuration/registry files; no owner files or emulator records were deleted.");
} else if (["--run", "--run-docker-read", "--run-docker-operation", "--run-docker-lifecycle", "--run-docker-browser", "--run-docker-model", "--run-docker-real-model", "--run-docker-cancel", "--run-docker-concurrency", "--run-docker-ten", "--run-docker-ten-browser", "--run-docker-scale", "--run-docker-scale-browser"].includes(mode)) {
  if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== "demo-lcwe-records" || process.env.GOOGLE_APPLICATION_CREDENTIALS)
    throw new Error("Guarded loopback demo Firestore/Functions emulators and no credential file are required");
  const { config } = await readSession(), namespace = { projectId: config.FIRESTORE_PROJECT_ID, databaseId: config.FIRESTORE_DATABASE_ID, workspaceId: config.FIRESTORE_WORKSPACE_ID };
  assert.equal(config.LCWE_LOCAL_DOCKER_QA ?? null, dockerOperation ? "native-operation/v1" : dockerScale ? "native-scale/v1" : dockerRead ? "native-read/v1" : null, "Preparation and execution fixture modes must match");
  if (dockerRead) assert.equal(await import("./erpbridge-docker-qa.mjs").then(module => module.readQaBridgeToken()), config.ERPBRIDGE_MCP_TOKEN, "Local Docker fixture identity changed");
  const policy = dockerOperation ? await import("./native-functions-policy-qa.mjs").then(module => module.startNativePolicyFixture(config)) : undefined;
  try {
  const open = () => openNativeQaInspector(async () => Repository.open(await FirestoreRecordPersistence.open(config.STORAGE_ENCRYPTION_KEY, namespace)));
  const passwordHash = await hashPassword("Synthetic-local-only-2026!"), repository = await open(), timestamp = new Date().toISOString();
  try { await repository.mutate(state => {
    state.users.native_owner = { id: "native_owner", name: "Native fixture", email: "native@example.test", roleId: "role_admin", permissionOverrides: [],
      status: "Active", initials: "NF", departmentId: null, lastLoginAt: null, createdAt: timestamp };
    state.passwordHashes.native_owner = passwordHash;
    if (dockerOperation) {
      state.roles.native_review = { id: "native_review", name: "Native independent reviewer", description: "Local fixture review only", permissions: ["execution:approve"], createdAt: timestamp };
      state.users.native_reviewer = { ...state.users.native_owner, id: "native_reviewer", name: "Native reviewer", email: "reviewer@example.test", roleId: "native_review" };
      state.passwordHashes.native_reviewer = passwordHash;
    }
  }); } finally { await repository.close(); }
  const headers = { authorization: `Bearer ${jwt.sign({}, config.JWT_SECRET, { algorithm: "HS256", subject: "native_owner", expiresIn: 3600 })}` };
  const base = "http://127.0.0.1:23675/demo-lcwe-records/asia-south1";
  const request = async (name, path, method, payload, authorization = true) => {
    const actorHeaders = typeof authorization === "string" ? { authorization: `Bearer ${jwt.sign({}, config.JWT_SECRET, { algorithm: "HS256", subject: authorization, expiresIn: 3600 })}` } : headers;
    const response = await fetch(`${base}/${name}${path}`, { method, headers: { ...(authorization ? actorHeaders : {}), "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: "error", signal: AbortSignal.timeout(45_000) });
    const body = await response.text(); assert([config.JWT_SECRET, config.STORAGE_ENCRYPTION_KEY, config.ERPBRIDGE_MCP_TOKEN].filter(Boolean).every(secret => !body.includes(secret)), "Fixture secrets escaped HTTP");
    return { status: response.status, body, data: (() => { try { return JSON.parse(body); } catch { return null; } })() };
  };
  const denied = await request("api", "/api/workflows", "GET", undefined, false); assert.equal(denied.status, 401, denied.body);
  const login = await request("api", "/api/auth/login", "POST", { email: "native@example.test", password: "Synthetic-local-only-2026!" }, false);
  console.log("NATIVE_LOGIN_CHECKPOINT", JSON.stringify({ status: login.status, code: login.data?.meta?.code ?? null, userId: login.data?.data?.user?.id ?? null }));
  assert.equal(login.status, 200, "The isolated fixture must pass real password authentication, not only a manually signed test JWT");
  assert.equal(login.data.data.user.id, "native_owner"); assert(!login.body.includes(passwordHash), "Password hashes must not escape native login");
  if (dockerRead && !dockerOperation && !dockerScale) await import("./native-functions-control-plane-qa.mjs").then(module => module.qualifyNativeControlPlane({ request, open, config }));
  const listed = await request("api", "/api/workflows", "GET"); assert.equal(listed.status, 200, listed.body);
  const creationCommand = { title: "Native Functions fixture", idempotencyKey: "native-functions-creation-0001" };
  const created = await request("api", "/api/chat/sessions", "POST", creationCommand); assert.equal(created.status, 201, created.body);
  const id = created.data.data.id;
  const recovered = await request("api", "/api/chat/sessions", "POST", creationCommand);
  assert.equal(recovered.status, 200, recovered.body); assert.equal(recovered.data.data.id, id);
  const conflictingCreation = await request("api", "/api/chat/sessions", "POST", { ...creationCommand, title: "Changed command" });
  assert.equal(conflictingCreation.status, 409, conflictingCreation.body);
  console.log("PASS: native separate HTTP invocations recover the original chat creation identity; changed command denied");
  const loaded = await request("api", `/api/chat/sessions/${id}`, "GET"); assert.equal(loaded.status, 200, loaded.body); assert.equal(loaded.data.data.title, "Native Functions fixture");
  const admittedChat = await request("api", `/api/chat/sessions/${id}/messages`, "POST", { content: "Show me invoices", delivery: "async-chat", idempotencyKey: "native-functions-chat-0001" });
  assert.equal(admittedChat.status, 202, admittedChat.body); assert.equal(admittedChat.data.data.taskDispatch, "ENQUEUED");
  const operationId = admittedChat.data.data.operation.id; let answered = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const progress = await request("api", `/api/chat/operations/${operationId}`, "GET");
    if (progress.status === 200 && !["QUEUED", "RUNNING"].includes(progress.data.data.operation.status)) {
      assert.equal(progress.data.data.operation.status, "ANSWERED", progress.body); answered = true; break;
    }
    if (progress.status !== 200) { assert.equal(progress.status, 503, progress.body); assert.equal(progress.data.meta.code, "FUNCTIONS_INVOCATION_UNCONFIRMED"); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert(answered, "Native queued chat did not save its terminal response");
  const reopenedChat = await request("api", `/api/chat/sessions/${id}`, "GET"); assert.equal(reopenedChat.status, 200, reopenedChat.body);
  assert.equal(reopenedChat.data.data.messages.length, 2); const message = reopenedChat.data.data.messages[1];
  assert.equal(message.operationId, operationId); assert.equal(message.artifacts.blocked, true);
  assert(["ERPBRIDGE_NOT_CONNECTED", "PROVIDER_NOT_CONFIGURED"].includes(message.artifacts.code));
  assert.match(message.text, /No ERP operation was performed\./);
  console.log("PASS: native queued chat saves the explicit missing-connection/provider blocker; ANSWERED means a saved response, not ERP/business completion");
  const task = await request("executeReadTask", "", "POST", { data: { profile: "read-task-delivery/v1", executionId: "nonexistent-original-run", taskId: `read-${"a".repeat(64)}` } }, false);
  assert.equal(task.status, 500, task.body); assert(!task.body.includes("STORAGE_ENCRYPTION_KEY"));
  const readback = await request("executeReadbackTask", "", "POST", { data: { profile: "readback-task-delivery/v1", executionId: "nonexistent-original-run", queryId: "nonexistent-original-query", taskId: `readback-${"b".repeat(64)}` } }, false);
  assert.equal(readback.status, 500, readback.body); assert(!readback.body.includes("STORAGE_ENCRYPTION_KEY"));
  const operation = await request("executeOperationTask", "", "POST", { data: { profile: "operation-task-delivery/v1", executionId: "nonexistent-original-operation", taskId: `operation-${"c".repeat(64)}` } }, false);
  assert.equal(operation.status, 500, operation.body); assert(!operation.body.includes("STORAGE_ENCRYPTION_KEY"));
  process.env.LCWE_RUNTIME_CONFIG = JSON.stringify(config);
  const handlers = await import(pathToFileURL(resolve(artifact, "index.mjs")).href);
  await handlers.recoverReadTaskDispatch.run({ scheduleTime: new Date().toISOString(), jobName: "local-fixture-outbox-recovery" });
  const reopened = await open(); let chatCommand, chatEvents;
  try {
    const state = await reopened.readAuthoritative(state => state);
    assert.equal(state.passwordHashes.native_owner, passwordHash, "Functions must never reset bootstrap credentials");
    assert.equal(state.chats[id].title, "Native Functions fixture"); assert.equal(Object.keys(state.chatOperations).length, 1);
    const op = state.chatOperations[operationId]; assert.equal(op.status, "ANSWERED"); assert.equal(op.attempts.length, 0);
    assert.equal(op.inputCiphertext, undefined); assert.equal(op.taskLeaseSecret, undefined);
    chatCommand = { profile: "chat-task-delivery/v1", operationId, taskId: assertChatTaskOutbox(op).taskId };
    chatEvents = structuredClone(state.chatOperationEvents[operationId]);
    assert.equal(Object.keys(state.executions).length, 0); assert.equal(Object.keys(state.readJobs).length, 0);
  } finally { await reopened.close(); }
  const duplicateChat = await request("executeChatTask", "", "POST", { data: chatCommand }, false); assert.equal(duplicateChat.status, 204, duplicateChat.body);
  const repeatedChat = await request("api", `/api/chat/sessions/${id}/messages`, "POST", { content: "Show me invoices", delivery: "async-chat", idempotencyKey: "native-functions-chat-0001" });
  assert.equal(repeatedChat.status, 202, repeatedChat.body); assert.equal(repeatedChat.data.data.operation.id, operationId);
  const verified = await open(); try { await verified.readAuthoritative(state => {
    assert.equal(state.chats[id].messages.length, 2); assert.deepEqual(state.chatOperationEvents[operationId], chatEvents);
    assert.equal(Object.keys(state.chatOperations).length, 1);
  }); } finally { await verified.close(); }
  console.log("PASS: native duplicate chat task and same-key admission preserve one operation, two messages and the original event journal");
  console.log("PASS: nonexistent read/readback refused; outbox recovery made no tool calls; fresh storage owner confirmed saved chat response and no invented ERP run or credential reset");
  if (dockerScale) await import("./native-functions-scale-tool-qa.mjs").then(module => module.qualifyNativeScaleTools({ request, open, config }));
  else if (dockerTen) await import("./native-functions-ten-tool-qa.mjs").then(module => module.qualifyNativeTenTools({ request, open }));
  else if (dockerRead) await import("./native-functions-read-qa.mjs").then(module => module.qualifyNativeRead({ request, open }));
  else console.log("PASS: native chat queue campaign complete; no ERP/model/email execution or cloud IAM/deployment qualification");
  if (dockerTen) await import("./native-functions-model-qa.mjs").then(module => module.qualifyNativeModels({ request, open, config }));
  if (dockerOperation) await import("./native-functions-operation-qa.mjs").then(module => module.qualifyNativeOperation({ request, open, policy }));
  if (["--run-docker-model", "--run-docker-real-model"].includes(mode)) await import("./native-functions-model-qa.mjs").then(module => module.qualifyNativeModels({ request, open, config }));
  if (mode === "--run-docker-real-model") {
    const capturePolicyStop = createNativePrivatePolicyCapture({ config, campaignSha256, artifactSha256 });
    await import("./native-functions-real-model-qa.mjs").then(module => module.qualifyNativeRealModel({ request, open, config, diagnostics, capturePolicyStop }));
    if (process.argv[3] === "--keep-open") diagnostics.check("BROWSER_ORIGINS", () => assert.equal(config.CORS_ORIGINS, "http://127.0.0.1:5192,http://localhost:5192", "Real-model browser requires explicitly prepared loopback origins"));
    // Persist acceptance before an optional idle hold; no replay or extra request.
    reportFinished = true;
    campaignReport.finish(true, { stage: "real_model_campaign", code: "CHECK_PASSED" });
    if (process.argv[3] === "--keep-open") {
      console.log("READY: local native real-model demo; open http://127.0.0.1:5192/chat after synthetic sign-in. Emulated Firestore records last only while this emulator is running; no cloud deployment. Ctrl+C stops this owned campaign.");
      await holdLocalDemo();
    }
  }
  if (mode === "--run-docker-cancel") await import("./native-functions-cancellation-qa.mjs").then(module => module.qualifyNativeCancellation({ request, open, config, reportLabel: process.argv[3] }));
  if (mode === "--run-docker-concurrency") {
    await import("./native-functions-concurrency-qa.mjs").then(module => module.qualifyNativeConcurrency({ request, open, config, reportLabel: process.argv[3] }));
    // Keep the existing contract-parity and Stop gates unchanged, on the same
    // frozen artifact/isolated namespace after the causal cases have passed.
    await import("./native-functions-model-qa.mjs").then(module => module.qualifyNativeModels({ request, open, config }));
    await import("./native-functions-cancellation-qa.mjs").then(module => module.qualifyNativeCancellation({ request, open, config, reportLabel: process.argv[3] }));
  }
  if (mode === "--run-docker-lifecycle") await import("./native-functions-lifecycle-qa.mjs").then(module => module.qualifyNativeLifecycle({ request, open, handlers }));
  if (mode === "--run-docker-browser") {
    assert.equal(config.CORS_ORIGINS, "http://127.0.0.1:5192,http://localhost:5192", "Browser QA requires its exact separately prepared origins");
    console.log("READY: isolated native browser fixture; real task/Firestore emulators and Docker MockERP only. Synthetic online policy remains available until Ctrl+C. No production/email/model deployment qualification.");
    await holdLocalDemo();
  }
  if (mode === "--run-docker-ten-browser") {
    assert.equal(config.CORS_ORIGINS, "http://127.0.0.1:5192,http://localhost:5192", "Ten-tool browser QA requires its exact loopback origins");
    console.log("READY: ten-tool ERP workflow and local Pi model fixture are saved for browser inspection. Firebase/Firestore and Docker MockERP remain local; Ctrl+C stops this owned campaign.");
    await holdLocalDemo();
  }
  if (mode === "--run-docker-scale-browser") {
    assert.equal(config.CORS_ORIGINS, "http://127.0.0.1:5192,http://localhost:5192", "Scale browser QA requires its exact loopback origins");
    console.log("READY: 128-tool catalog and Pi-generated 101-step workflow are saved for browser inspection. Firebase/Firestore and Docker MockERP remain local; Ctrl+C stops this owned campaign.");
    await holdLocalDemo();
  }
  } finally { await policy?.close(); }
} else { throw new Error("Choose --prepare, --run or --cleanup explicitly"); }
}

// Own the executable boundary: Node's uncaught AssertionError renderer can print
// private actual/expected bodies even after a safe diagnostic was logged.
try {
  if (mode === "--run-docker-real-model") {
    const reportName = `native-real-model-report-${randomUUID()}.jsonl`;
    campaignSha256 = createHash("sha256").update(reportName).digest("hex");
    artifactSha256 = createHash("sha256").update(await readFile(resolve(artifact, "index.mjs"))).digest("hex");
    campaignReport = createNativeQaReport(resolve("../docs/evidence/2026-10-12", reportName), { artifactSha256 });
    diagnostics = createNativeQaContext(campaignReport.record);
    console.log(`Native real-model safe report: docs/evidence/2026-10-12/${reportName}`);
  }
  await runQualification();
} catch (error) {
  process.exitCode = 1;
  const failure = mode === "--run-docker-real-model" ? diagnostics.failure(error) : safeNativeFailureDiagnostic(error);
  console.error("Native campaign failure diagnostic:", JSON.stringify(failure));
  if (campaignReport && !reportFinished) {
    reportFinished = true;
    try { campaignReport.finish(false, failure); }
    catch (reportError) { console.error("Native campaign report failure:", JSON.stringify(safeNativeFailureDiagnostic(reportError))); }
  }
  if (mode === "--run-docker-real-model" && process.argv[3] === "--keep-open") {
    console.error("FAILED: native real-model campaign is not accepted. Keeping only this isolated emulator namespace open for failure inspection; no work is retried. Ctrl+C releases it.");
    try { await holdLocalDemo(); } catch { process.exitCode = 1; }
  }
  if (mode === "--run-docker-ten-browser") {
    console.error("FAILED: ten-tool browser campaign is held for isolated inspection; no workflow or tool call is retried. Ctrl+C releases it.");
    try { await holdLocalDemo(); } catch { process.exitCode = 1; }
  }
  if (mode === "--run-docker-scale-browser") {
    console.error("FAILED: scale browser campaign is held for isolated inspection; no workflow or tool call is retried. Ctrl+C releases it.");
    try { await holdLocalDemo(); } catch { process.exitCode = 1; }
  }
}
