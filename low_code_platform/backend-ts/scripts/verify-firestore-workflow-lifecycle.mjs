import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";
import { updateRuntimeApprovalPolicy } from "../src/runner/runtime-approvals.js";
import { bindExecutionHost } from "../src/runner/execution-host.js";
import { operationJobQueue } from "../src/runner/operation-jobs.js";
import { assertOperationTaskLedger, configureOperationTaskDispatch, operationTaskReceipt } from "../src/runner/operation-task-outbox.js";
import { configureWorkflowLifecycle } from "../src/runner/workflow-lifecycle-host.js";
import { advanceWorkflowLifecycle } from "../src/runner/workflow-lifecycle.js";
import { buildApp } from "../src/http/app.js";

// Actual encrypted Firestore commits, new clean process owners, normal HTTP
// publication/activation/review. Queue and ERP responses are synthetic. This
// does not qualify Cloud Scheduler delivery, Docker ERP, email or a live model.
const projectId = "demo-lcwe-records", digest = value => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback demo emulator and no credential file are required");
const phase = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : undefined;
const faultStages = ["claim", "run", "link", "expire"], edges = ["before", "after"];
const phases = new Set(["seed", "admit", "execute", "approve", "expire", "duplicate", "pause", "revoke", "publication",
  ...faultStages.flatMap(stage => edges.map(edge => `${stage}-${edge}`))]);
const commandFor = (run, first = false) => ({ profile: "operation-task-delivery/v1", executionId: run.id,
  taskId: (first ? assertOperationTaskLedger(run).generations[0] : assertOperationTaskLedger(run).generations.at(-1)).taskId });
function facts(state) {
  const runs = Object.values(state.executions).filter(run => run.scheduleSource), occurrences = Object.values(state.scheduleOccurrences);
  const run = runs[0], approval = run?.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId];
  return { runCount: runs.length, occurrenceCount: occurrences.length, occurrences: occurrences.map(value => ({ id: value.id, state: value.state,
    executionId: value.executionId ?? null, idempotencyKey: value.idempotencyKey, scheduledFor: value.scheduledFor, reportWindow: value.reportWindow ?? null })),
    runId: run?.id ?? null, status: run?.status ?? null, command: run ? commandFor(run) : null,
    scheduleSource: run?.scheduleSource ?? null, input: run?.workflowSnapshot?.input ?? null, outputHash: digest(run?.stepOutputs ?? {}),
    approval: approval ? { id: approval.id, expiresAt: approval.expiresAt, reviewHash: approval.reviewHash, state: approval.state, evidenceHash: digest(approval) } : null,
    failureCategory: run?.failure?.failureCategory ?? null, eventHash: digest(run ? state.executionEvents[run.id] : []),
    expiryEvents: run ? state.executionEvents[run.id].filter(event => event.type === "approval.expired").length : 0 };
}
async function child() {
  assert(phases.has(phase)); const instanceId = randomUUID(), workspaceId = process.env.LCWE_LIFECYCLE_QA_WORKSPACE, key = process.env.LCWE_LIFECYCLE_QA_KEY;
  assert(/^test_[a-f0-9]{32}_lifecycle$/.test(workspaceId ?? "")); assert.equal(Buffer.from(key ?? "", "base64").length, 32);
  const cadence = process.env.LCWE_LIFECYCLE_QA_CADENCE ?? "daily"; assert(["daily", "weekly", "monthly"].includes(cadence));
  const config = { ...loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", STORAGE_ENCRYPTION_KEY: key,
    JWT_SECRET: "firestore-lifecycle-qualification-fixture-secret" }), readWorkerLeaseMs: 5000 };
  const storage = await FirestoreRecordPersistence.open(key, { projectId, databaseId: "(default)", workspaceId }), repository = await Repository.open(storage);
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json")), base = registries.snapshot();
  const read = toolSchema.parse({ ...base.tools[0], tool_id: "lifecycle-report-fixture", name: "demo.calendarReport", mcp_tool_name: "demo.calendarReport", is_read_only: true,
    allowed_roles: ["Platform Admin"], risk_level: "low", side_effects: [], input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" } },
      required: ["startAt", "endAt"], additionalProperties: false }, report_coverage_contract: { profile: "report-coverage/v1", start_parameter: "startAt", end_parameter: "endAt",
      covered_start_path: ["coveredStartAt"], covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"] },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: {
      type: "object", properties: { coveredStartAt: { type: "string" }, coveredEndAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
        items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }, itemCount: { type: "integer" }, summary: { type: "string" } },
      required: ["coveredStartAt", "coveredEndAt", "complete", "hasMore", "items", "itemCount", "summary"], additionalProperties: false } } });
  const effect = toolSchema.parse({ ...read, tool_id: "lifecycle-send-fixture", name: "demo.calendarNotify", mcp_tool_name: "demo.calendarNotify", is_read_only: false,
    report_coverage_contract: undefined, side_effects: ["Synthetic notification"], input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
    bridge_contract: { ...read.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } });
  const tools = [read, effect]; registries.snapshot = () => ({ ...base, tools }); registries.findTool = name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name));
  registries.hash = () => `sha256:${digest(tools)}`;
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator); let reads = 0, effects = 0;
  const session = await createErpbridgeMcpSession({ baseURL: "https://lifecycle.firestore-fixture.example.test", token: "synthetic-stable-token", timeoutMs: 1000, validator,
    admissionAuthorizer: admissionAuthorizer(repository, registries), sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {},
      listTools: async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract.output_schema,
        _meta: { "toolplane.resourceDigest": tool.bridge_contract.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } })),
      callTool: async (name, args) => {
        if (name === exactBridgeName(effect)) { effects++; return { content: [], structuredContent: { accepted: true } }; }
        assert.equal(name, exactBridgeName(read)); reads++; return { content: [], structuredContent: { coveredStartAt: args.startAt, coveredEndAt: args.endAt,
          complete: true, hasMore: false, items: [{ id: "synthetic-invoice" }], itemCount: 1, summary: "One synthetic calendar report" } };
      } } });
  const services = { repository, registries, validator, executor, config, erpbridgeSession: session }, enqueued = [];
  bindExecutionHost(repository, "bounded-invocation"); configureOperationTaskDispatch(repository, { timeoutMs: 1000, enqueue: async command => {
    enqueued.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" };
  } }); configureWorkflowLifecycle(repository);
  const app = await buildApp(services, { executionHost: "bounded-invocation" }), request = (method, url, payload, actorId = "requester") => app.inject({ method, url,
    headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actorId, expiresIn: 3600 })}` }, ...(payload ? { payload } : {}) });
  const fullWriter = storage.save.bind(storage), scopedWriter = storage.saveExecutionCheckpoint.bind(storage);
  let injected = false, attempted, result, receipt;
  try {
    if (phase === "seed") {
      assert.equal(await repository.read(state => Object.keys(state.executions).length), 0);
      await repository.mutate(state => {
        const now = new Date().toISOString(); state.roles.review = { id: "review", name: "Independent approver", description: "Review only", permissions: ["execution:approve"], createdAt: now };
        for (const id of ["requester", "reviewer"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: id === "reviewer" ? "review" : "role_admin",
          permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: now };
        const yaml = stringify({ name: "Calendar report", description: "Synthetic complete report and independently reviewed notification", trigger: { type: "manual", config: { inputSchema: {
          type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } }, required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps: [
          { id: "lookupReport", action: read.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
          { id: "send", action: effect.name, parameters: { value: "{{lookupReport.structuredContent.summary}}" } } ] });
        state.workflows.flow = { id: "flow", name: "Calendar report", description: "", owner: { id: "requester", name: "requester" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" }, steps: 2,
          successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml, archived: false }; state.versions.flow = [];
      });
      const actor = await repository.effectiveUser("requester");
      await repository.mutate(state => updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true,
        approverRoleIds: ["review"], ttlSeconds: 300, separationOfDuties: true }));
      for (const observation of (await observeCapabilities({ repository, registries, session, user: actor })).observations)
        await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash,
          decisionKey: `fixture-review-${observation.toolId}`, effectClass: observation.toolId === effect.tool_id ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never",
          note: "Synthetic reviewed lifecycle contract", ...(observation.toolId === effect.tool_id ? { requireIndependentApproval: true } : {}) } });
      const published = await request("POST", "/api/workflows/flow/publish", {}); assert.equal(published.statusCode, 200, published.body);
      const state = await repository.snapshot(), workflow = state.workflows.flow;
      const saved = await request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-calendar-schedule-command/v2", baseRevision: 0,
        workflowVersion: workflow.publishedVersion, workflowHash: `sha256:${createHash("sha256").update(workflow.yaml).digest("hex")}`,
        enabled: true, timezone: "Asia/Colombo", localTime: "09:00", cadence, reportingPeriod: `previous-calendar-${cadence === "daily" ? "day" : cadence === "weekly" ? "week" : "month"}`,
        ...(cadence === "weekly" ? { dayOfWeek: 1 } : cadence === "monthly" ? { dayOfMonth: 1 } : {}), misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300,
        servicePrincipalId: "requester", input: {}, reportWindowBinding: { profile: "workflow-report-window-input-binding/v1", startAtInput: "reportStartAt", endAtInput: "reportEndAt" } });
      assert.equal(saved.statusCode, 200, saved.body);
      return { pid: process.pid, instanceId, reads, effects, due: saved.json().data.nextRunAt };
    }
    const initial = await repository.snapshot(), prior = facts(initial), run = Object.values(initial.executions).find(value => value.scheduleSource);
    const nowMs = phase.startsWith("expire") ? Date.parse(prior.approval.expiresAt) : Date.parse(prior.occurrences[0]?.scheduledFor ?? initial.schedules["schedule-flow"].nextRunAt);
    const fault = faultStages.some(stage => phase.startsWith(`${stage}-`)), stage = phase.split("-")[0], edge = phase.split("-")[1];
    const matches = (state, selectedRun) => stage === "claim" ? Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING") && !Object.values(state.executions).some(value => value.scheduleSource) :
      stage === "run" ? Object.values(state.executions).some(value => value.scheduleSource && value.operationSecret?.taskDispatchSecret?.generations[0]?.state === "PREPARED") :
      stage === "link" ? Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTED") :
      stage === "expire" && selectedRun?.failure?.failureCategory === "RUNTIME_APPROVAL_EXPIRED";
    const faultWrite = async (state, selectedRun, write) => {
      if (fault && !injected && matches(state, selectedRun)) {
        injected = true; attempted = facts(state);
        if (edge === "after") await write();
        throw new Error("Synthetic lifecycle checkpoint acknowledgement loss");
      }
      return write();
    };
    storage.save = payload => { const state = JSON.parse(Buffer.from(payload).toString()); return faultWrite(state, undefined, () => fullWriter(payload)); };
    storage.saveExecutionCheckpoint = checkpoint => {
      const state = { ...initial, executions: { ...initial.executions, [checkpoint.executionId]: checkpoint.execution },
        executionEvents: { ...initial.executionEvents, [checkpoint.executionId]: checkpoint.events ?? initial.executionEvents[checkpoint.executionId] } };
      return faultWrite(state, checkpoint.execution, () => scopedWriter(checkpoint));
    };
    if (["pause", "revoke", "publication"].includes(phase)) {
      await repository.mutate(state => {
        if (phase === "pause") { state.schedules["schedule-flow"].state = "PAUSED"; state.schedules["schedule-flow"].nextRunAt = null; }
        if (phase === "revoke") state.users.requester.status = "Disabled";
        if (phase === "publication") state.workflows.flow.publishedVersion++;
      });
      result = await advanceWorkflowLifecycle(services, { nowMs });
    } else if (phase === "approve") {
      const approval = run.runtimeApprovalSecret.records[run.runtimeApprovalSecret.activeId], body = { approvalId: approval.id, baseVersion: approval.version,
        reviewHash: approval.reviewHash, decisionKey: "firestore-lifecycle-independent-decision-001" };
      assert.equal((await request("POST", `/api/executions/${run.id}/approve`, body)).statusCode, 403);
      const reply = await request("POST", `/api/executions/${run.id}/approve`, body, "reviewer"); assert.equal(reply.statusCode, 200, reply.body);
    } else if (phase === "execute" || phase === "duplicate") {
      receipt = await operationJobQueue(services).executeTask(commandFor(run, phase === "duplicate"), { timeoutMs: 4000 });
      assert.equal(receipt.deliveryVerified, false);
    } else {
      if (fault) { await assert.rejects(advanceWorkflowLifecycle(services, { nowMs })); assert(injected); assert.throws(() => repository.assertAuthority()); }
      else result = await advanceWorkflowLifecycle(services, { nowMs });
    }
    const current = fault ? null : await repository.snapshot();
    if (current && current.executions[prior.runId]?.status === "FAILED") assert.equal(operationTaskReceipt(current, current.executions[prior.runId], commandFor(current.executions[prior.runId], true)).milestone, "AWAITING_APPROVAL");
    return { pid: process.pid, instanceId, reads, effects, enqueued, injected, attempted, result, receipt, facts: current ? facts(current) : null };
  } finally { storage.save = fullWriter; storage.saveExecutionCheckpoint = scopedWriter; await app.close(); await session.close(); await repository.close(); }
}
if (phase) console.log(JSON.stringify(await child()));
else {
  const launch = promisify(execFile), script = fileURLToPath(import.meta.url), instances = new Set(), pids = [], totals = { reads: 0, effects: 0 }; let namespaces = 0;
  const namespace = (cadence = "daily") => { namespaces++; return { LCWE_LIFECYCLE_QA_WORKSPACE: `test_${randomUUID().replaceAll("-", "")}_lifecycle`,
    LCWE_LIFECYCLE_QA_KEY: randomBytes(32).toString("base64"), LCWE_LIFECYCLE_QA_CADENCE: cadence }; };
  const invoke = async (phase, fixture) => {
    const { stdout } = await launch(process.execPath, ["--import", "tsx/esm", script, "--phase", phase], { cwd: process.cwd(), env: { ...process.env, ...fixture, NODE_ENV: "test" },
      timeout: 60_000, maxBuffer: 256_000, windowsHide: true });
    const result = JSON.parse(stdout.trim()); assert(Number.isSafeInteger(result.pid) && result.pid > 0); assert(!instances.has(result.instanceId));
    instances.add(result.instanceId); pids.push(result.pid); totals.reads += result.reads; totals.effects += result.effects; return result;
  };
  const sameOccurrence = (a, b) => { assert.equal(b.facts.runCount, 1); assert.equal(b.facts.occurrenceCount, 1); assert.deepEqual(b.facts.occurrences, a.facts.occurrences);
    assert.deepEqual(b.facts.scheduleSource, a.facts.scheduleSource); assert.deepEqual(b.facts.input, a.facts.input); };
  for (const cadence of ["daily", "weekly", "monthly"]) {
    const fixture = namespace(cadence); await invoke("seed", fixture); const admitted = await invoke("admit", fixture), duplicate = await invoke("admit", fixture);
    assert.equal(admitted.result.admitted, 1); assert.equal(admitted.enqueued.length, 1); assert.equal(duplicate.result.admitted, 0); assert.equal(duplicate.enqueued.length, 0);
    sameOccurrence(admitted, duplicate); assert.deepEqual(admitted.facts.input, { reportStartAt: admitted.facts.occurrences[0].reportWindow.startAt, reportEndAt: admitted.facts.occurrences[0].reportWindow.endAt });
    assert.equal(admitted.reads + admitted.effects + duplicate.reads + duplicate.effects, 0);
    if (cadence === "daily") {
      const waiting = await invoke("execute", fixture); assert.equal(waiting.receipt.milestone, "AWAITING_APPROVAL"); assert.equal(waiting.reads, 1); assert.equal(waiting.effects, 0);
      await invoke("approve", fixture); const done = await invoke("execute", fixture), old = await invoke("duplicate", fixture);
      assert.equal(done.facts.status, "DONE"); assert.equal(done.effects, 1); assert.equal(done.reads, 0); assert.equal(done.facts.approval.expiresAt, waiting.facts.approval.expiresAt);
      assert.deepEqual(old.receipt, waiting.receipt); assert.equal(old.reads + old.effects, 0);
    }
    console.log(`PASS: ${cadence} fresh-owner original window/admission, duplicate cron, zero lifecycle tool calls`);
  }
  for (const stage of ["claim", "run", "link"]) for (const edge of edges) {
    const fixture = namespace(); await invoke("seed", fixture); const failed = await invoke(`${stage}-${edge}`, fixture), recovered = await invoke("admit", fixture), duplicate = await invoke("admit", fixture);
    assert.equal(recovered.facts.runCount, 1); assert.equal(recovered.facts.occurrenceCount, 1); assert.equal(recovered.facts.occurrences[0].state, "ADMITTED");
    if (!(stage === "claim" && edge === "before")) {
      assert.equal(recovered.facts.occurrences[0].id, failed.attempted.occurrences[0].id); assert.equal(recovered.facts.occurrences[0].idempotencyKey, failed.attempted.occurrences[0].idempotencyKey);
      assert.deepEqual(recovered.facts.occurrences[0].reportWindow, failed.attempted.occurrences[0].reportWindow);
    }
    if (stage === "link" || stage === "run" && edge === "after") assert.equal(recovered.facts.runId, failed.attempted.runId);
    assert.equal(failed.enqueued.length + recovered.enqueued.length + duplicate.enqueued.length, 1);
    assert.equal(failed.reads + failed.effects + recovered.reads + recovered.effects, 0); sameOccurrence(recovered, duplicate);
    console.log(`PASS: ${edge}-COMMIT ${stage} loss; one original occurrence/run/task, no ERP replay`);
  }
  for (const edge of edges) {
    const fixture = namespace(); await invoke("seed", fixture); await invoke("admit", fixture); const waiting = await invoke("execute", fixture);
    const failed = await invoke(`expire-${edge}`, fixture), expired = await invoke("expire", fixture), duplicate = await invoke("expire", fixture), old = await invoke("duplicate", fixture);
    assert.equal(expired.result.expired, edge === "before" ? 1 : 0); assert.equal(duplicate.result.expired, 0); assert.equal(expired.facts.status, "FAILED");
    assert.equal(expired.facts.failureCategory, "RUNTIME_APPROVAL_EXPIRED"); assert.equal(expired.facts.expiryEvents, 1);
    assert.deepEqual(expired.facts.approval, waiting.facts.approval); assert.equal(expired.facts.outputHash, waiting.facts.outputHash);
    assert.equal(expired.facts.eventHash, duplicate.facts.eventHash); assert.deepEqual(old.receipt, waiting.receipt);
    assert.equal(failed.reads + failed.effects + expired.reads + expired.effects + old.reads + old.effects, 0);
    assert.equal(failed.enqueued.length + expired.enqueued.length + duplicate.enqueued.length, 0);
    console.log(`PASS: ${edge}-COMMIT expiry loss; unchanged original review/results, one terminal event, old WAIT receipt and no send`);
  }
  for (const reason of ["pause", "revoke", "publication"]) {
    const fixture = namespace(); await invoke("seed", fixture); const denied = await invoke(reason, fixture);
    assert.equal(denied.facts.runCount, 0); assert.equal(denied.enqueued.length + denied.reads + denied.effects, 0);
    console.log(`PASS: ${reason} drift prevents scheduled admission`);
  }
  assert.equal(instances.size, pids.length); assert.equal(namespaces, 14);
  console.log(`PASS: ${pids.length} fresh clean child starts (${new Set(pids).size} distinct observed PIDs) / ${namespaces} encrypted namespaces; ${totals.reads} fixture reads / ${totals.effects} fixture effects; no native cron, model, email, Docker ERP or deployment proof`);
}
