import assert from "node:assert/strict";
import { stringify } from "yaml";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";
import { qaReviewedDefinition } from "./qualify-erpbridge-qa-read.mjs";
import { qaWorkflowBlueprint } from "./erpbridge-workspace-qa.mjs";
import { assertReadTaskOutbox } from "../src/runner/read-task-outbox.js";
import { FirestoreOwnershipFailure } from "../src/storage/firestore-writer-ownership.js";

// DONE is committed before the task's awaited resource teardown ends. An
// exclusive QA inspector must wait for that release, not weaken ownership or
// repeat the original HTTP/ERP operation. Unknown acquisition errors stay fatal.
export async function openNativeQaInspector(open) {
  const deadline = Date.now() + 5000;
  for (let attempt = 0; ; attempt++) {
    try { return await open(); }
    catch (error) {
      if (!(error instanceof Error && error.cause instanceof FirestoreOwnershipFailure && ["WRITER_HELD", "WRITER_HANDOFF"].includes(error.cause.reason)) ||
          Date.now() >= deadline || attempt >= 24) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

// Explicit loopback Docker/MockERP fixture only. No release registry mutation,
// real model, business write, recipient or deployed queue is involved.
export async function nativeReadFixture() {
  const token = await readQaBridgeToken();
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=qa_list_departments&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert(response.ok, "Exact Docker fixture must already be registered");
  const resources = await response.json(); assert.equal(resources.length, 1);
  const definition = qaReviewedDefinition(resources[0]);
  return { config: { APP_ENV: "development", LCWE_LOCAL_DOCKER_QA: "native-read/v1", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
    ERPBRIDGE_BASE_URL: qaBaseURL, ERPBRIDGE_MCP_TOKEN: token, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"admin"}',
    TOOL_REGISTRY_PATH: "configs/runtime/native_qa_tools.json", RULE_REGISTRY_PATH: "configs/runtime/native_qa_rules.json" },
    files: { "native_qa_tools.json": JSON.stringify([definition]), "native_qa_rules.json": "[]" } };
}

export async function qualifyNativeRead({ request, open }) {
  const expect = async (path, method, payload, status) => {
    const response = await request("api", path, method, payload); assert.equal(response.status, status, response.body); return response.data;
  };
  const status = await expect("/api/settings/mcp-connections", "GET", undefined, 200), connection = status.data.connections[0];
  assert.equal(connection.id, "erpbridge-default");
  await expect(`/api/settings/mcp-connections/${connection.id}/connect`, "POST", { baseRevision: connection.revision, requestId: "native_docker_connect_0001" }, 200);
  const discovery = await expect("/api/registry/capabilities/discovery", "POST", {}, 200);
  const observation = discovery.data.observations.find(value => value.definition.name === "qa_list_departments"); assert(observation);
  await expect(`/api/registry/capabilities/${observation.capabilityId}/review`, "POST", {
    observationId: observation.id, contractHash: observation.contractHash, decisionKey: "native_docker_read_review_0001",
    effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit local MockERP literal Department GET; not a production review" }, 200);
  const draft = await expect("/api/workflows", "POST", { yaml: stringify(qaWorkflowBlueprint()) }, 201), workflowId = draft.data.id;
  await expect(`/api/workflows/${workflowId}/publish`, "POST", {}, 200);
  const admitted = await expect(`/api/workflows/${workflowId}/run`, "POST", {
    mode: "async-read", idempotencyKey: "native_docker_queued_read_0001", input: { includeDepartments: true } }, 202);
  assert.equal(admitted.meta.taskDispatch, "ENQUEUED", "Native Admin queue acceptance is required, not a fixture transport or unconfirmed outbox");
  const executionId = admitted.data.id;
  console.log("PASS: native HTTPS publication/admission acknowledged the original task through the actual Admin SDK and Functions queue emulator");
  // Poll authoritative HTTP progress, allowing only the existing exclusive
  // writer contention refusal while the native task owns this namespace.
  let terminal; const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const progress = await request("api", `/api/executions/${executionId}`, "GET");
    if (progress.status === 200) {
      const run = progress.data.data;
      if (["DONE", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(run.status)) { terminal = run; break; }
      assert(["PENDING", "RUNNING"].includes(run.status), "Unrecognized execution state");
    } else {
      assert.equal(progress.status, 503, progress.body);
      assert.equal(progress.data.meta.code, "FUNCTIONS_INVOCATION_UNCONFIRMED");
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert(terminal, "Actual queued task did not finish within the qualification deadline"); assert.equal(terminal.status, "DONE", JSON.stringify({ status: terminal.status, failure: terminal.failure, summary: terminal.agentSummary }));
  assert.equal(terminal.stepOutputs.departments.structuredContent.data.length, 8);
  const inspect = async () => { const repository = await open(); try { return await repository.readAuthoritative(state => ({
    run: structuredClone(state.executions[executionId]), job: structuredClone(state.readJobs[executionId]),
    events: structuredClone(state.timelines[executionId]), jobs: Object.keys(state.readJobs).length,
  })); } finally { await repository.close(); } };
  const before = await inspect(), outbox = assertReadTaskOutbox(before.job);
  assert.equal(before.job.state, "FINISHED"); assert.equal(outbox.state, "ENQUEUED");
  assert.equal(before.run.status, "DONE"); assert.equal(before.jobs, 1);
  const duplicate = await request("executeReadTask", "", "POST", { data: { profile: "read-task-delivery/v1", executionId, taskId: outbox.taskId } }, false);
  // The Firebase tasks wrapper acknowledges completed work with HTTP 204.
  assert.equal(duplicate.status, 204, duplicate.body);
  const repeated = await expect(`/api/workflows/${workflowId}/run`, "POST", {
    mode: "async-read", idempotencyKey: "native_docker_queued_read_0001", input: { includeDepartments: true } }, 202);
  assert.equal(repeated.data.id, executionId);
  const after = await inspect(); assert.equal(after.jobs, 1); assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.run.stepOutputs, before.run.stepOutputs); assert.equal(assertReadTaskOutbox(after.job).taskId, outbox.taskId);
  console.log("PASS: native queued handler completed an actual governed Docker Department read (8 synthetic rows); duplicate native delivery and same-key HTTP admission retained one run/task and unchanged node answers/journal");
  console.log(`LIMIT: local emulator/MockERP only (campaign process ${process.version}); polling contention, cloud IAM, real models/email and production deployment are not qualified; verify the emulator's function runtime separately`);
}
