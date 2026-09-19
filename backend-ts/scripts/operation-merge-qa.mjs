// LOCAL run-only Docker qualification; synthetic ERP/model data, no effects.
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { createQaWorkspace, qaModelDecisionBlueprint, qaModelReadBlueprint, qaPlanningResponse } from "./erpbridge-workspace-qa.mjs";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { buildApp } from "../src/http/app.js";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--qualify-docker-merges", "--serve-docker-merges"].includes(mode)) throw new Error("Choose explicit isolated Docker-merge qualification or serve mode");
const workspace = await createQaWorkspace({ modelReadFixture: true });
let app, modelCalls = 0;
const mergedInputs = [], instruction = "LOCAL return the exact selected merged count without an ERP read";
try {
  await workspace.app.close();
  const provider = new ProviderRuntime(workspace.repository, workspace.services.executor, async (url, init) => {
    assert.equal(url, "https://fixture.invalid/v1/chat/completions"); const request = JSON.parse(String(init.body)); modelCalls++;
    const user = JSON.parse(request.messages.findLast(message => message.role === "user").content);
    if (user.INSTRUCTION === instruction) {
      assert(Number.isSafeInteger(user.INPUT) && user.INPUT >= 0); mergedInputs.push(user.INPUT);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ departmentCount: user.INPUT }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    return Response.json(qaPlanningResponse(request, true));
  });
  provider.activate({ ...workspace.services.providerRuntime.configuration, egressPolicy: { ...workspace.services.providerRuntime.configuration.egressPolicy,
    runtimeAnalysisDataClasses: ["restricted"], runtimeAgentDataClasses: ["restricted"] } });
  workspace.services.providerRuntime = provider;
  workspace.services.config.corsOrigins = ["http://127.0.0.1:5180", "http://localhost:5180"];
  await workspace.repository.mutate(state => {
    for (const kind of ["analysis", "agent"]) {
      const source = qaModelDecisionBlueprint(kind), gate = source.metadata.controlFlow.root.nodes[1]; source.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
      source.name = `LOCAL Docker ${kind} typed branch handoff`;
      gate.merge = { schema: { type: "integer" }, then: { kind: "ref", source: "nodeOutput", nodeId: "count", path: ["structuredContent", "departmentCount"] }, else: { kind: "literal", value: 0 } };
      const followup = { ...qaModelReadBlueprint("analysis").steps[1], id: "followup", description: "LOCAL exact merged count handoff", instruction, input: "{{include_count.value}}", data_class: "restricted" };
      source.steps.push(followup); source.metadata.controlFlow.root.nodes.push({ kind: "action", nodeId: "followup" }, { kind: "return", id: "answer", output: { schema: { type: "integer" },
        value: { kind: "ref", source: "nodeOutput", nodeId: "followup", path: ["structuredContent", "departmentCount"] } } });
      const yaml = stringify(source), id = `qa_merge_${kind}`;
      state.workflows[id] = { ...state.workflows.qa_departments, id, yaml, name: source.name, steps: source.steps.length };
      state.versions[id] = [{ version: 1, artifactState: "DRAFT", yaml }];
      state.chats.qa_chat.messages.push({ id: `chat_${id}`, role: "assistant", text: "LOCAL QA: synthetic Docker Department read and in-process model fixtures only. Both Yes and No paths expose a typed count to a later analysis, then Return. Review, publish and run explicitly. No business effects or real inference.", createdAt: new Date().toISOString(),
        artifacts: { intent: "WORKFLOW", workflowId: id, yaml, validation_passed: true, can_execute: false } });
    }
    state.chats.qa_chat.messageCount = state.chats.qa_chat.messages.length;
  });
  app = await buildApp(workspace.services);
  if (mode === "--serve-docker-merges") {
    await app.listen({ host: "127.0.0.1", port: 8088 });
    console.log("LOCAL Docker merge QA at 127.0.0.1:8088; qa@example.test / Local-QA-only-2026!; memory only, synthetic data/models, no effects");
    let stopping; for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping ??= (async () => { await app.close(); await workspace.close(); })(); });
  } else {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } }); assert.equal(login.statusCode, 200);
    const headers = { authorization: `Bearer ${login.json().data.accessToken}` }, request = async (method, url, payload, status = 200) => {
      const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) }); assert.equal(response.statusCode, status, response.body); return response.json().data;
    };
    for (const kind of ["analysis", "agent"]) {
      const workflowId = `qa_merge_${kind}`;
      const readiness = await request("GET", `/api/workflows/${workflowId}/readiness`); assert.equal(readiness.authoring.mergeNodesSupported, true);
      assert(readiness.authoring.nodes.find(node => node.nodeId === "followup").dataSources.some(source => source.expression === "{{include_count.value}}"));
      assert.equal((await request("POST", `/api/workflows/${workflowId}/publish`, {})).compiledOperation.schemaVersion, "workflow-operation-ir/v7");
      for (const selected of [true, false]) {
        const beforeModels = modelCalls, beforeInputs = mergedInputs.length, command = { mode: "async-operation", input: { includeCount: selected }, idempotencyKey: `docker-merge-${kind}-${selected}-0001` };
        const id = (await request("POST", `/api/workflows/${workflowId}/run`, command, 202)).id;
        let run; const deadline = Date.now() + 15000;
        do { run = (await workspace.repository.snapshot()).executions[id]; if (!["PENDING", "RUNNING"].includes(run.status)) break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
        assert.equal(run.status, "DONE", JSON.stringify(run.failure ?? run.agentSummary));
        const expected = selected ? run.stepOutputs.departments.structuredContent.data.length : 0;
        assert.deepEqual(run.valueOutputs, { include_count: { value: expected }, answer: { value: expected } }); assert.equal(run.finalOutput, expected);
        assert.deepEqual(run.stepOutputs.followup, { structuredContent: { departmentCount: expected } }); assert.equal(run.runtimeApprovalSecret, undefined);
        assert.equal(modelCalls, beforeModels + (selected ? kind === "agent" ? 3 : 2 : 1)); assert.deepEqual(mergedInputs.slice(beforeInputs), [expected]);
        if (!selected) { assert.equal(run.stepOutputs.count, undefined); assert.equal(run.readProgress.attempts.count.status, "SKIPPED"); }
        const events = (await workspace.repository.snapshot()).executionEvents[id]; assert.equal((await request("POST", `/api/workflows/${workflowId}/run`, command, 202)).id, id);
        assert.deepEqual((await workspace.repository.snapshot()).executionEvents[id], events); assert.equal(modelCalls, beforeModels + (selected ? kind === "agent" ? 3 : 2 : 1));
        console.log(`PASS Docker ${kind}/${selected ? "Yes" : "No"}: actual synthetic read, v7 typed branch output, exact subsequent analysis/Return, original-key replay; in-process models, no effects`);
      }
    }
  }
} finally { if (mode !== "--serve-docker-merges" || !app?.server.listening) { await app?.close(); await workspace.close(); } }
