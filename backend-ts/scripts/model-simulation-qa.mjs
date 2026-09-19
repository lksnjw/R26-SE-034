// LOCAL disposable UI/API fixture qualification. No bridge files are changed.
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { createQaWorkspace, qaModelReadBlueprint } from "./erpbridge-workspace-qa.mjs";
import { workflowContentHash } from "../src/parser/workflow.ts";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--qualify-no-live-model-fixtures", "--serve-no-live-model-fixtures"].includes(mode))
  throw new Error("Choose the explicit disposable model-fixture qualification or local serve flag");
const workspace = await createQaWorkspace({ modelReadFixture: true });
let entered = 0;
const forbidden = () => { entered++; throw new Error("Fixture simulation attempted a live model or MCP entry"); };
const actualSession = workspace.services.erpbridgeSession;
Object.defineProperty(workspace.services, "erpbridgeSession", { configurable: true, get: () => ({ ...actualSession, listTools: forbidden, callToolDirect: forbidden, clientFor: forbidden, assertAdmission: forbidden }) });
workspace.services.providerRuntime.generate = forbidden;
workspace.services.providerRuntime.queryWithTools = forbidden;
workspace.services.providerRuntime.generateCandidate = forbidden;
await workspace.repository.mutate(state => {
  for (const kind of ["analysis", "agent"]) {
    const source = qaModelReadBlueprint(kind);
    source.name = `LOCAL supplied ${kind} answers · no live calls`;
    source.steps[1].input = { first: "{{departments.structuredContent.data}}", second: "{{departments.structuredContent.data}}" };
    source.steps[1].instruction = "Use the supplied named report data; actual model behavior is not tested by simulation.";
    const yaml = stringify(source), id = `qa_model_sim_${kind}`;
    state.workflows[id] = { ...state.workflows.qa_departments, id, yaml, name: source.name, steps: 2 };
    state.versions[id] = [{ version: 1, artifactState: "DRAFT", yaml }];
    state.chats.qa_chat.messages.push({ id: `sim_chat_${kind}`, role: "assistant", text: "LOCAL fixture simulation only. Open this draft and supply test fields. Model/ERP calls, agent tools, approval and real execution are prohibited in this QA profile.", createdAt: new Date().toISOString(),
      artifacts: { intent: "WORKFLOW", workflowId: id, yaml, validation_passed: true, can_execute: false } });
  }
  state.chats.qa_chat.messageCount = state.chats.qa_chat.messages.length;
});
try {
  if (mode === "--serve-no-live-model-fixtures") {
    await workspace.app.listen({ host: "127.0.0.1", port: 8084 });
    console.log("LOCAL supplied-model QA 127.0.0.1:8084; memory only; qa@example.test / Local-QA-only-2026!; no live dispatch supported");
    let stopping;
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping ??= workspace.close(); });
  } else {
    const login = await workspace.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } });
    assert.equal(login.statusCode, 200);
    const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
    for (const kind of ["analysis", "agent"]) for (const include of [true, false]) {
      const id = `qa_model_sim_${kind}`, original = (await workspace.repository.snapshot()).workflows[id], source = qaModelReadBlueprint(kind);
      source.steps[1].input = { first: "{{departments.structuredContent.data}}", second: "{{departments.structuredContent.data}}" };
      source.metadata = { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "action", nodeId: "departments" },
        { kind: "if", id: "include", predicate: { kind: "literal", value: include }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "count" }] }, else: { kind: "sequence", nodes: [] } }] } } };
      const yaml = stringify(source);
      await workspace.repository.mutate(state => { state.workflows[id] = { ...original, yaml }; });
      const before = await workspace.repository.snapshot();
      const reply = await workspace.app.inject({ method: "POST", url: `/api/workflows/${id}/run`, headers, payload: { dryRun: true, input: {}, simulation: {
        profile: "model-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: {
          departments: { content: [], structuredContent: { data: [{ Id: "supplied", Name: "Test Department" }] } },
          count: { structuredContent: { departmentCount: 1, ...(kind === "agent" ? { complete: true } : {}) } },
        },
      } } });
      assert.equal(reply.statusCode, 200, reply.body); const result = reply.json().data;
      assert.equal(result.outcome, "SIMULATED_COMPLETE"); assert.equal(result.simulation, "fixture-model/v1");
      assert.equal(result.erp_calls, 0); assert.equal(result.model_calls, 0); assert.equal(result.can_execute, false); assert.equal(result.persisted_run, false);
      assert.equal(result.model_behavior, "not_tested"); assert.equal(result.agent_tool_calls, "not_simulated");
      assert.equal(result.stepOutputs.count !== undefined, include);
      assert.equal(entered, 0); const after = await workspace.repository.snapshot();
      for (const key of ["workflows", "versions", "executions", "timelines", "executionEvents", "invocationProvenance"]) assert.deepEqual(after[key], before[key]);
      console.log(`PASS local connected-Docker ${kind}/select-${include ? "Yes" : "No"}: named fixtures, zero MCP/model entry, no approval/run/publication`);
    }
    await workspace.close();
  }
} catch (error) { await workspace.close(); throw error; }
