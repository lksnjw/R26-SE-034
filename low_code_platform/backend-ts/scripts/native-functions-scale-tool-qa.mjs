// Native Firebase Functions + Firestore qualification for a large ERP catalog:
// 128 reviewed ERPBridge tools and one Pi-generated 101-step read workflow.
// Every remote call remains a safe GET against the isolated Docker MockERP.
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";
import { startNativeModelFixture, nativeModelIds } from "./native-functions-model-qa.mjs";
import { qaScaleReadResources, qaScaleReviewedDefinition, QA_SCALE_TOOL_COUNT, QA_SCALE_WORKFLOW_STEPS } from "./seed-erpbridge-qa-scale-read.mjs";
import { assertChatTaskOutbox } from "../src/agent/chat-task-outbox.js";
import { assertReadTaskOutbox } from "../src/runner/read-task-outbox.js";

export const scaleGenerationRequest = `Create a ${QA_SCALE_WORKFLOW_STEPS}-step local ERP portfolio workflow from the reviewed large catalog.`;

async function remoteResource(token, resource) {
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=${encodeURIComponent(resource.name)}&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `Exact Docker scale fixture ${resource.name} must already be registered`);
  const resources = await response.json(); assert.equal(resources.length, 1); return resources[0];
}

export function qaScaleWorkflowBlueprint() {
  return { name: "LOCAL Pi 101-step ERP portfolio", description: "Pi-generated local scale qualification: 101 distinct reviewed MockERP reads; no production data, writes, email or scheduling.",
    trigger: { type: "manual", config: {} }, steps: qaScaleReadResources.slice(0, QA_SCALE_WORKFLOW_STEPS).map(resource => ({
      id: resource.id, action: resource.name, description: `Read synthetic ${resource.label}`, parameters: {},
    })) };
}

export async function nativeScaleToolFixture() {
  const token = await readQaBridgeToken();
  const definitions = await Promise.all(qaScaleReadResources.map(async resource => qaScaleReviewedDefinition(await remoteResource(token, resource), resource)));
  return { config: { APP_ENV: "development", LCWE_LOCAL_DOCKER_QA: "native-scale/v1", READ_WORKER_LEASE_MS: "180000", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
    ERPBRIDGE_BASE_URL: qaBaseURL, ERPBRIDGE_MCP_TOKEN: token, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"admin"}',
    TOOL_REGISTRY_PATH: "configs/runtime/native_qa_tools.json", RULE_REGISTRY_PATH: "configs/runtime/native_qa_rules.json" },
    files: { "native_qa_tools.json": JSON.stringify(definitions), "native_qa_rules.json": "[]" } };
}

function scaleModelResponse(body, evidence) {
  assert(body && typeof body === "object" && !Array.isArray(body));
  assert(nativeModelIds.includes(body.model), "Only the two literal synthetic models are supported");
  assert(Array.isArray(body.messages) && body.messages.length <= 100);
  const system = body.messages.find(message => message.role === "system")?.content ?? "";
  const latest = body.messages.at(-1)?.content;
  if (latest === "Reply with exactly OK.") return { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  if (system.includes("TASK: WORKFLOW DRAFT SYNTHESIS")) {
    const input = JSON.parse(body.messages.findLast(message => message.role === "user")?.content ?? "");
    assert.equal(input.USER_REQUEST, scaleGenerationRequest);
    const hints = input.MODEL_SOURCE_HINTS_JSON;
    assert.equal(hints?.profile, "model-source-hints/v1"); assert.equal(hints?.advisoryOnly, true); assert.equal(hints?.scope, "primary-connection-only");
    assert.equal(hints?.sources?.length, QA_SCALE_TOOL_COUNT, "Pi did not receive the full 128-tool reviewed catalog");
    const expected = new Set(qaScaleReadResources.map(resource => resource.name));
    assert(hints.sources.every(source => expected.delete(source.action) && source.connectionId === "erpbridge-default" && source.review === "REVIEWED" && source.dataClass === "internal"),
      "Pi source hints were missing reviewed policy evidence");
    assert.equal(expected.size, 0); evidence.sourceHints = hints.sources.length;
    return { choices: [{ message: { content: stringify(qaScaleWorkflowBlueprint()) } }], usage: { prompt_tokens: 128, completion_tokens: QA_SCALE_WORKFLOW_STEPS } };
  }
  if (system.includes("ONE SELECTED NODE PATCH")) {
    evidence.nodePatches += 1;
    return { choices: [{ message: { content: '{"description":"Pi-reviewed midpoint ERP read for the large catalog"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }
  throw new Error("Outside literal synthetic scale-model fixture scope");
}

export async function qualifyNativeScaleTools({ request, open, config }) {
  const started = Date.now();
  const expect = async (path, method, payload, status = 200) => {
    const response = await request("api", path, method, payload); assert.equal(response.status, status, response.body); return response.data.data;
  };
  const status = await expect("/api/settings/mcp-connections", "GET"), connection = status.connections[0];
  assert.equal(connection.id, "erpbridge-default");
  await expect(`/api/settings/mcp-connections/${connection.id}/connect`, "POST", { baseRevision: connection.revision, requestId: "native_scale_connect_0001" });
  const discovery = await expect("/api/registry/capabilities/discovery", "POST", {});
  assert.equal(discovery.observations.length, QA_SCALE_TOOL_COUNT);
  for (const [index, resource] of qaScaleReadResources.entries()) {
    const observation = discovery.observations.find(value => value.definition.name === resource.name); assert(observation, `Missing discovery for ${resource.name}`);
    await expect(`/api/registry/capabilities/${observation.capabilityId}/review`, "POST", { observationId: observation.id, contractHash: observation.contractHash,
      decisionKey: `native_scale_review_${String(index + 1).padStart(3, "0")}`, effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never",
      note: `Explicit local scale fixture ${resource.ordinal}; MockERP GET only` });
    if ((index + 1) % 32 === 0) console.log(`SCALE_REVIEW_CHECKPOINT ${index + 1}/${QA_SCALE_TOOL_COUNT}`);
  }
  const catalogIds = new Set(); let offset = 0, pages = 0;
  do {
    const page = await expect(`/api/registry/capabilities?offset=${offset}&limit=10`, "GET");
    assert.equal(page.offset, offset); assert.equal(page.limit, 10); assert(page.capabilities.length <= 10);
    for (const entry of page.capabilities) { assert.equal(entry.effectiveState, "AVAILABLE"); assert(!catalogIds.has(entry.capabilityId)); catalogIds.add(entry.capabilityId); }
    pages += 1; if (!page.hasMoreCapabilities) break; offset += page.capabilities.length;
  } while (pages <= 20);
  assert.equal(catalogIds.size, QA_SCALE_TOOL_COUNT); assert.equal(pages, 13);

  const modelEvidence = { sourceHints: 0, nodePatches: 0, chatAdmissionMs: [], progressReadMs: [], runAdmissionMs: 0 };
  const fixture = await startNativeModelFixture(config, { responseFor: body => scaleModelResponse(body, modelEvidence) });
  try {
    const provider = await expect("/api/providers", "POST", { name: "LOCAL 128-tool Pi fixture", type: "openai_compatible", baseUrl: fixture.baseUrl, apiKey: fixture.apiKey,
      model: nativeModelIds[0], additionalModels: [nativeModelIds[1]], temperature: 0,
      egressPolicy: { approvedOrigin: new URL(fixture.baseUrl).origin, confirmed: true, interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: ["internal"], runtimeAgentDataClasses: ["internal"] } }, 201);
    assert.equal((await expect(`/api/providers/${provider.id}/test`, "POST", {})).ok, true);
    await expect(`/api/providers/${provider.id}/activate`, "POST", {});
    const chat = await expect("/api/chat/sessions", "POST", { title: "LOCAL 128-tool Pi generation", idempotencyKey: "native-scale-chat-create-0001" }, 201);
    const send = async (content, key, model, nodeContext) => {
      const payload = { content, delivery: "async-chat", idempotencyKey: key, model, ...(nodeContext ? { nodeContext } : {}) };
      const admissionStarted = performance.now();
      const admitted = await expect(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
      modelEvidence.chatAdmissionMs.push(Math.round(performance.now() - admissionStarted));
      assert.equal(admitted.taskDispatch, "ENQUEUED");
      assert(modelEvidence.chatAdmissionMs.at(-1) < 15_000, "Async chat admission blocked too long before returning its durable operation identity");
      let operation; const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const progressStarted = performance.now();
        operation = (await expect(`/api/chat/operations/${admitted.operation.id}?waitMs=25000`, "GET")).operation;
        const progressReadMs = Math.round(performance.now() - progressStarted);
        modelEvidence.progressReadMs.push(progressReadMs);
        assert(progressReadMs < 35_000, "Bounded chat progress read exceeded its client-safe response budget");
        if (!["QUEUED", "RUNNING"].includes(operation.status)) break;
      }
      assert.equal(operation?.status, "ANSWERED", JSON.stringify({ status: operation?.status, failure: operation?.failure }));
      const saved = await expect(`/api/chat/sessions/${chat.id}`, "GET"), message = saved.messages.find(value => value.id === operation.assistantMessageId); assert(message);
      const modelCalls = fixture.calls.length, replay = await expect(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
      assert.equal(replay.operation.id, operation.id); assert.equal(fixture.calls.length, modelCalls);
      const repository = await open(); let command;
      try { command = await repository.readAuthoritative(state => ({ profile: "chat-task-delivery/v1", operationId: operation.id, taskId: assertChatTaskOutbox(state.chatOperations[operation.id]).taskId })); }
      finally { await repository.close(); }
      assert.equal((await request("executeChatTask", "", "POST", { data: command }, false)).status, 204); assert.equal(fixture.calls.length, modelCalls);
      return message;
    };
    const generated = await send(scaleGenerationRequest, "native-scale-generate-0001", nativeModelIds[0]);
    const workflowId = generated.artifacts.workflowId; assert(workflowId); assert.equal(modelEvidence.sourceHints, QA_SCALE_TOOL_COUNT);
    const source = await expect(`/api/workflows/${workflowId}/yaml`, "GET"), blueprint = parse(source.yaml);
    assert.equal(blueprint.steps.length, QA_SCALE_WORKFLOW_STEPS); assert.equal(new Set(blueprint.steps.map(step => step.action)).size, QA_SCALE_WORKFLOW_STEPS);
    const readiness = await expect(`/api/workflows/${workflowId}/readiness`, "GET"); assert.equal(readiness.validation.passed, true); assert.equal(readiness.can_attempt_run, false);
    const midpoint = qaScaleReadResources[50];
    const proposalMessage = await send("Describe the selected midpoint read more clearly.", "native-scale-node-edit-0001", nativeModelIds[1],
      { workflowId, nodeId: midpoint.id, baseVersion: readiness.version, baseHash: readiness.contentHash });
    const proposal = proposalMessage.artifacts.proposal; assert.equal(proposal.status, "PROPOSED"); assert.equal(modelEvidence.nodePatches, 1);
    assert.equal((await expect(`/api/workflows/${workflowId}/yaml`, "GET")).yaml, source.yaml, "Pi proposal silently changed the draft");
    await expect(`/api/workflows/${workflowId}/commands`, "POST", { baseVersion: readiness.version, baseHash: readiness.contentHash, proposalId: proposal.id, command: proposal.command });
    const edited = await expect(`/api/workflows/${workflowId}/yaml`, "GET"), editedBlueprint = parse(edited.yaml);
    assert.equal(editedBlueprint.steps.find(step => step.id === midpoint.id).description, "Pi-reviewed midpoint ERP read for the large catalog");
    await expect(`/api/workflows/${workflowId}/publish`, "POST", {});

    const runCommand = { mode: "async-read", idempotencyKey: "native-scale-read-0001", input: {} };
    const runAdmissionStarted = performance.now();
    const admitted = await expect(`/api/workflows/${workflowId}/run`, "POST", runCommand, 202);
    modelEvidence.runAdmissionMs = Math.round(performance.now() - runAdmissionStarted);
    assert(modelEvidence.runAdmissionMs < 15_000, "Async workflow admission blocked too long before returning its durable execution identity");
    let terminal;
    const deadline = Date.now() + 900_000;
    while (Date.now() < deadline) {
      const response = await request("api", `/api/executions/${admitted.id}`, "GET");
      if (response.status === 200) { terminal = response.data.data; if (!["PENDING", "RUNNING"].includes(terminal.status)) break; }
      else { assert.equal(response.status, 503, response.body); assert.equal(response.data.meta.code, "FUNCTIONS_INVOCATION_UNCONFIRMED"); }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(terminal?.status, "DONE", JSON.stringify({ status: terminal?.status, failure: terminal?.failure }));
    const outputIds = Object.keys(terminal.stepOutputs).filter(id => id !== "input"); assert.equal(outputIds.length, QA_SCALE_WORKFLOW_STEPS);
    assert(outputIds.every(id => Array.isArray(terminal.stepOutputs[id]?.structuredContent?.data)));
    const repository = await open(); let before;
    try { before = await repository.readAuthoritative(state => ({ run: structuredClone(state.executions[admitted.id]), job: structuredClone(state.readJobs[admitted.id]),
      timeline: structuredClone(state.timelines[admitted.id]), events: structuredClone(state.executionEvents[admitted.id]), executions: Object.keys(state.executions).length })); }
    finally { await repository.close(); }
    assert.equal(before.timeline.length, QA_SCALE_WORKFLOW_STEPS); assert(before.timeline.every(entry => entry.status === "DONE"));
    const outbox = assertReadTaskOutbox(before.job);
    assert.equal((await request("executeReadTask", "", "POST", { data: { profile: "read-task-delivery/v1", executionId: admitted.id, taskId: outbox.taskId } }, false)).status, 204);
    assert.equal((await expect(`/api/workflows/${workflowId}/run`, "POST", runCommand, 202)).id, admitted.id);
    const afterRepository = await open();
    try { await afterRepository.readAuthoritative(state => { assert.deepEqual(state.timelines[admitted.id], before.timeline); assert.deepEqual(state.executionEvents[admitted.id], before.events); assert.equal(Object.keys(state.executions).length, before.executions); }); }
    finally { await afterRepository.close(); }
    const stableRepository = await open(); let stableImage;
    try { stableImage = await stableRepository.snapshot(); } finally { await stableRepository.close(); }
    await Promise.all([
      expect(`/api/chat/sessions/${chat.id}`, "GET"), expect(`/api/workflows/${workflowId}`, "GET"),
      expect(`/api/workflows/${workflowId}/yaml`, "GET"), expect(`/api/executions/${admitted.id}`, "GET"),
      expect(`/api/executions/${admitted.id}/timeline`, "GET"), expect(`/api/executions/${admitted.id}/events?after=0&limit=100`, "GET"),
    ]);
    const readbackRepository = await open();
    try { assert.deepEqual(await readbackRepository.snapshot(), stableImage, "Firebase progress/workflow GETs mutated the committed Firestore image"); }
    finally { await readbackRepository.close(); }
    const invalid = { ...qaScaleWorkflowBlueprint(), name: "LOCAL invalid scale workflow", steps: [{ id: "unknown", action: "qa_scale_unknown_tool", parameters: {} }] };
    assert.equal((await request("api", "/api/workflows", "POST", { yaml: stringify(invalid) })).status, 422);
    console.log("PASS: Pi received 128 reviewed source hints, generated 101 distinct ERP steps, proposed one revision-bound edit, and required explicit Apply/publish/run.");
    console.log(`PASS: Firebase queued run completed 101/101 Docker ERPBridge reads with 101 saved outputs/timeline entries in ${Date.now() - started} ms; catalog pagination was 13 pages.`);
    console.log(`PASS: Firebase read/write latency bounds held: chat admissions ${modelEvidence.chatAdmissionMs.join("/")} ms, maximum bounded progress read ${Math.max(...modelEvidence.progressReadMs)} ms, run admission ${modelEvidence.runAdmissionMs} ms; post-run GETs left committed Firestore state unchanged.`);
    console.log("PASS: duplicate chat/task/run delivery was idempotent and an unknown tool was rejected before execution.");
    return { workflowId, executionId: admitted.id, chatId: chat.id, catalogSize: QA_SCALE_TOOL_COUNT, workflowSteps: QA_SCALE_WORKFLOW_STEPS };
  } finally { await fixture.close(); }
}
