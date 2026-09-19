// Application-only qualification. Uses the existing Docker synthetic read;
// never writes ERP data or edits/rebuilds the bridge, resources or containers.
import assert from "node:assert/strict";
import { stringify, parse } from "yaml";
import { createQaWorkspace } from "./erpbridge-workspace-qa.mjs";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { buildApp } from "../src/http/app.js";

if (process.argv.length !== 3 || process.argv[2] !== "--run-reviewed-named-inputs") throw new Error("Use --run-reviewed-named-inputs against the already-running isolated Docker stack");
const workspace = await createQaWorkspace({ modelReadFixture: true });
let app, fixture, modelCalls = 0;
try {
  await workspace.app.close();
  const provider = new ProviderRuntime(workspace.repository, workspace.services.executor, async (url, init) => {
    assert.equal(url, "https://fixture.invalid/v1/chat/completions");
    const request = JSON.parse(String(init.body)), system = request.messages[0]?.content;
    if (system.includes("TASK: WORKFLOW DRAFT SYNTHESIS")) {
      assert(system.includes("prompt/candidate/v15"));
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: stringify(fixture) } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
    }
    modelCalls++;
    const data = JSON.parse(request.messages[1].content);
    assert(Array.isArray(data.INPUT?.first)); assert(Array.isArray(data.INPUT?.second));
    assert.equal(data.INPUT.first.length, 8); assert.equal(data.INPUT.second.length, 8);
    const agent = system.includes("TASK: BOUNDED RUNTIME ERP AGENT"), last = request.messages.at(-1);
    if (agent && last.role !== "tool") return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null,
      tool_calls: [{ id: "named-department-confirm", type: "function", function: { name: "qa_list_departments.rev_MS4wLjA", arguments: "{}" } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    if (agent) {
      const result = JSON.parse(last.content); assert.equal(result.source, "untrusted_tool_result"); assert.equal(result.status, "SUCCEEDED");
      assert.equal(result.data.structuredContent.data.length, 8);
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ firstCount: data.INPUT.first.length,
      secondCount: data.INPUT.second.length, ...(agent ? { complete: true } : {}) }) } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  });
  provider.activate({ ...workspace.services.providerRuntime.configuration, egressPolicy: { ...workspace.services.providerRuntime.configuration.egressPolicy,
    runtimeAnalysisDataClasses: ["restricted"], runtimeAgentDataClasses: ["restricted"] } });
  workspace.services.providerRuntime = provider;
  workspace.services.synthesis = new SynthesisService(provider, workspace.services.registries, workspace.services.validator);
  app = await buildApp(workspace.services);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } }); assert.equal(login.statusCode, 200);
  const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
  const request = async (method, url, payload, expected = 200) => {
    const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, expected, `Application ${method} ${url} status ${response.statusCode}`); return response.json().data;
  };
  const sequence = (...nodes) => ({ kind: "sequence", nodes }), action = nodeId => ({ kind: "action", nodeId });
  for (const kind of ["analysis", "agent"]) for (const local of [false, true]) for (const selected of [true, false]) {
    const model = { id: "compare", kind, description: "Compare two acknowledged synthetic reads", instruction: "Count both named Department arrays without guessing or executing effects",
      input: { first: "{{first.structuredContent.data}}", second: "{{second.structuredContent.data}}" }, data_class: "restricted", model: "local-planning-fixture",
      max_input_items: 100, max_input_chars: 20000, max_output_tokens: 256, output_schema: { type: "object", properties: { firstCount: { type: "integer" }, secondCount: { type: "integer" },
        ...(kind === "agent" ? { complete: { type: "boolean" } } : {}) }, required: ["firstCount", "secondCount", ...(kind === "agent" ? ["complete"] : [])], additionalProperties: false },
      ...(kind === "agent" ? { allowed_actions: ["qa_list_departments"], completion_predicate: { path: ["complete"], equals: true }, max_total_tokens: 1024, max_rounds: 2,
        max_tool_calls: 1, max_wall_time_ms: 10000, max_concurrency: 1 } : {}) };
    const reads = ["first", "second"].map(id => ({ id, action: "qa_list_departments", description: `Actual synthetic ${id} read`, parameters: {} }));
    const gate = { kind: "if", id: "compareGate", predicate: { kind: "ref", source: "workflowInput", path: ["compare"] },
      then: sequence(...(local ? reads.map(read => action(read.id)) : []), action("compare")), else: sequence() };
    // Predicate input name may match a model ID, but the sources remain distinct.
    fixture = { name: `Named ${kind} Docker qualification`, description: "Local model fixture and actual synthetic reads, not business delivery or real inference",
      trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { compare: { type: "boolean" } }, required: ["compare"], additionalProperties: false } } },
      steps: [...reads, model], metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: sequence(...(local ? [] : reads.map(read => action(read.id))), gate) } } };
    const chat = await request("POST", "/api/chat/sessions", {}, 201), before = modelCalls;
    const answer = await request("POST", `/api/chat/sessions/${chat.id}/messages`, { content: `Create a workflow comparing two confirmed synthetic Department reads with a bounded ${kind}.` });
    const id = answer.assistantMessage.artifacts.workflowId;
    assert.deepEqual(parse(answer.yaml), fixture); assert.equal(answer.workflowDraft.generation_metadata.promptTemplateVersion, "prompt/candidate/v15");
    assert.equal(modelCalls, before); assert.equal((await request("GET", `/api/chat/sessions/${chat.id}`)).messages.at(-1).artifacts.workflowId, id);
    const ready = await request("GET", `/api/workflows/${id}/readiness`);
    const edited = await request("POST", `/api/workflows/${id}/commands`, { baseVersion: ready.version, baseHash: ready.contentHash,
      command: { type: kind === "analysis" ? "updateAnalysis" : "updateAgent", nodeId: "compare", patch: { input: { previous: model.input.first, current: model.input.second } } } });
    // Explicitly restore named intent to prove both edit/save forms preserve it.
    await request("POST", `/api/workflows/${id}/commands`, { baseVersion: edited.version, baseHash: edited.contentHash,
      command: { type: kind === "analysis" ? "updateAnalysis" : "updateAgent", nodeId: "compare", patch: { input: model.input } } });
    const publication = await request("POST", `/api/workflows/${id}/publish`, {}); assert.equal(publication.compiledOperation.schemaVersion, "workflow-operation-ir/v5");
    const command = { mode: "async-operation", idempotencyKey: `named-${kind}-${local}-${selected}-0001`, input: { compare: selected } };
    const run = await request("POST", `/api/workflows/${id}/run`, command, 202);
    const deadline = Date.now() + 15000; let saved;
    do { saved = await request("GET", `/api/executions/${run.id}`); if (!["PENDING", "RUNNING"].includes(saved.status)) break; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
    assert.equal(saved.status, "DONE", `Named ${kind} did not complete`); assert.equal(modelCalls, before + (selected ? kind === "agent" ? 2 : 1 : 0));
    if (selected) {
      assert.equal(saved.stepOutputs.first.structuredContent.data.length, 8); assert.equal(saved.stepOutputs.second.structuredContent.data.length, 8);
      assert.deepEqual(saved.stepOutputs.compare.structuredContent, { firstCount: 8, secondCount: 8, ...(kind === "agent" ? { complete: true } : {}) });
    } else { assert.equal(saved.stepOutputs.compare, undefined); if (local) { assert.equal(saved.stepOutputs.first, undefined); assert.equal(saved.stepOutputs.second, undefined); } }
    const journal = await workspace.repository.read(state => state.executionEvents[run.id]);
    assert.equal((await request("POST", `/api/workflows/${id}/run`, command, 202)).id, run.id);
    assert.deepEqual(await workspace.repository.read(state => state.executionEvents[run.id]), journal);
    assert.equal(modelCalls, before + (selected ? kind === "agent" ? 2 : 1 : 0));
    console.log(`PASS named ${kind}, ${local ? "branch-local" : "root"} sources, ${selected ? "Yes" : "No"} path; actual Docker reads and local fixture only`);
  }
} finally { await app?.close(); await workspace.close(); }
