import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { qaBaseURL, readQaBridgeToken } from "./erpbridge-docker-qa.mjs";
import { nativeReadFixture } from "./native-functions-read-qa.mjs";
import { qaReadTool } from "./seed-erpbridge-qa-read.mjs";
import { toolSchema } from "../src/registry/schemas.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { assertOperationTaskLedger } from "../src/runner/operation-task-outbox.js";
import { nativePolicyURL } from "./native-functions-policy-qa.mjs";

// Exact isolated MockERP integration echo POST only. It updates process-local
// integration fixture state, never a business record, mailbox or production.
export function nativeEchoTool() {
  const source = qaReadTool(); return { ...source, metadata: { name: "qa_native_integration_echo", version: "1.0.1", module: "local_qa" }, spec: {
    ...source.spec, description: { short: "LOCAL MockERP integration echo POST; no business record or email", whenToUse: ["Isolated native operation qualification"], whenNotToUse: ["Production/business execution"], examples: [] },
    annotations: { title: "Local integration echo", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: "object", properties: { value: { type: "string" }, fixtureId: { type: "string" } }, required: ["value", "fixtureId"] },
    outputSchema: { type: "object", properties: { value: { type: "string" }, fixtureId: { type: "string" } }, required: ["value", "fixtureId"] },
    execution: { type: "http", method: "POST", endpoint: "/api/integration/echo", responsePath: "data", parameterLocations: { value: "body", fixtureId: "body" } },
  } };
}
export function nativeEchoDefinition(resource) {
  const expected = nativeEchoTool(), actual = structuredClone(resource?.spec); delete expected.spec.security.allowedRoles;
  expected.spec.execution.approvedOrigins = ["http://mock-erp:8081"];
  if (actual?.security?.allowedRoles?.length === 0) delete actual.security.allowedRoles;
  assert.equal(resource?.apiVersion, expected.apiVersion); assert.equal(resource?.kind, expected.kind);
  assert.equal(resource?.metadata?.name, expected.metadata.name); assert.equal(resource?.metadata?.version, expected.metadata.version);
  assert(/^[a-f0-9]{64}$/.test(resource?.metadata?.resourceDigest ?? ""));
  assert(canonicalJSONBytes(actual).equals(canonicalJSONBytes(expected.spec)), "Existing QA echo definition changed; do not overwrite or admit it");
  return toolSchema.parse({ tool_id: "LOCAL-QA-NATIVE-INTEGRATION-ECHO", name: expected.metadata.name, mcp_tool_name: expected.metadata.name,
    description: "LOCAL process-local integration echo only, no business/email", input_schema: expected.spec.inputSchema,
    required_parameters: ["value", "fixtureId"], allowed_roles: ["Platform Admin"], is_read_only: false, risk_level: "low", side_effects: ["Process-local MockERP integration fixture state"],
    operation_contract: { profile: "operation-result/v1", effect_class: "write", retry_policy: "never", confirmation: { path: ["value"], expected: "native-operation-qa-ack", meaning: "operation-accepted" } },
    bridge_contract: { profile: "toolplane-v1", resource_version: expected.metadata.version, resource_digest: resource.metadata.resourceDigest, remote_roles: [], output_schema: expected.spec.outputSchema } });
}
export async function nativeOperationFixture() {
  const fixture = await nativeReadFixture(), token = await readQaBridgeToken(), headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  // Preserve the earlier 1.0.0 definition/unknown-effect evidence. Correct the
  // deployed MockERP data wrapper in a new immutable reviewed revision only.
  const query = `${qaBaseURL}/apis/erpbridge.io/v1/tools?name=qa_native_integration_echo&version=1.0.1`;
  const read = async () => { const response = await fetch(query, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
    assert(response.ok, "QA echo discovery unavailable"); return response.json(); };
  let resources = await read(); assert(Array.isArray(resources) && resources.length <= 1);
  if (!resources.length) {
    const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools`, { method: "POST", headers, body: JSON.stringify(nativeEchoTool()), redirect: "error", signal: AbortSignal.timeout(15000) });
    assert(response.ok, "QA integration echo registration not acknowledged"); await response.body?.cancel(); resources = await read();
  }
  assert.equal(resources.length, 1); const definition = nativeEchoDefinition(resources[0]);
  fixture.files["native_qa_tools.json"] = JSON.stringify([...JSON.parse(fixture.files["native_qa_tools.json"]), definition]);
  Object.assign(fixture.config, { LCWE_LOCAL_DOCKER_QA: "native-operation/v1", GOVERNANCE_URL: nativePolicyURL,
    GOVERNANCE_API_KEY: randomBytes(32).toString("hex"), GOVERNANCE_CACHE_TTL_MS: "300000", GOVERNANCE_TIMEOUT_MS: "3000" });
  return fixture;
}
export async function qualifyNativeOperation({ request, open, policy }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671"); assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records");
  assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS, "Qualification cannot use a credential file");
  const expect = async (path, method, payload, status, actor = "native_owner") => {
    const response = await request("api", path, method, payload, actor); assert.equal(response.status, status, response.body); return response.data;
  };
  // qualifyNativeRead already connected and reviewed the Department capability.
  const discovery = await expect("/api/registry/capabilities/discovery", "POST", {}, 200);
  const observation = discovery.data.observations.find(value => value.definition.name === "qa_native_integration_echo"); assert(observation);
  await expect(`/api/registry/capabilities/${observation.capabilityId}/review`, "POST", { observationId: observation.id, contractHash: observation.contractHash,
    decisionKey: "native_echo_review_0001", effectClass: "write", riskClass: "low", dataClass: "internal", retryPolicy: "never", requireIndependentApproval: true,
    note: "Exact isolated process-local integration echo POST only; not a business/send contract" }, 200);
  await expect("/api/settings/rbac", "PATCH", { runtimeApprovalPolicy: { profile: "runtime-approval-policy/v1", baseRevision: 0,
    enabled: true, approverRoleIds: ["native_review"], ttlSeconds: 300, separationOfDuties: true } }, 200);
  const fixtureId = randomUUID(), yaml = stringify({ name: "LOCAL native independent operation", description: "Department read then process-local MockERP echo POST only", trigger: { type: "manual" }, steps: [
    { id: "departments", action: "qa_list_departments", parameters: {} }, { id: "echo", action: "qa_native_integration_echo", parameters: { value: "native-operation-qa-ack", fixtureId } } ] });
  // Authoring requires fresh online governance for effects. Prove its refusal;
  // never add an offline write allowance to make this execution fixture pass.
  policy.setAvailable(false);
  try { const refused = await expect("/api/workflows", "POST", { yaml }, 422);
    assert(refused.meta.failed_rules.includes("GOVERNANCE-UNAVAILABLE"));
  } finally { policy.setAvailable(true); }
  const created = await expect("/api/workflows", "POST", { yaml }, 201), workflowId = created.data.id;
  console.log("PASS: native HTTP authoring refuses offline effects, then creates the draft through normal fresh synthetic online governance without seeded workflow/publication bypass");
  await expect(`/api/workflows/${workflowId}/publish`, "POST", {}, 200);
  const payload = { mode: "async-operation", idempotencyKey: "native_independent_operation_0001", input: {} };
  const admitted = await expect(`/api/workflows/${workflowId}/run`, "POST", payload, 202), executionId = admitted.data.id; assert.equal(admitted.meta.taskDispatch, "ENQUEUED");
  const wait = async status => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const progress = await request("api", `/api/executions/${executionId}`, "GET");
      if (progress.status === 200) { const run = progress.data.data; if (run.status === status) return run;
        assert(["PENDING", "RUNNING"].includes(run.status), `Unexpected native operation state: ${run.status}`); }
      else { assert.equal(progress.status, 503, progress.body); assert.equal(progress.data.meta.code, "FUNCTIONS_INVOCATION_UNCONFIRMED"); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } throw new Error("Native original operation did not reach its expected checkpoint");
  };
  const pending = await wait("AWAITING_APPROVAL"); assert.equal(pending.stepOutputs.departments.structuredContent.data.length, 8); assert(!pending.stepOutputs.echo);
  const view = await expect(`/api/executions/${executionId}?view=approval`, "GET", undefined, 200, "native_reviewer"), approval = view.data.runtimeApproval;
  const command = { approvalId: approval.id, baseVersion: approval.version, reviewHash: approval.reviewHash, decisionKey: "native_independent_decision_0001" };
  await expect(`/api/executions/${executionId}/approve`, "POST", command, 403); // requester is not the independent reviewer
  const inspect = async () => { const repository = await open(); try { return await repository.readAuthoritative(state => ({ run: structuredClone(state.executions[executionId]),
    events: structuredClone(state.executionEvents[executionId]), timeline: structuredClone(state.timelines[executionId]) })); } finally { await repository.close(); } };
  const original = await inspect(), old = assertOperationTaskLedger(original.run).generations[0]; assert.equal(old.completion.milestone, "AWAITING_APPROVAL");
  const granted = await expect(`/api/executions/${executionId}/approve`, "POST", command, 200, "native_reviewer"); assert.equal(granted.data.taskDispatch, "ENQUEUED");
  const done = await wait("DONE"); assert.equal(done.stepOutputs.echo.structuredContent.value, "native-operation-qa-ack"); assert.equal(done.stepOutputs.echo.structuredContent.fixtureId, fixtureId);
  const before = await inspect(), ledger = assertOperationTaskLedger(before.run); assert.equal(ledger.generations.length, 2); assert.notEqual(ledger.generations[1].taskId, old.taskId);
  const consumed = before.run.runtimeApprovalSecret.records[approval.id]; assert.equal(consumed.state, "CONSUMED"); assert.equal(consumed.expiresAt, approval.expiresAt);
  for (const generation of ledger.generations) {
    const duplicate = await request("executeOperationTask", "", "POST", { data: { profile: "operation-task-delivery/v1", executionId, taskId: generation.taskId } }, false);
    assert.equal(duplicate.status, 204, duplicate.body);
  }
  const repeated = await expect(`/api/workflows/${workflowId}/run`, "POST", payload, 202); assert.equal(repeated.data.id, executionId);
  const replay = await expect(`/api/executions/${executionId}/approve`, "POST", command, 200, "native_reviewer"); assert.equal(replay.data.replayed, true);
  const after = await inspect(); assert.deepEqual(after, before);
  console.log("PASS: actual native Admin queue + governed Docker MCP read/wait/independent approval/echo POST; original expiry, two generations, old/new duplicate delivery and same-key/decision replay preserve exact saved answers/journal");
  assert(policy.refused.includes("UNAVAILABLE"));
  for (const intent of ["CreateWorkflow", "PublishWorkflow"]) assert(policy.accepted.some(value => value.intent === intent && value.actions.includes("qa_native_integration_echo")));
  console.log("LIMIT: fresh online governance is a strict local synthetic fixture, not the real policy service. Echo updates only process-local MockERP fixture state; no business write, mailbox delivery, real model, business schedule or deployed IAM qualification");
}
