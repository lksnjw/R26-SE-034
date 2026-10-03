import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { bindExecutionHost } from "../src/runner/execution-host.js";
import { assertChatTaskOutbox, configureChatTaskDispatch, recoverChatTaskOutboxes } from "../src/agent/chat-task-outbox.js";
import { chatJobQueue } from "../src/agent/chat-jobs.js";
import { buildApp } from "../src/http/app.js";

// Actual encrypted Firestore and fresh child-process owners. Queue, model and
// ERP SDK are explicit local fixtures, not cloud delivery or real providers.
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== "demo-lcwe-records" || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded demo Firestore emulator and no credential file are required");
const phase = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : undefined;
const phases = new Set(["admit", "execute", "duplicate", "recover", "finish-before", "finish-after",
  ...["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"].flatMap(stage => [`fault-${stage}-before`, `fault-${stage}-after`])]);
const commandFor = op => ({ profile: "chat-task-delivery/v1", operationId: op.id, taskId: assertChatTaskOutbox(op).taskId });
async function child() {
  assert(phases.has(phase)); const workspaceId = process.env.LCWE_CHAT_QA_WORKSPACE, key = process.env.LCWE_CHAT_QA_KEY;
  assert(/^test_[a-f0-9]{32}_chattask$/.test(workspaceId ?? "")); assert.equal(Buffer.from(key ?? "", "base64").length, 32);
  const config = { ...loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", STORAGE_ENCRYPTION_KEY: key,
    JWT_SECRET: "isolated-chat-task-emulator-fixture-secret-32-bytes" }), erpbridgeRoleMap: { "Platform Admin": "admin" } };
  const storage = await FirestoreRecordPersistence.open(key, { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId });
  const repository = await Repository.open(storage), registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  let sdkCalls = 0, modelCalls = 0;
  const bridge = await createErpbridgeMcpSession({ baseURL: "https://chat-task.fixture.example.test", token: "synthetic-stable-credential", timeoutMs: 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => registries.snapshot().tools.map(t => ({ name: t.mcp_tool_name, inputSchema: t.input_schema })),
      callTool: async () => { sdkCalls++; return { content: [], structuredContent: { value: "acknowledged emulator fixture" } }; } } });
  const providerRuntime = new ProviderRuntime(repository, executor, async (_url, init) => {
    modelCalls++; const input = JSON.parse(String(init.body)), done = input.messages.some(message => message.role === "tool");
    return Response.json({ choices: [{ finish_reason: done ? "stop" : "tool_calls", message: done ? { content: "Confirmed synthetic read." } : {
      content: "", tool_calls: [{ id: "fixture-read", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }] } }] });
  });
  providerRuntime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://model.fixture.example.test/v1", apiKey: "synthetic-provider-key", model: "fixture-model",
    temperature: 0, timeoutMs: 1000, egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://model.fixture.example.test",
      runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "owner", name: "Fixture owner" } } });
  const services = { config, repository, registries, validator, executor, providerRuntime, erpbridgeSession: bridge };
  bindExecutionHost(repository, "bounded-invocation"); const enqueued = [];
  configureChatTaskDispatch(repository, { timeoutMs: 1000, enqueue: async command => { enqueued.push(structuredClone(command));
    return { taskId: command.taskId, outcome: phase === "recover" ? "ALREADY_EXISTS" : "CREATED" }; } });
  const app = await buildApp(services, { executionHost: "bounded-invocation" });
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` };
  let injected = false, attemptedCommand, result;
  try {
    if (!(await repository.read(state => state.users.owner))) await repository.mutate(state => {
      const timestamp = new Date().toISOString(); state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [],
        status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: timestamp };
      state.chats.chat = { id: "chat", ownerId: "owner", title: "Synthetic task", createdAt: timestamp, updatedAt: timestamp, messageCount: 0, messages: [] };
    });
    const fault = phase.startsWith("fault-") ? phase.split("-") : phase.startsWith("finish-") ? ["finish", "ANSWERED", phase.split("-")[1]] : undefined;
    const save = storage.save.bind(storage);
    if (fault) storage.save = async bytes => {
      const op = Object.values(JSON.parse(Buffer.from(bytes).toString("utf8")).chatOperations)[0];
      const matches = fault[0] === "finish" ? op?.status === "ANSWERED" : op?.taskDispatchSecret?.state === fault[1];
      if (!injected && matches) { injected = true; attemptedCommand = commandFor(op); if (fault[2] === "after") await save(bytes);
        throw new Error("Synthetic before/after-COMMIT acknowledgement loss"); }
      return save(bytes);
    };
    if (phase === "admit" || phase.startsWith("fault-")) {
      const response = await app.inject({ method: "POST", url: "/api/chat/sessions/chat/messages", headers,
        payload: { content: "Show me invoices", delivery: "async-chat", idempotencyKey: "firestore-chat-task-qualification-0001" } });
      assert.equal(response.statusCode, phase === "admit" ? 202 : fault[1] === "ENQUEUED" ? 503 : 500, response.body);
      assert.equal(modelCalls, 0); assert.equal(sdkCalls, 0); result = { httpStatus: response.statusCode };
    } else if (phase === "recover") {
      result = { recovery: await recoverChatTaskOutboxes(repository) }; assert.equal(modelCalls, 0); assert.equal(sdkCalls, 0);
    } else {
      const op = await repository.readAuthoritative(state => structuredClone(Object.values(state.chatOperations)[0])); assert(op);
      if (op.status === "RUNNING") {
        const remaining = Date.parse(op.taskLeaseSecret.expiresAt) - Date.now(); assert(remaining <= 10_000, "Only original bounded fixture lease may be awaited");
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 20));
      }
      if (fault) await assert.rejects(chatJobQueue(services).executeTask(commandFor(op), { timeoutMs: 10_000 }));
      else {
        const receipt = await chatJobQueue(services).executeTask(commandFor(op), { timeoutMs: 10_000 });
        assert(["ANSWERED", "RECOVERY_REQUIRED"].includes(receipt.status)); result = { status: receipt.status };
      }
    }
    if (fault) { assert(injected); assert.throws(() => repository.assertAuthority()); }
    const op = !fault ? await repository.readAuthoritative(state => structuredClone(Object.values(state.chatOperations)[0])) : undefined;
    return { ...result, command: attemptedCommand ?? (op ? commandFor(op) : null), enqueued, sdkCalls, modelCalls,
      messages: !fault ? await repository.readAuthoritative(state => state.chats.chat.messages.length) : undefined };
  } finally { await app.close(); await bridge.close(); await repository.close(); }
}
if (phase) {
  try { console.log(JSON.stringify(await child())); } catch (error) { console.error(`Chat task phase ${phase} failed (${error.name}); no live business result claimed`); process.exitCode = 1; }
} else {
  const namespace = () => ({ LCWE_CHAT_QA_WORKSPACE: `test_${randomUUID().replaceAll("-", "")}_chattask`, LCWE_CHAT_QA_KEY: randomBytes(32).toString("base64") });
  const invoke = async (phase, fixture) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx/esm", fileURLToPath(import.meta.url), "--phase", phase], {
      env: { ...process.env, ...fixture, NODE_ENV: "test" }, timeout: 60_000, maxBuffer: 200_000, windowsHide: true });
    return JSON.parse(stdout.trim());
  };
  const basic = namespace(), admitted = await invoke("admit", basic), executed = await invoke("execute", basic), duplicate = await invoke("duplicate", basic);
  assert.deepEqual(executed.command, admitted.command); assert.deepEqual(duplicate.command, admitted.command);
  assert.equal(executed.status, "ANSWERED"); assert.equal(executed.sdkCalls, 1); assert.equal(executed.modelCalls, 2);
  assert.equal(duplicate.status, "ANSWERED"); assert.equal(duplicate.sdkCalls, 0); assert.equal(duplicate.modelCalls, 0); assert.equal(duplicate.messages, 2);
  console.log("PASS: actual encrypted Firestore admission/execution/duplicate across three fresh processes retained one answered chat and one original task");
  for (const stage of ["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"]) for (const edge of ["before", "after"]) {
    const fixture = namespace(), failed = await invoke(`fault-${stage}-${edge}`, fixture), recovery = await invoke("recover", fixture);
    const absent = stage === "PREPARED" && edge === "before";
    assert.equal(recovery.recovery.inspected, absent || stage === "ENQUEUED" && edge === "after" ? 0 : 1);
    if (!absent) {
      assert.deepEqual(recovery.command, failed.command); const done = await invoke("execute", fixture), duplicate = await invoke("duplicate", fixture);
      assert.deepEqual(done.command, failed.command); assert.deepEqual(duplicate.command, failed.command); assert.equal(done.sdkCalls, 1); assert.equal(done.status, "ANSWERED");
      assert.equal(duplicate.modelCalls, 0); assert.equal(duplicate.sdkCalls, 0); assert.equal(duplicate.messages, 2);
    }
    console.log(`PASS: ${edge}-COMMIT ${stage} loss; fresh owner reconciled original chat task without model/ERP during dispatch recovery`);
  }
  for (const edge of ["before", "after"]) {
    const fixture = namespace(), admission = await invoke("admit", fixture), failed = await invoke(`finish-${edge}`, fixture), duplicate = await invoke("duplicate", fixture);
    assert.deepEqual(duplicate.command, admission.command); assert.deepEqual(failed.command, admission.command);
    assert.equal(failed.sdkCalls, 1); assert.equal(failed.modelCalls, 2); assert.equal(duplicate.sdkCalls, 0); assert.equal(duplicate.modelCalls, 0);
    assert.equal(duplicate.status, edge === "after" ? "ANSWERED" : "RECOVERY_REQUIRED"); assert.equal(duplicate.messages, edge === "after" ? 2 : 1);
    console.log(`PASS: ${edge}-COMMIT answer loss; fresh task reconciled ${duplicate.status} without repeating a model/ERP turn`);
  }
  console.log("PASS: chat task Firestore campaign complete; clean child-process restarts, fixture queue/model/SDK, not abrupt kills, live providers or cloud IAM");
}
