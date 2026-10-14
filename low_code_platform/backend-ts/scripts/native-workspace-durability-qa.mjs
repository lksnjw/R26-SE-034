// Operator-only, loopback emulator acceptance. No application, model or ERP
// entry point is invoked by the fresh inspectors. Secrets travel on stdin,
// never in process arguments, output or saved evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { openNativeQaInspector } from "./native-functions-read-qa.mjs";

const profile = "native-workspace-durability/v1";
const digest = value => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");

export function assertNativeDurabilityScope(config, env = process.env) {
  assert.equal(env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(env.GCLOUD_PROJECT, "demo-lcwe-records");
  assert(!env.GOOGLE_APPLICATION_CREDENTIALS);
  assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records");
  assert.equal(config.FIRESTORE_DATABASE_ID, "(default)");
  assert(/^test_[a-f0-9]{32}_native$/.test(config.FIRESTORE_WORKSPACE_ID));
  assert.equal(config.LCWE_LOCAL_DOCKER_QA, "native-read/v1");
  assert.equal(config.ERPBRIDGE_BASE_URL, "http://127.0.0.1:18080");
  assert.equal(Buffer.from(config.STORAGE_ENCRYPTION_KEY, "base64").length, 32);
}

export function nativeWorkspaceCheckpoint(state, references) {
  const { workflowId, chatId, executionId } = references;
  for (const id of [workflowId, chatId, executionId]) assert(typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id));
  const workflow = state.workflows[workflowId], chat = state.chats[chatId], run = state.executions[executionId];
  assert(workflow && chat && run && state.versions[workflowId]?.length);
  assert.equal(workflow.chatSessionId, chatId);
  assert.equal(run.workflowId, workflowId);
  assert.equal(run.status, "DONE");
  assert.equal(workflow.draftVersion, 2);
  assert.equal(workflow.publishedVersion, 2);
  assert.equal(run.workflowSnapshot.version, 2);
  assert.equal(chat.selectedModel, "local-alternate-fixture");
  assert.equal(run.stepOutputs.departments.structuredContent.data.length, 8);
  assert.equal(run.finalOutput.structuredContent.departmentCount, 8);
  const proposalMessages = chat.messages.filter(message => message.artifacts?.proposal?.status === "APPLIED");
  assert.equal(proposalMessages.length, 1);
  return { profile, workflowId, chatId, executionId, draftVersion: workflow.draftVersion, publishedVersion: workflow.publishedVersion,
    status: run.status, selectedModel: chat.selectedModel, savedRows: 8, analysisCount: 8,
    workflowHash: digest(workflow), versionsHash: digest(state.versions[workflowId]), messagesHash: digest(chat.messages),
    runSnapshotHash: digest(run.workflowSnapshot), outputsHash: digest(run.stepOutputs), finalOutputHash: digest(run.finalOutput),
    eventsHash: digest(state.executionEvents[executionId] ?? []), timelineHash: digest(state.timelines[executionId] ?? []) };
}

async function inspectChild(config, references) {
  const input = JSON.stringify({ profile, config, references }); assert(Buffer.byteLength(input) <= 16000);
  const child = spawn(process.execPath, ["--import", "tsx/esm", fileURLToPath(import.meta.url), "--inspect"],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderrSize = 0, expired = false, oversized = false;
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  const timer = setTimeout(() => { expired = true; stop(); }, 45000);
  child.stdout.on("data", bytes => { stdout += bytes.toString("utf8"); if (Buffer.byteLength(stdout) > 8192) { oversized = true; stop(); } });
  child.stderr.on("data", bytes => { stderrSize += bytes.length; if (stderrSize > 8192) { oversized = true; stop(); } });
  try {
    const completed = new Promise((resolveResult, reject) => {
      child.once("error", () => reject(new Error("Native workspace inspector could not start (details suppressed)")));
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const result = await completed;
    assert(!expired && !oversized && result.code === 0 && result.signal === null, "Native workspace inspector failed; do not replay work (details suppressed)");
    const value = JSON.parse(stdout); assert.equal(value.pid, child.pid); assert.notEqual(value.pid, process.pid);
    assert.match(value.nodeVersion, /^v22\./);
    return value;
  } finally { clearTimeout(timer); }
}

export async function qualifyNativeWorkspaceDurability({ config, references, open }) {
  assertNativeDurabilityScope(config);
  assert.match(process.version, /^v22\./);
  const repository = await open(); let expected;
  try { expected = await repository.readAuthoritative(state => nativeWorkspaceCheckpoint(state, references)); }
  finally { await repository.close(); }
  const first = await inspectChild(config, references), second = await inspectChild(config, references);
  assert.notEqual(first.pid, second.pid);
  assert.deepEqual(first.checkpoint, expected); assert.deepEqual(second.checkpoint, expected);
  console.log(`PASS: two fresh Node 22 processes (${first.pid}, ${second.pid}) reopened encrypted Firestore workflow v2, immutable publication, applied node proposal, selected chat model, eight Docker rows, analysis answer and unchanged run journals`);
  console.log("LIMIT: separate-process durable reopen after DONE; not killing a live Functions task, emulator/database restart, cloud durability or remote effect-recovery qualification");
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv[2], "--inspect"); let input = "";
    for await (const bytes of process.stdin) { input += bytes.toString("utf8"); assert(Buffer.byteLength(input) <= 16000); }
    const payload = JSON.parse(input); assert.equal(payload.profile, profile); assertNativeDurabilityScope(payload.config);
    const namespace = { projectId: payload.config.FIRESTORE_PROJECT_ID, databaseId: payload.config.FIRESTORE_DATABASE_ID, workspaceId: payload.config.FIRESTORE_WORKSPACE_ID };
    const repository = await openNativeQaInspector(async () => Repository.open(await FirestoreRecordPersistence.open(payload.config.STORAGE_ENCRYPTION_KEY, namespace)));
    let checkpoint;
    try { checkpoint = await repository.readAuthoritative(state => nativeWorkspaceCheckpoint(state, payload.references)); }
    finally { await repository.close(); }
    process.stdout.write(JSON.stringify({ pid: process.pid, nodeVersion: process.version, checkpoint }));
  } catch { console.error("Native workspace inspector refused or failed (details suppressed)"); process.exitCode = 1; }
}
