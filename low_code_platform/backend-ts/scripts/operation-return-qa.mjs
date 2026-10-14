// Local run-only qualification against the unchanged Docker bridge. Data and
// model behavior are explicitly synthetic. No effects or bridge file writes.
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { createQaWorkspace, qaModelReadBlueprint } from "./erpbridge-workspace-qa.mjs";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--qualify-docker-returns", "--serve-docker-returns"].includes(mode)) throw new Error("Choose explicit local Docker-return qualification or serve mode");
const workspace = await createQaWorkspace({ modelReadFixture: true });
const action = nodeId => ({ kind: "action", nodeId }), seq = (...nodes) => ({ kind: "sequence", nodes });
function source(kind, selected) {
  const source = qaModelReadBlueprint(kind);
  source.name = `LOCAL Docker ${kind} typed return · ${selected ? "Yes" : "No"}`;
  source.steps.push({ ...structuredClone(source.steps[0]), id: "tail", description: "Must not run after return" });
  source.metadata = { controlFlow: { schemaVersion: "read-control-flow/v2", root: seq(action("departments"),
    { kind: "if", id: "include_count", predicate: { kind: "literal", value: selected }, then: seq(action("count"),
      { kind: "return", id: "answer", output: { schema: { type: "integer" }, value: { kind: "ref", source: "nodeOutput", nodeId: "count", path: ["structuredContent", "departmentCount"] } } }),
      else: seq({ kind: "return", id: "no_count", output: { schema: { type: "string" }, value: { kind: "literal", value: "Count was not requested" } } }) }, action("tail")) } };
  return source;
}
try {
  await workspace.repository.mutate(state => {
    for (const kind of ["analysis", "agent"]) for (const selected of [true, false]) {
      const value = source(kind, selected), yaml = stringify(value), id = `qa_return_${kind}_${selected ? "yes" : "no"}`;
      state.workflows[id] = { ...state.workflows.qa_departments, id, yaml, name: value.name, steps: value.steps.length };
      state.versions[id] = [{ version: 1, artifactState: "DRAFT", yaml }];
      state.chats.qa_chat.messages.push({ id: `chat_${id}`, role: "assistant", text: "LOCAL Docker synthetic read and in-process model fixture only. Review, publish and run explicitly. Typed return stops later nodes; no production data or effects are supported.", createdAt: new Date().toISOString(),
        artifacts: { intent: "WORKFLOW", workflowId: id, yaml, validation_passed: true, can_execute: false } });
    }
    state.chats.qa_chat.messageCount = state.chats.qa_chat.messages.length;
  });
  if (mode === "--serve-docker-returns") {
    await workspace.app.listen({ host: "127.0.0.1", port: 8086 });
    console.log("LOCAL Docker return QA at 127.0.0.1:8086; qa@example.test / Local-QA-only-2026!; memory only, synthetic data/models, no effects");
    let stopping;
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping ??= workspace.close(); });
  } else {
    const login = await workspace.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } });
    assert.equal(login.statusCode, 200); const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
    const request = (method, url, payload) => workspace.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    for (const kind of ["analysis", "agent"]) for (const selected of [true, false]) {
      const id = `qa_return_${kind}_${selected ? "yes" : "no"}`, publication = await request("POST", `/api/workflows/${id}/publish`, {});
      assert.equal(publication.statusCode, 200, publication.body); assert.equal(publication.json().data.compiledOperation.schemaVersion, "workflow-operation-ir/v6");
      const key = `docker-return-${kind}-${selected}-0001`, payload = { mode: "async-operation", idempotencyKey: key, input: {} };
      const admission = await request("POST", `/api/workflows/${id}/run`, payload); assert.equal(admission.statusCode, 202, admission.body);
      const runId = admission.json().data.id;
      let snapshot, run;
      for (let attempt = 0; attempt < 120; attempt++) {
        snapshot = await workspace.repository.snapshot(); run = snapshot.executions[runId];
        if (["DONE", "FAILED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED"].includes(run.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(run.status, "DONE", JSON.stringify(run.failure ?? run.agentSummary));
      const rows = run.stepOutputs.departments.structuredContent.data;
      assert(Array.isArray(rows) && rows.length > 0); assert.equal(run.finalOutput, selected ? rows.length : "Count was not requested");
      assert.deepEqual(run.valueOutputs, selected ? { answer: { value: rows.length } } : { no_count: { value: "Count was not requested" } });
      assert.equal(run.readProgress.attempts.tail.status, "SKIPPED"); assert.equal(run.stepOutputs.tail, undefined); assert.equal(run.operationSecret.intents.tail, undefined);
      assert.equal(run.stepOutputs.count !== undefined, selected); assert.equal(run.runtimeApprovalSecret, undefined);
      assert.equal(snapshot.timelines[runId].find(entry => entry.nodeId === "tail").outcome, "AFTER_RETURN");
      const replay = await request("POST", `/api/workflows/${id}/run`, payload); assert.equal(replay.statusCode, 202, replay.body); assert.equal(replay.json().data.id, runId);
      const after = await workspace.repository.snapshot(); assert.deepEqual(after.executions[runId], run); assert.deepEqual(after.executionEvents[runId], snapshot.executionEvents[runId]);
      console.log(`PASS actual Docker synthetic ${kind}/${selected ? "Yes" : "No"}: typed answer, acknowledged return, no tail dispatch, original-key replay`);
    }
    await workspace.close();
  }
} catch (error) { await workspace.close(); throw error; }
