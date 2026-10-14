import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, capabilityContractHash } from "../src/registry/capability-admission.js";
import { updateRuntimeApprovalPolicy } from "../src/runner/runtime-approvals.js";
import { bindExecutionHost } from "../src/runner/execution-host.js";
import { operationReadbackQueue, operationReadbackHistory } from "../src/runner/operation-readback-jobs.js";
import { configureReadbackTaskDispatch, assertReadbackTaskOutbox, recoverReadbackTaskOutboxes } from "../src/runner/readback-task-outbox.js";
import { buildApp } from "../src/http/app.js";

// Actual encrypted scoped Firestore transactions and clean process boundaries;
// queue and ERP SDK are fixtures. No model, mailbox, remote ERP or cloud calls.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback demo Firestore emulator and no credential file are required");
const phase = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : undefined;
const phases = new Set(["seed", "admit", "execute", "duplicate", "recover", "finish-before", "finish-after",
  ...["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"].flatMap(stage => [`fault-${stage}-before`, `fault-${stage}-after`])]);
const commandFor = job => ({ profile: "readback-task-delivery/v1", executionId: job.executionId, queryId: job.id, taskId: assertReadbackTaskOutbox(job).taskId });
async function until(read, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await read() === expected) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal(await read(), expected);
}
async function child() {
  assert(phases.has(phase)); const workspaceId = process.env.LCWE_READBACK_QA_WORKSPACE, key = process.env.LCWE_READBACK_QA_KEY;
  assert(/^test_[a-f0-9]{32}_readbacktask$/.test(workspaceId ?? "")); assert.equal(Buffer.from(key ?? "", "base64").length, 32);
  const config = { ...loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", STORAGE_ENCRYPTION_KEY: key,
    JWT_SECRET: "firestore-readback-qualification-fixture-secret-32-bytes" }), readWorkerLeaseMs: 5000 };
  const storage = await FirestoreRecordPersistence.open(key, { projectId, databaseId: "(default)", workspaceId }), repository = await Repository.open(storage);
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json")), base = registries.snapshot();
  const target = toolSchema.parse({ ...base.tools[0], tool_id: "readback-fixture", name: "demo.status", mcp_tool_name: "demo.status", is_read_only: true,
    allowed_roles: ["Platform Admin"], risk_level: "low", side_effects: [], input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: { type: "object",
      properties: { value: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" } }, required: ["value", "state", "settled", "observedAt"], additionalProperties: false } } });
  const effect = toolSchema.parse({ ...target, tool_id: "send-fixture", name: "demo.dispatch", mcp_tool_name: "demo.dispatch", is_read_only: false, side_effects: ["Synthetic notification"],
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" },
      readback: { profile: "operation-readback-contract/v1", tool_id: target.tool_id, contract_hash: capabilityContractHash(target),
        arguments: [{ parameter: "value", source_path: ["value"] }], correlation: [{ source_path: ["value"], result_path: ["value"] }],
        outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60, evidence_meaning: "operation-state" } },
    bridge_contract: { ...target.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } });
  const tools = [target, effect]; registries.snapshot = () => ({ ...base, tools }); registries.findTool = name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name));
  registries.hash = () => capabilityContractHash(effect);
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator); let queries = 0, effects = 0;
  const session = await createErpbridgeMcpSession({ baseURL: "https://readback.firestore-fixture.example.test", token: "synthetic-stable-token", timeoutMs: 1000, validator,
    admissionAuthorizer: admissionAuthorizer(repository, registries), sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {},
      listTools: async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract.output_schema,
        _meta: { "toolplane.resourceDigest": tool.bridge_contract.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } })),
      callTool: async (name, args) => {
        if (name === exactBridgeName(effect)) { effects++; throw new Error("Synthetic uncertain original action; never replay"); }
        assert.equal(name, exactBridgeName(target)); queries++;
        return { content: [], structuredContent: { value: args.value, state: "ABSENT", settled: true, observedAt: new Date().toISOString() } };
      } } });
  const services = { repository, registries, validator, executor, config, erpbridgeSession: session }, enqueued = [];
  bindExecutionHost(repository, phase === "seed" ? "resident-server" : "bounded-invocation");
  if (phase !== "seed") configureReadbackTaskDispatch(repository, { timeoutMs: 1000, enqueue: async command => {
    enqueued.push(structuredClone(command)); return { taskId: command.taskId, outcome: phase === "recover" ? "ALREADY_EXISTS" : "CREATED" };
  } });
  const app = await buildApp(services), headers = actorId => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actorId, expiresIn: 3600 })}` });
  const request = (method, url, payload, actorId = "requester") => app.inject({ method, url, headers: headers(actorId), ...(payload ? { payload } : {}) });
  let injected = false, attemptedCommand, result; const writer = storage.saveExecutionCheckpoint.bind(storage);
  try {
    if (phase === "seed") {
      assert.equal(await repository.read(state => Object.keys(state.executions).length), 0);
      await repository.mutate(state => {
        const now = new Date().toISOString(); state.roles.review = { id: "review", name: "Independent approver", description: "Review only", permissions: ["execution:approve"], createdAt: now };
        for (const id of ["requester", "reviewer"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: id === "reviewer" ? "review" : "role_admin",
          permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: now };
        const yaml = stringify({ name: "Uncertain original", description: "Synthetic notification", trigger: { type: "manual" }, steps: [{ id: "send", action: effect.name, parameters: { value: "original" } }] });
        state.workflows.flow = { id: "flow", name: "Uncertain original", description: "", owner: { id: "requester", name: "requester" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" }, steps: 1,
          successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml, archived: false }; state.versions.flow = [];
      });
      const actor = await repository.effectiveUser("requester");
      await repository.mutate(state => updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["review"], ttlSeconds: 300, separationOfDuties: true }));
      for (const observation of (await observeCapabilities({ repository, registries, session, user: actor })).observations)
        await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash,
          decisionKey: `fixture-review-${observation.toolId}`, effectClass: observation.toolId === effect.tool_id ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Synthetic review",
          ...(observation.toolId === effect.tool_id ? { requireIndependentApproval: true } : {}) } });
      const published = await request("POST", "/api/workflows/flow/publish", {}); assert.equal(published.statusCode, 200, published.body);
      const admitted = await request("POST", "/api/workflows/flow/run", { mode: "async-operation", idempotencyKey: "firestore-original-uncertain-key-001", input: {} }); assert.equal(admitted.statusCode, 202, admitted.body);
      const id = admitted.json().data.id; await until(() => repository.read(state => state.executions[id].status), "AWAITING_APPROVAL");
      const review = await request("GET", `/api/executions/${id}?view=approval`, undefined, "reviewer"); assert.equal(review.statusCode, 200, review.body); const approval = review.json().data.runtimeApproval;
      const approved = await request("POST", `/api/executions/${id}/approve`, { approvalId: approval.id, baseVersion: approval.version, reviewHash: approval.reviewHash, decisionKey: "fixture-approval-0001" }, "reviewer");
      assert.equal(approved.statusCode, 200, approved.body); await until(() => repository.read(state => state.executions[id].status), "RECONCILIATION_REQUIRED");
      assert.equal(effects, 1); assert.equal(queries, 0); return { pid: process.pid, effects, queries };
    }
    const source = await repository.readAuthoritative(state => structuredClone(Object.values(state.executions)[0])); assert.equal(source.status, "RECONCILIATION_REQUIRED");
    const id = source.id, fault = phase.startsWith("fault-") ? phase.split("-") : phase.startsWith("finish-") ? ["finish", "ANSWERED", phase.split("-")[1]] : undefined;
    if (fault) storage.saveExecutionCheckpoint = async checkpoint => {
      const job = Object.values(checkpoint.execution?.operationSecret?.readbacks ?? {})[0];
      if (!injected && (fault[0] === "finish" ? job?.state === "ANSWERED" : job?.taskDispatchSecret?.state === fault[1])) {
        injected = true; attemptedCommand = commandFor(job); if (fault[2] === "after") await writer(checkpoint); throw new Error("Synthetic checkpoint acknowledgement loss");
      }
      return writer(checkpoint);
    };
    if (phase === "admit" || phase.startsWith("fault-")) {
      const value = await repository.readAuthoritative(state => operationReadbackHistory(state, services, id, "requester"));
      const response = await request("POST", `/api/executions/${id}/readbacks`, { intentId: value.intentId, baseVersion: value.baseVersion, factsHash: value.factsHash, idempotencyKey: "firestore-readback-original-key-001" });
      assert.equal(response.statusCode, fault ? 503 : 202, response.body); result = { httpStatus: response.statusCode }; assert.equal(queries, 0);
    } else if (phase === "recover") { result = { recovery: await recoverReadbackTaskOutboxes(repository) }; assert.equal(queries, 0); }
    else {
      const job = Object.values(source.operationSecret.readbacks ?? {})[0]; assert(job);
      if (job.state === "RUNNING") { const remaining = job.lease.expiresAt - Date.now(); assert(remaining <= 5000); if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 20)); }
      if (fault) await assert.rejects(operationReadbackQueue(services).executeTask(commandFor(job), { timeoutMs: 4000 }));
      else { const receipt = await operationReadbackQueue(services).executeTask(commandFor(job), { timeoutMs: 4000 }); result = { status: receipt.state };
        assert(["ANSWERED", "RECOVERY_REQUIRED"].includes(receipt.state)); assert.equal(receipt.deliveryVerified, false); }
    }
    assert.equal(effects, 0, "A query phase must never resend the original action");
    if (fault) { assert(injected); assert.throws(() => repository.assertAuthority()); }
    const current = !fault ? await repository.readAuthoritative(state => structuredClone(state.executions[id])) : undefined;
    if (current) { assert.equal(current.status, source.status); assert.deepEqual(current.operationSecret.intents, source.operationSecret.intents); assert.deepEqual(current.stepOutputs, source.stepOutputs); }
    const jobs = current ? Object.values(current.operationSecret.readbacks ?? {}) : []; assert(jobs.length <= 1);
    return { ...result, pid: process.pid, effects, queries, enqueued, jobs: current ? jobs.length : undefined, command: attemptedCommand ?? (jobs[0] ? commandFor(jobs[0]) : null) };
  } finally { storage.saveExecutionCheckpoint = writer; await app.close(); await session.close(); await repository.close(); }
}
if (phase) console.log(JSON.stringify(await child()));
else {
  const launch = promisify(execFile), script = fileURLToPath(import.meta.url), pids = [], totals = { effects: 0, queries: 0 };
  const namespace = () => ({ LCWE_READBACK_QA_WORKSPACE: `test_${randomUUID().replaceAll("-", "")}_readbacktask`, LCWE_READBACK_QA_KEY: randomBytes(32).toString("base64") });
  const invoke = async (phase, fixture) => {
    const { stdout } = await launch(process.execPath, ["--import", "tsx/esm", script, "--phase", phase], { cwd: process.cwd(), env: { ...process.env, ...fixture, NODE_ENV: "test" }, timeout: 60_000, maxBuffer: 256_000, windowsHide: true });
    const result = JSON.parse(stdout.trim()); pids.push(result.pid); totals.effects += result.effects; totals.queries += result.queries; return result;
  };
  const fixture = namespace(); await invoke("seed", fixture); const admitted = await invoke("admit", fixture), executed = await invoke("execute", fixture), duplicate = await invoke("duplicate", fixture);
  assert.equal(executed.status, "ANSWERED"); assert.equal(executed.queries, 1); assert.equal(duplicate.queries, 0); assert.deepEqual(executed.command, admitted.command); assert.deepEqual(duplicate.command, admitted.command);
  console.log("PASS: actual encrypted Firestore original operation and read-only query across four clean processes, exact duplicate and no original resend");
  for (const stage of ["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"]) for (const edge of ["before", "after"]) {
    const fixture = namespace(); await invoke("seed", fixture); const failed = await invoke(`fault-${stage}-${edge}`, fixture), recovered = await invoke("recover", fixture);
    const absent = stage === "PREPARED" && edge === "before"; assert.equal(recovered.jobs, absent ? 0 : 1); assert.equal(failed.queries + recovered.queries, 0);
    if (!absent) { assert.deepEqual(recovered.command, failed.command); const done = await invoke("execute", fixture), repeated = await invoke("duplicate", fixture);
      assert.equal(done.status, "ANSWERED"); assert.equal(done.queries, 1); assert.equal(repeated.queries, 0); assert.deepEqual(done.command, failed.command); }
    console.log(`PASS: ${edge}-COMMIT ${stage} ACK loss; fresh owner retains original query/task and never resends its action`);
  }
  for (const edge of ["before", "after"]) {
    const fixture = namespace(); await invoke("seed", fixture); await invoke("admit", fixture); const failed = await invoke(`finish-${edge}`, fixture), repeated = await invoke("duplicate", fixture);
    assert.equal(failed.queries, 1); assert.equal(repeated.queries, 0); assert.equal(repeated.status, edge === "after" ? "ANSWERED" : "RECOVERY_REQUIRED"); assert.deepEqual(repeated.command, failed.command);
    console.log(`PASS: ${edge}-COMMIT answer ACK loss; original query recovers ${repeated.status}, no query or effect replay`);
  }
  assert.equal(pids.length, 40); assert.equal(new Set(pids).size, 40);
  console.log(`PASS: 40 distinct fresh processes / nine isolated namespaces; ${totals.queries} fixture status queries, ${totals.effects} fixture original uncertain actions, zero repeated actions, no model/email/live ERP/cloud calls`);
}
