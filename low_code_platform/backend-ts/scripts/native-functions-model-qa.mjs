// Actual native Functions/Firestore and Docker transport, but a strictly local
// HTTP planning fixture. This is not external-model quality or business proof.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { qaPlanningResponse } from "./erpbridge-workspace-qa.mjs";
import { assertChatTaskOutbox } from "../src/agent/chat-task-outbox.js";

export const nativeModelIds = ["local-planning-fixture", "local-alternate-fixture"];

export function nativeModelResponse(body) {
  assert(body && typeof body === "object" && !Array.isArray(body));
  assert(nativeModelIds.includes(body.model), "Only the two literal synthetic models are supported");
  assert(Array.isArray(body.messages) && body.messages.length <= 100);
  assert(body.messages.every(message => message && typeof message.content === "string" || message?.role === "assistant" && message.content === null));
  const testing = body.messages.at(-1)?.content === "Reply with exactly OK.";
  return { ...(testing ? { choices: [{ message: { content: "OK" } }] } : qaPlanningResponse(body, true)),
    usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

export async function startNativeModelFixture(config, { beforeReply, responseFor = nativeModelResponse } = {}) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  assert(["native-read/v1", "native-scale/v1"].includes(config.LCWE_LOCAL_DOCKER_QA), "Unsupported native model fixture profile");
  assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records");
  assert(/^test_[a-f0-9]{32}_native$/.test(config.FIRESTORE_WORKSPACE_ID));
  assert.equal(config.ERPBRIDGE_BASE_URL, "http://127.0.0.1:18080");
  const apiKey = randomBytes(32).toString("hex"), calls = [];
  const server = createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { request.resume(); return reply(404, { error: "Local fixture endpoint only" }); }
    if (request.headers.authorization !== `Bearer ${apiKey}`) { request.resume(); return reply(403, { error: "Local fixture authorization required" }); }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 256000) { request.resume(); return reply(413, { error: "Local fixture input bound" }); } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")), result = responseFor(body);
      const call = { model: body.model, system: body.messages.find(message => message.role === "system")?.content?.split("\n").find(line => line.startsWith("TASK:")) ?? "provider-test" };
      calls.push(call);
      // Operator-only latency fixture: the supported literal response is fixed
      // before this hook. It cannot substitute a model answer or enable effects.
      if (beforeReply) await beforeReply(call);
      reply(200, result);
    } catch { reply(422, { error: "Outside literal synthetic model fixture scope" }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, calls,
    async close() { await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); } };
}

export async function qualifyNativeModels({ request, open, config }) {
  const fixture = await startNativeModelFixture(config);
  try {
    const expect = async (path, method, payload, status = 200) => {
      const result = await request("api", path, method, payload);
      assert.equal(result.status, status, result.body); assert(!result.body.includes(fixture.apiKey), "Provider credential escaped HTTP"); return result.data.data;
    };
    const input = { name: "LOCAL native HTTP planning fixture", type: "openai_compatible", baseUrl: fixture.baseUrl, apiKey: fixture.apiKey,
      model: nativeModelIds[0], additionalModels: [nativeModelIds[1]], temperature: 0,
      egressPolicy: { approvedOrigin: new URL(fixture.baseUrl).origin, confirmed: true,
        interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: ["internal"], runtimeAgentDataClasses: ["internal"] } };
    const provider = await expect("/api/providers", "POST", input, 201);
    assert.equal((await expect(`/api/providers/${provider.id}/test`, "POST", {})).ok, true);
    await expect(`/api/providers/${provider.id}/activate`, "POST", {});
    const catalog = await expect("/api/chat/models", "GET"); assert.deepEqual(catalog.models, nativeModelIds); assert.equal(catalog.binding.model, nativeModelIds[0]);
    const chat = await expect("/api/chat/sessions", "POST", { title: "LOCAL native model workflow", idempotencyKey: "native-model-chat-create-0001" }, 201);
    const send = async (content, key, model, nodeContext) => {
      const payload = { content, delivery: "async-chat", idempotencyKey: key, model, ...(nodeContext ? { nodeContext } : {}) };
      const admitted = await expect(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
      assert.equal(admitted.taskDispatch, "ENQUEUED"); assert.equal(admitted.operation.modelBinding.model, model);
      const deadline = Date.now() + 180000; let operation;
      while (Date.now() < deadline) {
        const progress = await expect(`/api/chat/operations/${admitted.operation.id}`, "GET"); operation = progress.operation;
        if (!["QUEUED", "RUNNING"].includes(operation.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(operation?.status, "ANSWERED", JSON.stringify({ status: operation?.status, failure: operation?.failure }));
      const saved = await expect(`/api/chat/sessions/${chat.id}`, "GET"), message = saved.messages.find(value => value.id === operation.assistantMessageId);
      assert(message); assert.equal(saved.selectedModel, model); assert.equal((message.modelBinding ?? message.artifacts?.proposal?.modelBinding)?.model, model);
      assert.equal((await expect("/api/chat/models", "GET")).binding.model, nativeModelIds[0], "Chat choice replaced the saved administration default");
      const calls = fixture.calls.length, replay = await expect(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
      assert.equal(replay.operation.id, operation.id); assert.equal(fixture.calls.length, calls, "Same-key replay invoked the model again");
      const repository = await open(); let command;
      try { command = await repository.readAuthoritative(state => ({ profile: "chat-task-delivery/v1", operationId: operation.id, taskId: assertChatTaskOutbox(state.chatOperations[operation.id]).taskId })); }
      finally { await repository.close(); }
      const duplicate = await request("executeChatTask", "", "POST", { data: command }, false);
      assert.equal(duplicate.status, 204, duplicate.body); assert.equal(fixture.calls.length, calls);
      return message;
    };
    for (const [index, model] of [nativeModelIds[0], nativeModelIds[1], nativeModelIds[0]].entries()) {
      const message = await send("List the synthetic Departments from ERPBridge.", `native-model-query-${index}-0001`, model);
      assert.equal(message.artifacts.toolSteps[0].result.structuredContent.data.length, 8);
    }
    console.log("PASS: native saved provider/test/activation and A/B/A queued chats; actual Docker rows, persisted selected model, unchanged default and no duplicate model/tool delivery");
    const generated = await send("Create a local workflow to read synthetic Departments and count them with analysis.", "native-model-generate-0001", nativeModelIds[0]);
    const workflowId = generated.artifacts.workflowId; assert(workflowId, "Queued generation did not acknowledge a saved draft");
    const draft = await expect(`/api/workflows/${workflowId}`, "GET"); assert.equal(draft.publishedVersion, 0); assert.equal(draft.canRun, false);
    const source = await expect(`/api/workflows/${workflowId}/yaml`, "GET"); assert.equal(typeof source.yaml, "string");
    const readiness = await expect(`/api/workflows/${workflowId}/readiness`, "GET");
    const proposalMessage = await send("Describe this synthetic Department read more clearly.", "native-model-node-edit-0001", nativeModelIds[1],
      { workflowId, nodeId: "departments", baseVersion: readiness.version, baseHash: readiness.contentHash });
    const proposal = proposalMessage.artifacts.proposal; assert.equal(proposal.status, "PROPOSED");
    assert.equal((await expect(`/api/workflows/${workflowId}/yaml`, "GET")).yaml, source.yaml, "Proposing an edit silently modified the draft");
    await expect(`/api/workflows/${workflowId}/commands`, "POST", { baseVersion: readiness.version, baseHash: readiness.contentHash, proposalId: proposal.id, command: proposal.command });
    const edited = await expect(`/api/workflows/${workflowId}/yaml`, "GET"); assert.notEqual(edited.yaml, source.yaml); assert.equal(edited.publishedVersion, 0);
    await expect(`/api/workflows/${workflowId}/publish`, "POST", {});
    const runCommand = { mode: "async-operation", idempotencyKey: "native-model-analysis-run-0001", input: {} };
    const run = await expect(`/api/workflows/${workflowId}/run`, "POST", runCommand, 202);
    let done; const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      done = await expect(`/api/executions/${run.id}`, "GET"); if (!["PENDING", "RUNNING"].includes(done.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(done?.status, "DONE", JSON.stringify({ status: done?.status, failure: done?.failure }));
    assert.equal(done.stepOutputs.departments.structuredContent.data.length, 8); assert.equal(done.finalOutput.structuredContent.departmentCount, 8);
    const calls = fixture.calls.length; assert.equal((await expect(`/api/workflows/${workflowId}/run`, "POST", runCommand, 202)).id, run.id); assert.equal(fixture.calls.length, calls);
    const restored = await expect(`/api/chat/sessions/${chat.id}`, "GET"); assert.equal(restored.selectedModel, nativeModelIds[1]);
    assert.equal((await expect("/api/chat/models", "GET")).binding.model, nativeModelIds[0]);
    console.log("PASS: native prompt → durable draft → model-B node proposal → explicit Apply → reload → publish → queued Docker read/model-A analysis DONE; same-key run retained identity without another model call");
    await import("./native-workspace-durability-qa.mjs").then(module => module.qualifyNativeWorkspaceDurability({ config, references: { workflowId, chatId: chat.id, executionId: run.id }, open }));
    assert.equal(fixture.calls.length, calls, "Durability inspection unexpectedly called the model");
    assert.equal((await expect(`/api/workflows/${workflowId}/yaml`, "GET")).yaml, edited.yaml);
    const durableRun = await expect(`/api/executions/${run.id}`, "GET");
    assert.deepEqual(durableRun.stepOutputs, done.stepOutputs); assert.deepEqual(durableRun.finalOutput, done.finalOutput);
    console.log("LIMIT: literal local HTTP model fixture, not real-provider inference or arbitrary generation quality; no email, business writes, deployment or production performance claim");
  } finally { await fixture.close(); }
}
