// Application-only normal chat/draft/publication/run proof. Actual unchanged
// Docker MCP + synthetic ERP data; explicitly injected models, never effects.
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { createQaWorkspace, qaModelDecisionBlueprint, qaPlanningResponse } from "./erpbridge-workspace-qa.mjs";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { buildApp } from "../src/http/app.js";
import { generationPromptHash, CALENDAR_RETURN_CANDIDATE_SYSTEM_PROMPT } from "../src/prompts/contracts.js";

if (process.argv.length !== 3 || process.argv[2] !== "--run-reviewed-return-synthesis") throw new Error("Use --run-reviewed-return-synthesis against the already-running isolated Docker QA bridge");
const workspace = await createQaWorkspace({ modelReadFixture: true });
let app, fixture, planningCalls = 0, modelCalls = 0, planningHash;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (reader, label) => {
  const deadline = Date.now() + 15000;
  do { const result = await reader(); if (result) return result; await delay(25); } while (Date.now() < deadline);
  throw new Error(`Local return synthesis did not reach ${label}`);
};
try {
  await workspace.app.close();
  const provider = new ProviderRuntime(workspace.repository, workspace.services.executor, async (url, init) => {
    assert.equal(url, "https://fixture.invalid/v1/chat/completions"); const body = JSON.parse(String(init.body));
    if (body.messages[0].content.includes("TASK: WORKFLOW DRAFT SYNTHESIS")) {
      assert.equal(body.messages[0].content, CALENDAR_RETURN_CANDIDATE_SYSTEM_PROMPT);
      const data = JSON.parse(body.messages[1].content); assert(data.USER_REQUEST.includes("Create a workflow"));
      assert(data.MODEL_SOURCE_HINTS_JSON.advisoryOnly); planningCalls++; planningHash = generationPromptHash(body.messages[1].content, "prompt/candidate/v16");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: stringify(fixture) } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
    }
    modelCalls++; return Response.json(qaPlanningResponse(body, true));
  });
  provider.activate({ ...workspace.services.providerRuntime.configuration, egressPolicy: { ...workspace.services.providerRuntime.configuration.egressPolicy,
    runtimeAnalysisDataClasses: ["restricted"], runtimeAgentDataClasses: ["restricted"] } });
  workspace.services.providerRuntime = provider; workspace.services.synthesis = new SynthesisService(provider, workspace.services.registries, workspace.services.validator);
  app = await buildApp(workspace.services);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } }); assert.equal(login.statusCode, 200);
  const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
  const request = async (method, url, payload, status = 200) => {
    const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) }); assert.equal(response.statusCode, status, `Local ${method} ${url} status ${response.statusCode}`);
    return response.json().data;
  };
  for (const route of ["direct", "chat", "async-chat"]) for (const kind of ["analysis", "agent"]) for (const selected of [true, false]) {
    fixture = qaModelDecisionBlueprint(kind); fixture.name = `LOCAL v16 ${kind} terminal answers`;
    fixture.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
    const gate = fixture.metadata.controlFlow.root.nodes[1];
    gate.then.nodes.push({ kind: "return", id: "answer", output: { schema: { type: "integer" }, value: { kind: "ref", source: "nodeOutput", nodeId: "count", path: ["structuredContent", "departmentCount"] } } });
    gate.else.nodes.push({ kind: "return", id: "not_requested", output: { schema: { type: "string" }, value: { kind: "literal", value: "Count was not requested" } } });
    const initial = await workspace.repository.snapshot(), beforePlanning = planningCalls, beforeModel = modelCalls;
    const prompt = `Create a workflow to read synthetic Departments, and if includeCount is Yes, count them with ${kind} and return the integer; otherwise return Count was not requested. No email.`;
    let workflowId;
    if (route === "direct") {
      const candidate = await request("POST", "/api/synthesis", { prompt }); assert.equal(candidate.validation.passed, true);
      assert.deepEqual(parse(candidate.yaml), fixture); assert.equal(candidate.candidate.generation_metadata.promptTemplateVersion, "prompt/candidate/v16");
      assert.equal(candidate.candidate.generation_metadata.promptSha256, planningHash);
      workflowId = (await request("POST", "/api/workflows", { yaml: candidate.yaml }, 201)).id;
    } else {
      const chat = await request("POST", "/api/chat/sessions", {}, 201);
      const command = { content: prompt, ...(route === "async-chat" ? { delivery: "async-chat", idempotencyKey: `return-chat-${kind}-${selected}-0001` } : {}) };
      const response = await request("POST", `/api/chat/sessions/${chat.id}/messages`, command, route === "async-chat" ? 202 : 200);
      if (route === "async-chat") {
        const id = response.operation.id;
        const operation = await wait(async () => { const value = (await workspace.repository.snapshot()).chatOperations[id]; return !["QUEUED", "RUNNING"].includes(value.status) && value; }, "saved background chat answer");
        assert.equal(operation.status, "ANSWERED"); workflowId = operation.artifactRefs.find(value => value.type === "workflow-draft").id;
        assert.equal((await request("POST", `/api/chat/sessions/${chat.id}/messages`, command, 202)).operation.id, id);
      } else { workflowId = response.assistantMessage.artifacts.workflowId; assert.equal(response.workflowDraft.generation_metadata.promptTemplateVersion, "prompt/candidate/v16"); assert.equal(response.workflowDraft.generation_metadata.promptSha256, planningHash); }
      const reopened = await request("GET", `/api/chat/sessions/${chat.id}`); assert.equal(reopened.messages.at(-1).artifacts.workflowId, workflowId);
      assert(reopened.messages.at(-1).text.includes("has not been published or executed"));
    }
    const draftState = await workspace.repository.snapshot(); assert.deepEqual(parse(draftState.workflows[workflowId].yaml), fixture);
    assert.equal(draftState.workflows[workflowId].publishedVersion, 0); assert.deepEqual(draftState.executions, initial.executions);
    assert.equal(planningCalls, beforePlanning + 1); assert.equal(modelCalls, beforeModel);
    const publication = await request("POST", `/api/workflows/${workflowId}/publish`, {}); assert.equal(publication.compiledOperation.schemaVersion, "workflow-operation-ir/v6");
    const command = { mode: "async-operation", input: { includeCount: selected }, idempotencyKey: `return-run-${route}-${kind}-${selected}-0001` };
    const admitted = await request("POST", `/api/workflows/${workflowId}/run`, command, 202);
    const saved = await wait(async () => { const value = await request("GET", `/api/executions/${admitted.id}`); return !["PENDING", "RUNNING"].includes(value.status) && value; }, "typed answer completion");
    assert.equal(saved.status, "DONE"); const rows = saved.stepOutputs.departments.structuredContent.data; assert(Array.isArray(rows) && rows.length > 0);
    assert.equal(saved.finalOutput, selected ? rows.length : "Count was not requested");
    assert.deepEqual(saved.valueOutputs, selected ? { answer: { value: rows.length } } : { not_requested: { value: "Count was not requested" } });
    assert.equal(saved.pendingApproval, undefined); assert.equal(modelCalls, beforeModel + (selected ? kind === "agent" ? 2 : 1 : 0));
    if (!selected) { assert.equal(saved.stepOutputs.count, undefined); assert.equal(saved.readProgress.attempts.count.status, "SKIPPED"); }
    const events = (await workspace.repository.snapshot()).executionEvents[saved.id];
    assert.equal((await request("POST", `/api/workflows/${workflowId}/run`, command, 202)).id, saved.id);
    assert.deepEqual((await workspace.repository.snapshot()).executionEvents[saved.id], events); assert.equal(modelCalls, beforeModel + (selected ? kind === "agent" ? 2 : 1 : 0));
    console.log(`PASS actual Docker ${route}/${kind}/${selected ? "Yes" : "No"}: v16 exact saved proposal, v6 explicit run, typed answer, original chat/run replay, no effects; synthetic ERP and in-process models only`);
  }
} finally { await app?.close(); await workspace.close(); }
