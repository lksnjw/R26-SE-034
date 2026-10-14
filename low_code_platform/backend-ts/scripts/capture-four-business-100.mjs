// Read-only outcome collection after the browser approval interactions.
// Synthetic QA account and fixed loopback destination only; no decisions.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

const base = "http://127.0.0.1:18083/api";
const path = resolve("../tmp/pipeline-local/four-business-100/evidence.json");
const evidence = JSON.parse(await readFile(path, "utf8"));
const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "qa100_requester@example.test", password: "Workflow-QA-2026!" }), signal: AbortSignal.timeout(30000) });
assert.equal(login.status, 200, "Synthetic requester login failed");
const token = (await login.json()).data.accessToken;
async function data(route) {
  const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, route); return (await response.json()).data;
}
for (const item of evidence.scenarios) {
  const reopened = await data(`/workflows/${item.workflowId}/yaml`);
  const disk = await readFile(resolve("../tmp/pipeline-local/four-business-100", `${item.workflowId}.yaml`), "utf8");
  assert.equal(reopened.yaml, disk); assert.equal(parse(reopened.yaml).steps.length, 100);
  const canvas = await data(`/workflows/${item.workflowId}/canvas`);
  assert.equal(canvas.nodes.length, 100); assert.equal(canvas.edges.length, 99);
  const reused = await data(`/workflows/${item.reusedWorkflowId}/yaml`);
  assert.equal(parse(reused.yaml).steps.length, 100);
  item.reopenedNodes = 100; item.canvasNodes = canvas.nodes.length; item.canvasEdges = canvas.edges.length;
  item.exportMatchesSavedSource = true; item.reusedSourceReopenedNodes = 100;
}
for (const item of evidence.uiRuns) {
  const run = await data(`/executions/${item.executionId}`);
  item.state = run.status;
  item.outputCount = Object.keys(run.stepOutputs ?? {}).length;
  item.completedAt = run.completedAt;
  item.pendingNodeId = run.pendingApproval?.stepId ?? null;
  item.failure = run.failure ?? null;
  item.initialPauseNodeId ??= item.nodeId;
  delete item.nodeId;
  if (run.status === "DONE") assert(Array.from({ length: 100 }, (_, index) => `node_${String(index + 1).padStart(3, "0")}`).every(id => Object.hasOwn(run.stepOutputs, id)), "Completed run is missing an expected node output");
  item.reviewMethod = "Actual frontend exact-review checkbox and Record approval button, separate reviewer account";
  console.log(`${item.workflowId}: ${item.state}, ${item.outputCount} outputs, pending=${item.pendingNodeId ?? "none"}`);
}
evidence.uiCapturedAt = new Date().toISOString();
await writeFile(path, JSON.stringify(evidence, null, 2));
if (process.argv.includes("--require-complete")) {
  assert(evidence.uiRuns.every(run => run.state === "DONE" && run.outputCount === 100), "Not all browser-reviewed workflows completed; inspect the saved evidence");
}
