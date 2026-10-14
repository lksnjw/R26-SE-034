// Isolated acceptance workspace: real LCWE handlers/workers/approval UI, but
// synthetic SDK answers only. No network ERP writes, emails, or real model.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import { parse, stringify } from "yaml";
import { Repository } from "../src/repository/store.ts";
import { RegistryService } from "../src/registry/service.ts";
import { toolSchema } from "../src/registry/schemas.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { Executor } from "../src/runner/executor.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.ts";
import { admissionAuthorizer, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.ts";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.ts";
import { updateRuntimeApprovalPolicy } from "../src/runner/runtime-approvals.ts";
import { loadConfig } from "../src/config/config.ts";
import { hashPassword } from "../src/authn/password.ts";
import { buildApp } from "../src/http/app.ts";

export const scenarios = [
  { id: "qa100_onboarding", name: "Employee onboarding", stages: ["Identity and application", "Employment and eligibility", "Equipment and access review", "Orientation and audit"], approvals: ["HR identity review", "Manager onboarding review"] },
  { id: "qa100_purchase", name: "Purchase request review", stages: ["Request and supplier checks", "Quotation and budget review", "Delivery and compliance review", "Procurement audit"], approvals: ["Procurement request review", "Budget owner review"] },
  { id: "qa100_invoice", name: "Invoice review", stages: ["Invoice and supplier checks", "Purchase order matching", "Receipt and variance checks", "Finance audit"], approvals: ["Accounts payable review", "Finance manager review"] },
  { id: "qa100_documents", name: "Document verification", stages: ["Upload ownership and identity", "Extraction and completeness", "Cross-document consistency", "Verification audit"], approvals: ["Identity document review", "Verification supervisor review"] },
];
export function businessBlueprint(scenario) {
  return { name: `QA 100 · ${scenario.name}`, description: "SYNTHETIC acceptance only: 98 staged fixture reads and two exact independently approved fixture notifications. Not a production business rule implementation.", trigger: { type: "manual" },
    steps: Array.from({ length: 100 }, (_, index) => {
      const ordinal = index + 1, id = `node_${String(ordinal).padStart(3, "0")}`;
      const approval = ordinal === 25 ? 0 : ordinal === 75 ? 1 : -1;
      return { id, action: approval >= 0 ? "qa100.record_review" : "qa100.check_record", description: approval >= 0 ? scenario.approvals[approval] : `${scenario.stages[Math.floor(index / 25)]} · check ${ordinal}`,
        parameters: { value: approval >= 0 ? `{{node_${String(ordinal - 1).padStart(3, "0")}.structuredContent.value}}` : `${scenario.id}: synthetic case 001 / ${scenario.stages[Math.floor(index / 25)]} / check ${ordinal}` } };
    }) };
}

export async function createFourBusinessWorkspace() {
  const directory = await mkdtemp(resolve(tmpdir(), "lcwe-four-business-"));
  const outputDirectory = resolve("../tmp/pipeline-local/four-business-100");
  await mkdir(outputDirectory, { recursive: true });
  const original = JSON.parse(await readFile(resolve("tests/fixtures/tools.json"), "utf8"))[0];
  const read = toolSchema.parse({ ...original, tool_id: "QA100-READ", name: "qa100.check_record", mcp_tool_name: "qa100.check_record", allowed_roles: ["Platform Admin"], description: "Synthetic staged business check, never contacts ERP", required_parameters: ["value"], optional_parameters: [],
    input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } });
  const write = toolSchema.parse({ ...read, tool_id: "QA100-REVIEW", name: "qa100.record_review", mcp_tool_name: "qa100.record_review", is_read_only: false, side_effects: ["In-process synthetic review receipt only; no email or ERP write"],
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
    bridge_contract: { ...read.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" }, id: { type: "string" } }, required: ["accepted", "id"], additionalProperties: false } } });
  await writeFile(resolve(directory, "tools.json"), JSON.stringify([read, write]), { flag: "wx" });
  await writeFile(resolve(directory, "rules.json"), "[]", { flag: "wx" });
  const repository = await Repository.open(null), registries = await RegistryService.load(resolve(directory, "tools.json"), resolve(directory, "rules.json"));
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", JWT_SECRET: randomBytes(48).toString("hex"), STORAGE_ENCRYPTION_KEY: "x".repeat(32), CORS_ORIGINS: "http://127.0.0.1:5194" });
  const validator = new RegistryValidator(registries, repository), calls = [];
  const sdk = { metadataComplete: true, connect: async () => {}, close: async () => {}, listTools: async () => [read, write].map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract.output_schema,
    _meta: { "toolplane.resourceDigest": tool.bridge_contract.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } })),
    callTool: async (name, args) => { calls.push({ name, arguments: structuredClone(args), at: new Date().toISOString() });
      return { content: [], structuredContent: name === exactBridgeName(read) ? { value: String(args.value).toUpperCase() } : { accepted: true, id: `synthetic-receipt-${calls.length}` } }; } };
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "synthetic-only", timeoutMs: 1000, validator, sdkClient: sdk, admissionAuthorizer: admissionAuthorizer(repository, registries) });
  const createdAt = new Date().toISOString(), passwordHash = await hashPassword("Workflow-QA-2026!");
  await repository.mutate(state => {
    state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false };
    state.roles.qa_review = { id: "qa_review", name: "Independent QA reviewer", description: "Exact synthetic approval only", permissions: ["execution:approve"], createdAt };
    for (const id of ["qa100_requester", "qa100_reviewer", "qa100_observer"]) {
      state.users[id] = { id, name: id === "qa100_requester" ? "QA Requester" : id === "qa100_reviewer" ? "Independent QA Reviewer" : "QA Observer", email: `${id}@example.test`, roleId: id === "qa100_reviewer" ? "qa_review" : "role_admin", permissionOverrides: [], status: "Active", initials: "QA", departmentId: null, lastLoginAt: null, createdAt };
      state.passwordHashes[id] = passwordHash;
    }
    for (const scenario of scenarios) {
      const blueprint = businessBlueprint(scenario), yaml = stringify(blueprint);
      state.workflows[scenario.id] = { id: scenario.id, name: blueprint.name, description: blueprint.description, owner: { id: "qa100_requester", name: "QA Requester" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" }, steps: 100, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: ["synthetic-acceptance"], domainTags: [], canRun: false, createdAt, updatedAt: createdAt, yaml, archived: false };
      state.versions[scenario.id] = [];
      state.chats[scenario.id] = { id: scenario.id, ownerId: "qa100_requester", title: blueprint.name, createdAt, updatedAt: createdAt, messageCount: 1,
        messages: [{ id: `${scenario.id}_preview`, role: "assistant", text: "SYNTHETIC acceptance workspace: 100 nodes, two independently approved fixture receipts. No production ERP, email, or real model. Inspect the saved graph and actual execution record.", createdAt, artifacts: { intent: "WORKFLOW", workflowId: scenario.id, yaml, validation_passed: true, can_execute: false } }] };
    }
  });
  const actor = await repository.effectiveUser("qa100_requester");
  await repository.mutate(state => updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["qa_review"], ttlSeconds: 3600, separationOfDuties: true }));
  const observed = await observeCapabilities({ repository, registries, session, user: actor });
  for (const observation of observed.observations) await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash, decisionKey: `qa100-contract-${observation.toolId}`, effectClass: observation.toolId === write.tool_id ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Synthetic fixture contract only; not a live ERPBridge qualification", ...(observation.toolId === write.tool_id ? { requireIndependentApproval: true } : {}) } });
  const services = { repository, registries, config, validator, erpbridgeSession: session, executor: new Executor(new ToolRegistry(), validator) };
  const app = await buildApp(services);
  const request = (method, url, payload, userId = "qa100_requester") => app.inject({ method, url, headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: 7200 })}` }, ...(payload === undefined ? {} : { payload }) });
  const checked = async (method, url, payload, userId, status = 200) => { const response = await request(method, url, payload, userId); assert.equal(response.statusCode, status, response.body); return response.json().data; };
  const wait = async (id, status) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { const run = (await repository.snapshot()).executions[id]; if (run.status === status) return run;
      assert(!["FAILED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "CANCELLED"].includes(run.status), JSON.stringify({ id, status: run.status, failure: run.failure, summary: run.agentSummary }));
      await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Timed out waiting for ${id} ${status}`);
  };
  const run = async (workflowId, key) => { const execution = await checked("POST", `/api/workflows/${workflowId}/run`, { mode: "async-operation", idempotencyKey: key, input: {} }, undefined, 202); await wait(execution.id, "AWAITING_APPROVAL"); return execution.id; };
  const review = async id => (await checked("GET", `/api/executions/${id}?view=approval`, undefined, "qa100_reviewer")).runtimeApproval;
  const command = value => ({ approvalId: value.id, baseVersion: value.version, reviewHash: value.reviewHash, decisionKey: `qa100-decision-${randomBytes(12).toString("hex")}` });
  return { app, services, repository, calls, read, write, checked, request, run, wait, review, command, outputDirectory, close: async () => { await app.close(); await session.close(); await repository.close(); } };
}

export async function checkFourBusinessWorkflows(workspace) {
  const { checked, request, run, wait, review, command, repository, calls, write, outputDirectory } = workspace;
  const evidence = { scope: "Real LCWE resident application and approval workers; SDK fixture only. No live ERPBridge, model, email, payment, or durable application restart test.", scenarios: [], uiRuns: [] };
  for (const scenario of scenarios) {
    const source = (await repository.snapshot()).workflows[scenario.id].yaml;
    assert.equal(parse(source).steps.length, 100);
    await writeFile(resolve(outputDirectory, `${scenario.id}.yaml`), source);
    await checked("POST", `/api/workflows/${scenario.id}/publish`, {});
    const readiness = await checked("GET", `/api/workflows/${scenario.id}/readiness`);
    assert.equal(readiness.validation.passed, true); assert.equal(readiness.can_attempt_run, true);
    const offset = calls.length, key = `qa100-full-${scenario.id}-0001`, id = await run(scenario.id, key);
    let first = await review(id); assert.equal(first.nodeId, "node_025");
    assert.equal(calls.length - offset, 24); assert(!calls.slice(offset).some(call => call.name === exactBridgeName(write)));
    const self = await request("POST", `/api/executions/${id}/approve`, command(first)); assert.equal(self.statusCode, 403);
    const unauthorized = await request("POST", `/api/executions/${id}/approve`, command(first), "qa100_observer"); assert.equal(unauthorized.statusCode, 403);
    const stale = await request("POST", `/api/executions/${id}/approve`, { ...command(first), reviewHash: `sha256:${"a".repeat(64)}` }, "qa100_reviewer"); assert.equal(stale.statusCode, 409);
    await checked("POST", `/api/executions/${id}/approve`, command(first), "qa100_reviewer");
    await wait(id, "AWAITING_APPROVAL"); const second = await review(id); assert.equal(second.nodeId, "node_075"); assert.notEqual(second.id, first.id);
    assert.equal(calls.length - offset, 74); assert.equal(calls.slice(offset).filter(call => call.name === exactBridgeName(write)).length, 1);
    await checked("POST", `/api/executions/${id}/approve`, command(second), "qa100_reviewer");
    const done = await wait(id, "DONE"); assert.equal(Object.keys(done.stepOutputs).length, 100); assert.equal(calls.length - offset, 100);
    const duplicate = await checked("POST", `/api/workflows/${scenario.id}/run`, { mode: "async-operation", idempotencyKey: key, input: {} }, undefined, 202);
    assert.equal(duplicate.id, id); assert.equal(calls.length - offset, 100);
    const template = await checked("POST", "/api/workflows/templates", { name: `Reusable ${scenario.name} QA 100`, description: "Synthetic acceptance template", category: "QA", yaml: source, steps: 100 }, undefined, 201);
    const reused = await checked("POST", `/api/workflows/templates/${template.id}/use`, { name: `Reused ${scenario.name} QA 100` }, undefined, 201); assert.equal(reused.steps, 100); assert.equal(reused.canRun, false);
    const rejectionOffset = calls.length, rejectedId = await run(scenario.id, `qa100-reject-${scenario.id}-0001`);
    const rejection = await review(rejectedId); await checked("POST", `/api/executions/${rejectedId}/reject`, command(rejection), "qa100_reviewer");
    const rejected = (await repository.snapshot()).executions[rejectedId]; assert.equal(rejected.status, "FAILED"); assert.equal(rejected.failure.failureCategory, "RUNTIME_APPROVAL_REJECTED"); assert.equal(calls.length - rejectionOffset, 24);
    evidence.scenarios.push({ workflowId: scenario.id, name: scenario.name, nodes: 100, completedExecutionId: id, outputCount: 100, sdkCalls: 100, approvals: [first.nodeId, second.nodeId], selfApproval: self.statusCode, unauthorizedApproval: unauthorized.statusCode, staleReview: stale.statusCode, duplicateRunSameExecution: true, rejectedExecutionId: rejectedId, callsBeforeRejection: 24, rejectionState: rejected.status, templateId: template.id, reusedWorkflowId: reused.id, reusedNodes: reused.steps });
    console.log(`${scenario.name}: 100 outputs, two independent approvals, rejection stopped at 24 reads, save/reuse passed.`);
  }
  for (const scenario of scenarios) { const id = await run(scenario.id, `qa100-ui-${scenario.id}-0001`); evidence.uiRuns.push({ workflowId: scenario.id, executionId: id, state: "AWAITING_APPROVAL", nodeId: "node_025" }); }
  await writeFile(resolve(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspace = await createFourBusinessWorkspace();
  try {
    await checkFourBusinessWorkflows(workspace);
    if (process.argv.includes("--serve")) {
      await workspace.app.listen({ host: "127.0.0.1", port: 18083 });
      console.log("Synthetic approval QA backend ready on 18083. Frontend 5194. Four UI runs await independent review. Memory only; original 18082 state unchanged.");
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void workspace.close(); });
    } else await workspace.close();
  } catch (error) { await workspace.close(); throw error; }
}
