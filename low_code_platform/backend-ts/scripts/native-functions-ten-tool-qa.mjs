// Native Firebase Functions + Firestore + Docker MockERP qualification for one
// workflow containing ten distinct governed read tools. ERPBridge is consumed
// only through its API/MCP boundary; its source is never changed here.
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";
import { qaReviewedDefinition } from "./qualify-erpbridge-qa-read.mjs";
import { qaTenReadResources, qaTenReviewedDefinition } from "./seed-erpbridge-qa-ten-read.mjs";
import { assertReadTaskOutbox } from "../src/runner/read-task-outbox.js";

async function remoteResource(token, name) {
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=${encodeURIComponent(name)}&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `Exact Docker fixture ${name} must already be registered`);
  const resources = await response.json(); assert.equal(resources.length, 1); return resources[0];
}

export function qaTenWorkflowBlueprint() {
  return { name: "LOCAL ten-tool ERP portfolio read", description: "Ten distinct governed reads through Docker ERPBridge and MockERP; no production data, writes, email or scheduling.",
    trigger: { type: "manual", config: {} }, steps: qaTenReadResources.map(resource => ({ id: resource.id, action: resource.name, description: `Read synthetic ${resource.label}`, parameters: {} })) };
}

export async function nativeTenToolFixture() {
  const token = await readQaBridgeToken();
  const ten = await Promise.all(qaTenReadResources.map(async resource => qaTenReviewedDefinition(await remoteResource(token, resource.name), resource)));
  // Keep the existing Pi local-model fixture available in the same campaign;
  // the workflow under test itself still has exactly the ten tools above.
  const department = qaReviewedDefinition(await remoteResource(token, "qa_list_departments"));
  return { config: { APP_ENV: "development", LCWE_LOCAL_DOCKER_QA: "native-read/v1", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
    ERPBRIDGE_BASE_URL: qaBaseURL, ERPBRIDGE_MCP_TOKEN: token, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"admin"}',
    TOOL_REGISTRY_PATH: "configs/runtime/native_qa_tools.json", RULE_REGISTRY_PATH: "configs/runtime/native_qa_rules.json" },
    files: { "native_qa_tools.json": JSON.stringify([department, ...ten]), "native_qa_rules.json": "[]" } };
}

export async function qualifyNativeTenTools({ request, open }) {
  const expect = async (path, method, payload, status = 200) => {
    const response = await request("api", path, method, payload); assert.equal(response.status, status, response.body); return response.data;
  };
  const status = await expect("/api/settings/mcp-connections", "GET"), connection = status.data.connections[0];
  assert.equal(connection.id, "erpbridge-default");
  await expect(`/api/settings/mcp-connections/${connection.id}/connect`, "POST", { baseRevision: connection.revision, requestId: "native_ten_connect_0001" });
  const discovery = await expect("/api/registry/capabilities/discovery", "POST", {});
  for (const [index, resource] of qaTenReadResources.entries()) {
    const observation = discovery.data.observations.find(value => value.definition.name === resource.name); assert(observation, `Missing discovery for ${resource.name}`);
    await expect(`/api/registry/capabilities/${observation.capabilityId}/review`, "POST", { observationId: observation.id, contractHash: observation.contractHash,
      decisionKey: `native_ten_review_${String(index + 1).padStart(2, "0")}`, effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never",
      note: `Explicit local MockERP ${resource.label} GET; not a production review` });
  }
  const piDepartment = discovery.data.observations.find(value => value.definition.name === "qa_list_departments"); assert(piDepartment);
  await expect(`/api/registry/capabilities/${piDepartment.capabilityId}/review`, "POST", { observationId: piDepartment.id, contractHash: piDepartment.contractHash,
    decisionKey: "native_ten_pi_department_review", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never",
    note: "Explicit local Department GET for the separate Pi model fixture; not one of the ten workflow steps" });
  const draft = await expect("/api/workflows", "POST", { yaml: stringify(qaTenWorkflowBlueprint()) }, 201), workflowId = draft.data.id;
  await expect(`/api/workflows/${workflowId}/publish`, "POST", {});
  const command = { mode: "async-read", idempotencyKey: "native_ten_tool_read_0001", input: {} };
  const admitted = await expect(`/api/workflows/${workflowId}/run`, "POST", command, 202); assert.equal(admitted.meta.taskDispatch, "ENQUEUED");
  const executionId = admitted.data.id; let terminal; const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await request("api", `/api/executions/${executionId}`, "GET");
    if (response.status === 200) { terminal = response.data.data; if (!["PENDING", "RUNNING"].includes(terminal.status)) break; }
    else { assert.equal(response.status, 503, response.body); assert.equal(response.data.meta.code, "FUNCTIONS_INVOCATION_UNCONFIRMED"); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log("TEN_TOOL_PUBLIC_CHECKPOINT", JSON.stringify({ status: terminal?.status, outputKeys: Object.keys(terminal?.stepOutputs ?? {}),
    failureCategory: terminal?.failure?.failureCategory ?? null, failedStepId: terminal?.failure?.failedStepId ?? null }));
  assert.equal(terminal?.status, "DONE", JSON.stringify({ status: terminal?.status, failure: terminal?.failure }));
  assert.deepEqual(Object.keys(terminal.stepOutputs).filter(key => key !== "input").sort(), qaTenReadResources.map(resource => resource.id).sort());
  const rowCounts = Object.fromEntries(qaTenReadResources.map(resource => {
    const rows = terminal.stepOutputs[resource.id]?.structuredContent?.data; assert(Array.isArray(rows), `${resource.name} returned no data array`); return [resource.id, rows.length];
  }));
  console.log(`PASS: queued ten-tool run reached DONE with ten saved output arrays: ${JSON.stringify(rowCounts)}`);
  const inspect = async () => { const repository = await open(); try { return await repository.readAuthoritative(state => ({
    run: structuredClone(state.executions[executionId]), job: structuredClone(state.readJobs[executionId]), timeline: structuredClone(state.timelines[executionId]),
    events: structuredClone(state.executionEvents[executionId]), jobs: Object.keys(state.readJobs).length, executions: Object.keys(state.executions).length,
  })); } finally { await repository.close(); } };
  const before = await inspect(), outbox = assertReadTaskOutbox(before.job);
  assert.equal(before.run.status, "DONE"); assert.equal(before.job.state, "FINISHED"); assert.equal(before.jobs, 1);
  assert.equal(before.timeline.length, 10); assert(before.timeline.every((entry, index) => entry.nodeId === qaTenReadResources[index].id && entry.status === "DONE"));
  const duplicate = await request("executeReadTask", "", "POST", { data: { profile: "read-task-delivery/v1", executionId, taskId: outbox.taskId } }, false);
  assert.equal(duplicate.status, 204, duplicate.body);
  const replay = await expect(`/api/workflows/${workflowId}/run`, "POST", command, 202); assert.equal(replay.data.id, executionId);
  const after = await inspect(); assert.equal(after.jobs, 1); assert.equal(after.executions, 1); assert.deepEqual(after.timeline, before.timeline); assert.deepEqual(after.events, before.events); assert.deepEqual(after.run.stepOutputs, before.run.stepOutputs);
  const invalid = { ...qaTenWorkflowBlueprint(), name: "LOCAL invalid unknown tool", steps: [{ id: "unknown", action: "qa_unknown_erp_tool", parameters: {} }] };
  const rejected = await request("api", "/api/workflows", "POST", { yaml: stringify(invalid) }); assert.equal(rejected.status, 422, rejected.body);
  const final = await inspect(); assert.equal(final.executions, 1, "Rejected workflow unexpectedly created an execution");
  console.log(`PASS: one queued workflow completed 10/10 distinct governed ERP reads through Firebase Functions and Docker ERPBridge. Synthetic row counts: ${JSON.stringify(rowCounts)}`);
  console.log("PASS: duplicate task delivery and same-key admission preserved one run/task and unchanged outputs/journals; an unknown ERP tool was rejected before execution.");
  return { workflowId, executionId, rowCounts };
}
