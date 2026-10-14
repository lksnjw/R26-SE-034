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
import { operationJobQueue } from "../src/runner/operation-jobs.js";
import { assertOperationTaskLedger, configureOperationTaskDispatch, recoverOperationTaskOutboxes } from "../src/runner/operation-task-outbox.js";
import { buildApp } from "../src/http/app.js";

// Real encrypted/scoped Firestore commits and clean child-process owners.
// Queue and reviewed ERP SDK are fixtures: no mailbox/model/remote ERP/cloud.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback demo emulator and no credential file are required");
const phase = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : undefined;
const stages = ["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"], edges = ["before", "after"];
const phases = new Set(["seed", "admit", "execute", "duplicate", "old-duplicate", "approve", "same-key", "recover",
  ...stages.flatMap(stage => edges.map(edge => `admit-${stage}-${edge}`)),
  ...["DECISION", "ENQUEUE_INTENT", "ENQUEUED"].flatMap(stage => edges.map(edge => `approve-${stage}-${edge}`)),
  ...["wait", "answer", "terminal", "claim", "intent"].flatMap(stage => edges.map(edge => `${stage}-${edge}`))]);
const commandFor = (run, first = false) => {
  const ledger = assertOperationTaskLedger(run), generation = first ? ledger.generations[0] : ledger.generations.at(-1);
  return { profile: "operation-task-delivery/v1", executionId: run.id, taskId: generation.taskId };
};
async function child() {
  const instanceId = randomUUID();
  assert(phases.has(phase)); const workspaceId = process.env.LCWE_OPERATION_QA_WORKSPACE, key = process.env.LCWE_OPERATION_QA_KEY;
  assert(/^test_[a-f0-9]{32}_operationtask$/.test(workspaceId ?? "")); assert.equal(Buffer.from(key ?? "", "base64").length, 32);
  const config = { ...loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", STORAGE_ENCRYPTION_KEY: key,
    JWT_SECRET: "firestore-operation-qualification-fixture-secret" }), readWorkerLeaseMs: 5000 };
  const storage = await FirestoreRecordPersistence.open(key, { projectId, databaseId: "(default)", workspaceId }), repository = await Repository.open(storage);
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json")), base = registries.snapshot();
  const read = toolSchema.parse({ ...base.tools[0], tool_id: "operation-read-fixture", name: "demo.status", mcp_tool_name: "demo.status", is_read_only: true,
    allowed_roles: ["Platform Admin"], risk_level: "low", side_effects: [], input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
      output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } });
  const effect = toolSchema.parse({ ...read, tool_id: "operation-send-fixture", name: "demo.dispatch", mcp_tool_name: "demo.dispatch", is_read_only: false, side_effects: ["Synthetic notification"],
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
    bridge_contract: { ...read.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } });
  const tools = [read, effect]; registries.snapshot = () => ({ ...base, tools }); registries.findTool = name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name));
  registries.hash = () => capabilityContractHash(effect);
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator); let reads = 0, effects = 0;
  const session = await createErpbridgeMcpSession({ baseURL: "https://operation.firestore-fixture.example.test", token: "synthetic-stable-token", timeoutMs: 1000, validator,
    admissionAuthorizer: admissionAuthorizer(repository, registries), sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {},
      listTools: async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract.output_schema,
        _meta: { "toolplane.resourceDigest": tool.bridge_contract.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } })),
      callTool: async (name, args) => {
        if (name === exactBridgeName(effect)) { effects++; return { content: [], structuredContent: { accepted: true } }; }
        assert.equal(name, exactBridgeName(read)); reads++; return { content: [], structuredContent: { value: args.value } };
      } } });
  const services = { repository, registries, validator, executor, config, erpbridgeSession: session }, enqueued = [];
  bindExecutionHost(repository, "bounded-invocation"); configureOperationTaskDispatch(repository, { timeoutMs: 1000, enqueue: async command => {
    enqueued.push(structuredClone(command)); return { taskId: command.taskId, outcome: phase === "recover" ? "ALREADY_EXISTS" : "CREATED" };
  } });
  const app = await buildApp(services, { executionHost: "bounded-invocation" }), request = (method, url, payload, actorId = "requester") => app.inject({ method, url,
    headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actorId, expiresIn: 3600 })}` }, ...(payload ? { payload } : {}) });
  const fullWriter = storage.save.bind(storage), scopedWriter = storage.saveExecutionCheckpoint.bind(storage);
  let injected = false, attemptedCommand, receipt, httpStatus, replayed;
  try {
    if (phase === "seed") {
      assert.equal(await repository.read(state => Object.keys(state.executions).length), 0);
      await repository.mutate(state => {
        const now = new Date().toISOString(); state.roles.review = { id: "review", name: "Independent approver", description: "Review only", permissions: ["execution:approve"], createdAt: now };
        for (const id of ["requester", "reviewer"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: id === "reviewer" ? "review" : "role_admin",
          permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: now };
        const yaml = stringify({ name: "Bounded original", description: "Synthetic reviewed operation", trigger: { type: "manual" }, steps: [
          { id: "inspect", action: read.name, parameters: { value: "original" } }, { id: "send", action: effect.name, parameters: { value: "{{inspect.structuredContent.value}}" } } ] });
        state.workflows.flow = { id: "flow", name: "Bounded original", description: "", owner: { id: "requester", name: "requester" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" }, steps: 2,
          successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml, archived: false }; state.versions.flow = [];
      });
      const actor = await repository.effectiveUser("requester");
      await repository.mutate(state => updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["review"], ttlSeconds: 300, separationOfDuties: true }));
      for (const observation of (await observeCapabilities({ repository, registries, session, user: actor })).observations)
        await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash,
          decisionKey: `fixture-review-${observation.toolId}`, effectClass: observation.toolId === effect.tool_id ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never",
          note: "Synthetic reviewed contract", ...(observation.toolId === effect.tool_id ? { requireIndependentApproval: true } : {}) } });
      const published = await request("POST", "/api/workflows/flow/publish", {}); assert.equal(published.statusCode, 200, published.body);
      return { pid: process.pid, instanceId, reads, effects };
    }
    const initial = await repository.readAuthoritative(state => structuredClone(Object.values(state.executions)[0]));
    const fault = phase.includes("-before") || phase.includes("-after"), edge = phase.endsWith("-after") ? "after" : "before";
    const matches = run => {
      const generations = run?.operationSecret?.taskDispatchSecret?.generations, last = generations?.at(-1);
      if (!last) return false;
      if (phase.startsWith("admit-")) return generations.length === 1 && last.state === phase.split("-")[1];
      if (phase.startsWith("approve-")) return generations.length === 2 && (phase.split("-")[1] === "DECISION" ? last.state === "PREPARED" : last.state === phase.split("-")[1]);
      if (phase.startsWith("wait-")) return !!generations[0].completion;
      if (phase.startsWith("answer-")) return run.operationSecret.intents.send?.state === "ACKNOWLEDGED";
      if (phase.startsWith("terminal-")) return !!generations[1]?.completion;
      if (phase.startsWith("claim-")) return run.operationSecret.state === "CLAIMED";
      if (phase.startsWith("intent-")) return run.operationSecret.intents.send?.state === "DISPATCH_INTENT";
      return false;
    };
    const faultWrite = async (run, write) => {
      if (fault && !injected && matches(run)) {
        injected = true; attemptedCommand = commandFor(run); if (edge === "after") await write(); throw new Error("Synthetic checkpoint acknowledgement loss");
      } return write();
    };
    storage.save = payload => faultWrite(Object.values(JSON.parse(Buffer.from(payload).toString()).executions)[0], () => fullWriter(payload));
    storage.saveExecutionCheckpoint = checkpoint => faultWrite(checkpoint.execution, () => scopedWriter(checkpoint));
    if (phase === "admit" || phase === "same-key" || phase.startsWith("admit-")) {
      const reply = await request("POST", "/api/workflows/flow/run", { mode: "async-operation", idempotencyKey: "firestore-operation-original-key-001", input: {} });
      httpStatus = reply.statusCode; replayed = reply.json().meta?.replayed; assert(fault ? httpStatus >= 500 : httpStatus === 202, reply.body);
    } else if (phase === "approve" || phase.startsWith("approve-")) {
      const approval = initial.runtimeApprovalSecret.records[initial.runtimeApprovalSecret.activeId], body = { approvalId: approval.id, baseVersion: 1,
        reviewHash: approval.reviewHash, decisionKey: "firestore-independent-original-decision-001" };
      const reply = await request("POST", `/api/executions/${initial.id}/approve`, body, "reviewer"); httpStatus = reply.statusCode;
      assert.equal(httpStatus, fault ? 503 : 200, reply.body); replayed = reply.json().data?.replayed;
    } else if (phase === "recover") { await recoverOperationTaskOutboxes(repository); }
    else {
      assert(initial); const command = commandFor(initial, phase === "old-duplicate");
      if (initial.operationSecret.lease) { const remaining = initial.operationSecret.lease.expiresAt - Date.now(); assert(remaining <= 5000);
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 20)); }
      if (fault) await assert.rejects(operationJobQueue(services).executeTask(command, { timeoutMs: 4000 }));
      else { receipt = await operationJobQueue(services).executeTask(command, { timeoutMs: 4000 }); assert.equal(receipt.deliveryVerified, false);
        assert.deepEqual(await operationJobQueue(services).executeTask(command, { timeoutMs: 4000 }), receipt); }
    }
    if (fault) { assert(injected); assert.throws(() => repository.assertAuthority()); }
    const current = fault ? undefined : await repository.readAuthoritative(state => structuredClone(Object.values(state.executions)[0]));
    const approval = current?.runtimeApprovalSecret?.records[current.runtimeApprovalSecret.activeId];
    return { pid: process.pid, instanceId, reads, effects, httpStatus, replayed, enqueued, receipt, runStatus: current?.status,
      command: attemptedCommand ?? (current ? commandFor(current) : null), generations: current?.operationSecret?.taskDispatchSecret?.generations.length ?? 0,
      approval: approval ? { id: approval.id, expiresAt: approval.expiresAt, reviewHash: approval.reviewHash, state: approval.state } : null };
  } finally { storage.save = fullWriter; storage.saveExecutionCheckpoint = scopedWriter; await app.close(); await session.close(); await repository.close(); }
}
if (phase) console.log(JSON.stringify(await child()));
else {
  const launch = promisify(execFile), script = fileURLToPath(import.meta.url), pids = [], instances = new Set(), totals = { reads: 0, effects: 0 }; let namespaces = 0;
  const namespace = () => { namespaces++; return { LCWE_OPERATION_QA_WORKSPACE: `test_${randomUUID().replaceAll("-", "")}_operationtask`, LCWE_OPERATION_QA_KEY: randomBytes(32).toString("base64") }; };
  const invoke = async (phase, fixture) => {
    const { stdout } = await launch(process.execPath, ["--import", "tsx/esm", script, "--phase", phase], { cwd: process.cwd(), env: { ...process.env, ...fixture, NODE_ENV: "test" }, timeout: 60_000, maxBuffer: 256_000, windowsHide: true });
    const result = JSON.parse(stdout.trim()); assert(Number.isSafeInteger(result.pid) && result.pid > 0); assert(!instances.has(result.instanceId));
    instances.add(result.instanceId); pids.push(result.pid); totals.reads += result.reads; totals.effects += result.effects; return result;
  };
  const assertWait = result => { assert.equal(result.receipt.milestone, "AWAITING_APPROVAL"); assert.equal(result.effects, 0); };
  const assertDone = result => { assert.equal(result.receipt.checkpointStatus, "DONE"); assert.equal(result.reads, 0); assert.equal(result.effects, 1); };
  const base = namespace(); await invoke("seed", base); const admitted = await invoke("admit", base), waiting = await invoke("execute", base); assertWait(waiting); assert.equal(waiting.reads, 1);
  const decided = await invoke("approve", base), done = await invoke("execute", base); assertDone(done); assert.equal(done.approval.expiresAt, waiting.approval.expiresAt);
  const duplicate = await invoke("duplicate", base), old = await invoke("old-duplicate", base), replay = await invoke("same-key", base), decisionReplay = await invoke("approve", base);
  assert.deepEqual(duplicate.receipt, done.receipt); assert.deepEqual(old.receipt, waiting.receipt); assert.deepEqual(replay.command, decided.command);
  assert.equal(replay.replayed, true); assert.equal(decisionReplay.replayed, true); assert.equal(duplicate.effects + old.effects + replay.effects + decisionReplay.effects, 0);
  assert.deepEqual(waiting.command, admitted.command); console.log("PASS: fresh-process read/wait/independent approval/effect, unchanged expiry, exact old/new duplicates and same-key admission");
  for (const stage of stages) for (const edge of edges) {
    const fixture = namespace(); await invoke("seed", fixture); const failed = await invoke(`admit-${stage}-${edge}`, fixture), recovered = await invoke("recover", fixture);
    const absent = stage === "PREPARED" && edge === "before"; assert.equal(recovered.generations, absent ? 0 : 1); assert.equal(failed.reads + recovered.reads + failed.effects + recovered.effects, 0);
    if (!absent) { assert.deepEqual(recovered.command, failed.command); const waited = await invoke("execute", fixture); assertWait(waited); assert.equal(waited.reads, 1); }
    console.log(`PASS: ${edge}-COMMIT admission ${stage} loss preserves only original task`);
  }
  for (const stage of ["DECISION", "ENQUEUE_INTENT", "ENQUEUED"]) for (const edge of edges) {
    const fixture = namespace(); await invoke("seed", fixture); await invoke("admit", fixture); const waited = await invoke("execute", fixture); const failed = await invoke(`approve-${stage}-${edge}`, fixture);
    const recovered = await invoke("recover", fixture), decided = await invoke("approve", fixture), done = await invoke("execute", fixture), old = await invoke("old-duplicate", fixture);
    assertDone(done); assert.equal(done.approval.expiresAt, waited.approval.expiresAt); assert.equal(done.approval.reviewHash, waited.approval.reviewHash);
    assert.equal(decided.replayed, stage !== "DECISION" || edge === "after"); assert.equal(decided.generations, 2);
    if (!(stage === "DECISION" && edge === "before")) { assert.deepEqual(recovered.command, failed.command); assert.deepEqual(decided.command, failed.command); }
    assert.deepEqual(old.receipt, waited.receipt); assert.equal(failed.effects + recovered.effects + decided.effects + old.effects, 0);
    console.log(`PASS: ${edge}-COMMIT approval ${stage} loss retains original decision/generation and no read replay`);
  }
  for (const stage of ["wait", "answer", "terminal"]) for (const edge of edges) {
    const fixture = namespace(); await invoke("seed", fixture); await invoke("admit", fixture);
    if (stage !== "wait") { await invoke("execute", fixture); await invoke("approve", fixture); }
    const failed = await invoke(`${stage}-${edge}`, fixture);
    if (stage === "wait") { await invoke("approve", fixture); assertDone(await invoke("execute", fixture)); }
    const duplicate = await invoke("duplicate", fixture), old = await invoke("old-duplicate", fixture);
    assert.equal(duplicate.effects + duplicate.reads + old.effects + old.reads, 0); assert.equal(old.receipt.milestone, "AWAITING_APPROVAL");
    assert.equal(duplicate.receipt.checkpointStatus, stage === "answer" ? edge === "after" ? "RECOVERY_REQUIRED" : "RECONCILIATION_REQUIRED" : "DONE");
    assert.equal(failed.reads, stage === "wait" ? 1 : 0); assert.equal(failed.effects, stage === "wait" ? 0 : 1);
    console.log(`PASS: ${edge}-COMMIT ${stage} loss recovers saved ${duplicate.receipt.checkpointStatus}, no repeated effect/read`);
  }
  for (const stage of ["claim", "intent"]) for (const edge of edges) {
    const fixture = namespace(); await invoke("seed", fixture); await invoke("admit", fixture); const waited = await invoke("execute", fixture); await invoke("approve", fixture);
    const failed = await invoke(`${stage}-${edge}`, fixture), recovered = await invoke("duplicate", fixture), old = await invoke("old-duplicate", fixture);
    assert.equal(failed.effects + failed.reads + recovered.reads + old.effects + old.reads, 0);
    const neverClaimed = stage === "claim" && edge === "before";
    assert.equal(recovered.effects, neverClaimed ? 1 : 0);
    assert.equal(recovered.receipt.checkpointStatus, neverClaimed ? "DONE" : stage === "intent" && edge === "after" ? "RECONCILIATION_REQUIRED" : "RECOVERY_REQUIRED");
    assert.deepEqual(old.receipt, waited.receipt); assert.equal(recovered.approval.expiresAt, waited.approval.expiresAt);
    console.log(`PASS: ${edge}-COMMIT ${stage} loss; original recovery ${recovered.receipt.checkpointStatus}, no repeated call/approval refresh`);
  }
  // Windows can recycle a terminated child's PID. Each awaited execFile starts
  // a fresh process; retain both counts and its one-shot instance nonce.
  assert.equal(instances.size, pids.length); assert.equal(namespaces, 23);
  console.log(`PASS: ${pids.length} fresh clean child starts (${new Set(pids).size} distinct observed PIDs) / ${namespaces} isolated encrypted namespaces; ${totals.reads} fixture reads and ${totals.effects} fixture effects, no model/mailbox/live ERP/cloud calls`);
  if (process.argv.includes("--then-native-operation")) {
    const { stdout } = await launch(process.execPath, ["--import", "tsx/esm", "scripts/qualify-firebase-adapter.mjs", "--run-docker-operation"],
      { cwd: process.cwd(), env: process.env, timeout: 600000, maxBuffer: 256000, windowsHide: true }); process.stdout.write(stdout);
  }
}
