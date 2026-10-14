// Explicit operator acceptance only: real selected inference + actual local
// Functions/Firestore queues + Docker MockERP. Never production ERP or writes.
import assert from "node:assert/strict";
import { assertNativeResponseContinues, createNativeQaContext } from "./native-qa-diagnostics.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parse } from "yaml";
import { assertNativeDurabilityScope } from "./native-workspace-durability-qa.mjs";
import { assertRealProviderQaConfiguration } from "./erpbridge-workspace-qa.mjs";
import { openNativeQaInspector } from "./native-functions-read-qa.mjs";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";

const profile = "native-real-model-durability/v1";
const model = "deepseek/deepseek-v4.1-flash";
const digest = value => createHash("sha256").update(canonicalJSONBytes(value ?? null)).digest("hex");

export function assertNativeRealModelScope(config, environment = process.env) {
  assertNativeDurabilityScope(config, environment);
  assertRealProviderQaConfiguration(environment);
}

export function nativeRealCheckpoint(state, references, qa = createNativeQaContext()) {
  qa.stage("durability");
  const { workflowId, chatId, executionId, nodeId } = references;
  for (const id of [workflowId, chatId, executionId, nodeId]) qa.check("REFERENCE_ID", () => assert(typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)));
  const workflow = state.workflows[workflowId], chat = state.chats[chatId], run = state.executions[executionId];
  qa.check("CHECKPOINT_RECORDS", () => assert(workflow && chat && run && state.versions[workflowId]?.length));
  qa.check("CHAT_LINK", () => assert.equal(workflow.chatSessionId, chatId)); qa.check("RUN_LINK", () => assert.equal(run.workflowId, workflowId));
  qa.check("DRAFT_VERSION", () => assert.equal(workflow.draftVersion, 2)); qa.check("PUBLISHED_VERSION", () => assert.equal(workflow.publishedVersion, 2));
  qa.check("SNAPSHOT_VERSION", () => assert.equal(run.workflowSnapshot.version, 2)); qa.check("RUN_TERMINAL", () => assert.equal(run.status, "DONE"));
  qa.check("SAVED_MODEL", () => assert.equal(chat.selectedModel, model));
  qa.check("RUN_ROWS", () => assert.equal(run.stepOutputs[nodeId].structuredContent.data.length, 8));
  qa.check("APPLIED_COUNT", () => assert.equal(chat.messages.filter(message => message.artifacts?.proposal?.status === "APPLIED").length, 1));
  const receipt = chat.messages.find(message => message.artifacts?.policyCheck)?.artifacts.policyCheck;
  qa.check("POLICY_DECISION", () => assert.equal(receipt?.decision, "allow")); qa.check("POLICY_SOURCE", () => assert.equal(receipt?.source, "local_model")); qa.check("POLICY_FALLBACK", () => assert.equal(receipt?.fallbackUsed, true));
  return { profile, workflowId, chatId, executionId, nodeId, selectedModel: model, draftVersion: 2, publishedVersion: 2, status: "DONE", savedRows: 8,
    workflowHash: digest(workflow), versionsHash: digest(state.versions[workflowId]), messagesHash: digest(chat.messages),
    runSnapshotHash: digest(run.workflowSnapshot), outputsHash: digest(run.stepOutputs), finalOutputHash: digest(run.finalOutput),
    eventsHash: digest(state.executionEvents[executionId] ?? []), timelineHash: digest(state.timelines[executionId] ?? []) };
}

async function inspectFresh(config, references, qa) {
  qa.stage("inspector");
  const input = JSON.stringify({ profile, config, references }); qa.check("INSPECTOR_INPUT", () => assert(Buffer.byteLength(input) <= 16000));
  // A storage inspector needs no inference credential and cannot replay work.
  const environment = { ...process.env }; delete environment.GENERATION_API_KEY;
  const child = spawn(process.execPath, ["--import", "tsx/esm", fileURLToPath(import.meta.url), "--inspect"],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment });
  let stdout = "", stderrBytes = 0, refused = false;
  const stop = () => { refused = true; if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  const timer = setTimeout(stop, 45000);
  child.stdout.on("data", bytes => { stdout += bytes.toString("utf8"); if (Buffer.byteLength(stdout) > 8192) stop(); });
  child.stderr.on("data", bytes => { stderrBytes += bytes.length; if (stderrBytes > 8192) stop(); });
  try {
    const closed = new Promise((resolveResult, reject) => {
      child.once("error", () => reject(new Error("Fresh real-model storage inspector could not start; details suppressed")));
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    });
    child.stdin.on("error", () => {}); child.stdin.end(input);
    const result = await qa.step("INSPECTOR_START", () => closed);
    qa.check("INSPECTOR_EXIT", () => assert(!refused && result.code === 0 && result.signal === null, "Fresh real-model storage inspection failed; no work was replayed; details suppressed"));
    const value = qa.check("INSPECTOR_JSON", () => JSON.parse(stdout));
    qa.check("INSPECTOR_PID", () => assert.equal(value.pid, child.pid)); qa.check("INSPECTOR_DISTINCT_PID", () => assert.notEqual(value.pid, process.pid)); qa.check("NODE_VERSION", () => assert.match(value.nodeVersion, /^v22\./));
    return value;
  } finally { clearTimeout(timer); }
}

export async function qualifyNativeRealModel({ request, open, config, diagnostics: qa = createNativeQaContext(), capturePolicyStop }) {
  qa.stage("provider_setup");
  qa.check("SCOPE", () => assertNativeRealModelScope(config)); qa.check("NODE_VERSION", () => assert.match(process.version, /^v22\./));
  const expect = async (path, method, payload, status = 200) => {
    const result = await qa.step("HTTP_RESPONSE", () => request("api", path, method, payload));
    qa.check("HTTP_CREDENTIAL_FILTER", () => assert(!result.body.includes(process.env.GENERATION_API_KEY), "Inference credential escaped HTTP; details suppressed"));
    qa.check("HTTP_STATUS", () => assert.equal(result.status, status, `Unexpected native real-model API status ${result.status}; details suppressed`), { httpStatus: result.status, expectedHttpStatus: status });
    return result.data.data;
  };
  const provider = await expect("/api/providers", "POST", { name: "REAL DeepSeek · local emulator/MockERP acceptance", type: "openai_compatible",
    baseUrl: process.env.GENERATION_BASE_URL, apiKey: process.env.GENERATION_API_KEY, model, temperature: 0,
    egressPolicy: { approvedOrigin: "https://openrouter.ai", confirmed: true, interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [] } }, 201);
  const tested = await expect(`/api/providers/${provider.id}/test`, "POST", {});
  qa.check("PROVIDER_TEST", () => assert.equal(tested.ok, true));
  await expect(`/api/providers/${provider.id}/activate`, "POST", {});
  await expect("/api/settings", "PATCH", { rbac: { enabled: true, localPolicyAgentEnabled: true } });
  const chat = await expect("/api/chat/sessions", "POST", { title: "REAL DeepSeek · durable local prototype", idempotencyKey: "native-real-create-0001" }, 201);
  const send = async (content, key, nodeContext) => {
    const stage = nodeContext ? "node_proposal" : key.includes("postrun") ? "postrun_query" : key.includes("generate") ? "generate" : "query";
    qa.stage(stage);
    const payload = { content, delivery: "async-chat", idempotencyKey: key, model, ...(nodeContext ? { nodeContext } : {}) };
    const admitted = await expect(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
    qa.check("TASK_DISPATCH", () => assert.equal(admitted.taskDispatch, "ENQUEUED")); qa.check("MODEL_BINDING", () => assert.equal(admitted.operation.modelBinding.model, model));
    let operation, pollCount = 0; const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      pollCount++;
      operation = (await expect(`/api/chat/operations/${admitted.operation.id}`, "GET")).operation;
      if (!["QUEUED", "RUNNING"].includes(operation.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    qa.check("TERMINAL_RESPONSE", () => assert.equal(operation?.status, "ANSWERED", "Real model did not save a terminal response; no replay attempted"), { operationStatus: operation?.status, pollCount });
    const saved = await expect(`/api/chat/sessions/${chat.id}`, "GET"), message = saved.messages.find(value => value.id === operation.assistantMessageId);
    qa.check("SAVED_MESSAGE", () => assert(message)); qa.check("SAVED_MODEL", () => assert.equal(saved.selectedModel, model));
    qa.check("POLICY_CONTINUES", () => assertNativeResponseContinues(message, { stage, capturePolicyStop, operation, nodeContext }));
    return message;
  };
  const query = await send("List the synthetic Departments from ERPBridge.", "native-real-query-0001");
  qa.check("POLICY_SOURCE", () => assert.equal(query.artifacts.policyCheck.source, "local_model"), { source: query.artifacts?.policyCheck?.source });
  qa.check("POLICY_FALLBACK", () => assert.equal(query.artifacts.policyCheck.fallbackUsed, true), { fallbackUsed: query.artifacts?.policyCheck?.fallbackUsed });
  qa.check("POLICY_DECISION", () => assert.equal(query.artifacts.policyCheck.decision, "allow"), { decision: query.artifacts?.policyCheck?.decision });
  qa.check("TOOL_STATUS", () => assert.equal(query.artifacts.toolSteps[0].status, "SUCCEEDED"), { toolStatus: query.artifacts?.toolSteps?.[0]?.status });
  qa.check("ROW_COUNT", () => assert.equal(query.artifacts.toolSteps[0].result.structuredContent.data.length, 8), { rowCount: query.artifacts?.toolSteps?.[0]?.result?.structuredContent?.data?.length, expectedRows: 8 });
  console.log("PASS: real DeepSeek local-JSON policy fallback and actual queued chat returned eight governed Docker rows through native Functions/Firestore");
  const generated = await send("Create a manual read-only workflow to list the available synthetic Departments using the admitted ERPBridge read tool. Use one tool node, no analysis or agent node, no schedule, and no write.", "native-real-generate-0001");
  const workflowId = generated.artifacts.workflowId; qa.check("DRAFT_SAVED", () => assert(workflowId, "Real model did not save a draft; details suppressed"));
  const source = await expect(`/api/workflows/${workflowId}/yaml`, "GET"), blueprint = parse(source.yaml);
  qa.check("UNPUBLISHED", () => assert.equal(source.publishedVersion, 0)); qa.check("STEP_COUNT", () => assert.equal(blueprint.steps.length, 1)); qa.check("STEP_ACTION", () => assert.equal(blueprint.steps[0].action, "qa_list_departments"));
  const ready = await expect(`/api/workflows/${workflowId}/readiness`, "GET"); qa.check("READINESS", () => assert.equal(ready.validation.passed, true));
  const nodeId = blueprint.steps[0].id;
  const proposed = await send('Change only this node\'s description to exactly "Reviewed synthetic Department lookup" (without a trailing full stop). Preserve the action, parameters, connection and all other workflow fields.', "native-real-edit-0001",
    { workflowId, nodeId, baseVersion: ready.version, baseHash: ready.contentHash });
  const proposal = proposed.artifacts.proposal; qa.check("PROPOSAL_STATUS", () => assert.equal(proposal.status, "PROPOSED"));
  const unapplied = await expect(`/api/workflows/${workflowId}/yaml`, "GET"); qa.check("PROPOSAL_UNAPPLIED", () => assert.equal(unapplied.yaml, source.yaml));
  qa.stage("apply");
  await expect(`/api/workflows/${workflowId}/commands`, "POST", { baseVersion: ready.version, baseHash: ready.contentHash, proposalId: proposal.id, command: proposal.command });
  const edited = await expect(`/api/workflows/${workflowId}/yaml`, "GET"); qa.check("EDIT_VERSION", () => assert.equal(edited.version, 2)); qa.check("UNPUBLISHED", () => assert.equal(edited.publishedVersion, 0));
  const after = parse(edited.yaml), expected = structuredClone(blueprint);
  qa.check("EDIT_DESCRIPTION", () => assert.equal(after.steps[0].description, "Reviewed synthetic Department lookup")); expected.steps[0].description = after.steps[0].description; qa.check("EDIT_EXACT", () => assert.deepEqual(after, expected));
  qa.stage("publish");
  await expect(`/api/workflows/${workflowId}/publish`, "POST", { baseVersion: edited.version, baseHash: (await expect(`/api/workflows/${workflowId}/readiness`, "GET")).contentHash });
  qa.stage("run");
  const command = { mode: "async-read", idempotencyKey: "native-real-run-0001", input: {} };
  const run = await expect(`/api/workflows/${workflowId}/run`, "POST", command, 202);
  let done; const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    done = await expect(`/api/executions/${run.id}`, "GET"); if (!["PENDING", "RUNNING"].includes(done.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  qa.check("RUN_TERMINAL", () => assert.equal(done?.status, "DONE")); qa.check("RUN_ROWS", () => assert.equal(done.stepOutputs[nodeId].structuredContent.data.length, 8));
  const duplicateRun = await expect(`/api/workflows/${workflowId}/run`, "POST", command, 202); qa.check("RUN_IDEMPOTENCY", () => assert.equal(duplicateRun.id, run.id));
  const postRunQuery = await send("List the synthetic Departments from ERPBridge. Do not create or change ERP records or send email.", "native-real-postrun-query-0001");
  qa.check("TOOL_STATUS", () => assert.equal(postRunQuery.artifacts.toolSteps[0].status, "SUCCEEDED"), { toolStatus: postRunQuery.artifacts?.toolSteps?.[0]?.status });
  qa.check("ROW_COUNT", () => assert.equal(postRunQuery.artifacts.toolSteps[0].result.structuredContent.data.length, 8), { rowCount: postRunQuery.artifacts?.toolSteps?.[0]?.result?.structuredContent?.data?.length, expectedRows: 8 });
  const recorded = postRunQuery.artifacts.workspaceStatus;
  qa.check("STATUS_PROFILE", () => assert.equal(recorded.profile, "chat-workspace-status/v1"));
  qa.check("STATUS_RECORD", () => assert.deepEqual(recorded.workflows.find(value => value.id === workflowId), { id: workflowId, draftVersion: 2, publishedVersion: 2,
    latestRun: { id: run.id, status: "DONE", publishedVersion: 2 } }));
  qa.check("STATUS_HEADING", () => assert(postRunQuery.text.includes("Saved workflow state — server record")));
  qa.check("STATUS_TEXT", () => assert(postRunQuery.text.includes(`draft v2; published v2; latest recorded run ${run.id}: DONE (published v2)`)));
  const interpretation = postRunQuery.text.split("**Saved workflow state — server record**")[0];
  qa.check("STATUS_INTERPRETATION", () => assert(!/remain drafts|not published (?:or|and) executed|not published or executed/i.test(interpretation), "Real model repeated the original stale workflow-status claim; saved evidence retained, no replay attempted"));
  qa.check("NO_EMAIL", () => assert.equal(postRunQuery.artifacts.emailDraft, undefined));
  console.log("PASS: post-publication real DeepSeek negative-email query returned eight rows and current server-owned published-v2/DONE state without the original stale draft claim");
  qa.stage("durability");
  const references = { workflowId, chatId: chat.id, executionId: run.id, nodeId }, repository = await qa.step("CHECKPOINT_READ", open); let checkpoint;
  try { checkpoint = await qa.step("CHECKPOINT_READ", () => repository.readAuthoritative(state => nativeRealCheckpoint(state, references, qa))); } finally { await repository.close(); }
  const first = await inspectFresh(config, references, qa), second = await inspectFresh(config, references, qa);
  qa.stage("durability");
  qa.check("INSPECTOR_DISTINCT_PID", () => assert.notEqual(first.pid, second.pid)); qa.check("INSPECTOR_FIRST", () => assert.deepEqual(first.checkpoint, checkpoint)); qa.check("INSPECTOR_SECOND", () => assert.deepEqual(second.checkpoint, checkpoint));
  const finalSource = await expect(`/api/workflows/${workflowId}/yaml`, "GET"); qa.check("SOURCE_UNCHANGED", () => assert.equal(finalSource.yaml, edited.yaml));
  const finalRun = await expect(`/api/executions/${run.id}`, "GET"); qa.check("OUTPUTS_UNCHANGED", () => assert.deepEqual(finalRun.stepOutputs, done.stepOutputs));
  console.log(`PASS: real DeepSeek generated durable draft, exact node proposal/Apply v2, publication, queued Docker read DONE; two fresh Node 22 inspectors (${first.pid}, ${second.pid}) recovered unchanged chat, source, publication, answers and journals`);
  console.log("LIMIT: loopback Functions/Firestore emulators and eight synthetic Docker records, not hosted Firebase, a real remote policy tool, production writes, email, scheduling or cloud restart qualification");
  return references;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv[2], "--inspect"); let input = "";
    for await (const bytes of process.stdin) { input += bytes.toString("utf8"); assert(Buffer.byteLength(input) <= 16000); }
    const payload = JSON.parse(input); assert.equal(payload.profile, profile); assertNativeDurabilityScope(payload.config); assert.match(process.version, /^v22\./);
    const namespace = { projectId: payload.config.FIRESTORE_PROJECT_ID, databaseId: payload.config.FIRESTORE_DATABASE_ID, workspaceId: payload.config.FIRESTORE_WORKSPACE_ID };
    const repository = await openNativeQaInspector(async () => Repository.open(await FirestoreRecordPersistence.open(payload.config.STORAGE_ENCRYPTION_KEY, namespace)));
    let checkpoint; try { checkpoint = await repository.readAuthoritative(state => nativeRealCheckpoint(state, payload.references)); } finally { await repository.close(); }
    process.stdout.write(JSON.stringify({ pid: process.pid, nodeVersion: process.version, checkpoint }));
  } catch { console.error("Fresh real-model storage inspector refused or failed; details suppressed"); process.exitCode = 1; }
}
