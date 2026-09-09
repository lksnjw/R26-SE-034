import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { Repository, restoreState, type PersistenceBackend, type RepositoryState } from "../src/repository/store.js";
import { applyExecutionCheckpoint, type ExecutionCheckpoint } from "../src/repository/execution-transaction.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry, createDispatchIdentity } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, capabilityContractHash, captureReadAdmissionPin } from "../src/registry/capability-admission.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { updateRuntimeApprovalPolicy } from "../src/runner/runtime-approvals.js";
import { operationJobQueue } from "../src/runner/operation-jobs.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { withoutSecretFields } from "../src/redact/secrets.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { operationReadbackQueue } from "../src/runner/operation-readback-jobs.js";
import { reportWindowFor, workflowScheduleRunner } from "../src/runner/workflow-schedules.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { draftRequirements, emailDraftHash, type EmailDraft } from "../src/delivery/email-draft.js";

const closers: { close(): Promise<unknown> }[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(closers.splice(0).reverse().map(value => value.close())); });
class Records implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  bytes: Buffer | null = null;
  loseWhen: ((state: RepositoryState) => boolean) | undefined;
  async load() { return this.bytes; }
  async save(bytes: Uint8Array) { this.bytes = Buffer.from(bytes); if (this.loseWhen?.(JSON.parse(this.bytes.toString()))) { this.loseWhen = undefined; throw new Error("Fixture post-commit acknowledgement loss"); } }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint) { await this.save(Buffer.from(JSON.stringify(applyExecutionCheckpoint(JSON.parse(this.bytes!.toString()), checkpoint)))); }
  async probe() {} async close() {}
}
async function setup(storage: PersistenceBackend | null = null, withRead = true, withReadback = false, withEmail = false, withReportPagination = false) {
  const repository = await Repository.open(storage), registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const base = registries.snapshot(), original = base.tools[0]!;
  const read = toolSchema.parse({ ...original, allowed_roles: ["Platform Admin"], bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } });
  const reportRead = toolSchema.parse({ ...read, tool_id: "report-coverage-fixture", name: "demo.report", mcp_tool_name: "demo.report",
    input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" }, ...(withReportPagination ? { page: { type: "integer" } } : {}) }, required: ["startAt", "endAt"], additionalProperties: false },
    report_coverage_contract: { profile: "report-coverage/v1", start_parameter: "startAt", end_parameter: "endAt", covered_start_path: ["coveredStartAt"],
      covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"],
      ...(withReportPagination ? { pagination: { profile: "page-number/v1", page_parameter: "page", page_path: ["page"], snapshot_path: ["snapshotId"], total_count_path: ["totalAvailable"], first_page: 1, max_pages: 4, max_items: 100 } } : {}) },
    bridge_contract: { ...read.bridge_contract, resource_digest: "e".repeat(64), output_schema: { type: "object", properties: {
      coveredStartAt: { type: "string" }, coveredEndAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
      items: { type: "array", ...(withReportPagination ? { maxItems: 100 } : {}), items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
      itemCount: { type: "integer" }, summary: { type: "string" }, ...(withReportPagination ? { page: { type: "integer" }, snapshotId: { type: "string" }, totalAvailable: { type: "integer" } } : {}) },
      required: ["coveredStartAt", "coveredEndAt", "complete", "hasMore", "items", "itemCount", "summary", ...(withReportPagination ? ["page", "snapshotId", "totalAvailable"] : [])], additionalProperties: false } } });
  const write = toolSchema.parse({ ...read, tool_id: "operation-fixture", name: "demo.dispatch", mcp_tool_name: "demo.dispatch", is_read_only: false, risk_level: "low", side_effects: ["Synthetic message acceptance"],
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
    bridge_contract: { ...read.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" }, id: { type: "string" } }, required: ["accepted", "id"], additionalProperties: false } } });
  const readback = withReadback ? toolSchema.parse({ ...read, tool_id: "readback-fixture", name: "demo.status", mcp_tool_name: "demo.status",
    input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    bridge_contract: { ...read.bridge_contract, resource_digest: "c".repeat(64), output_schema: { type: "object", properties: {
      value: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" } }, required: ["value", "state", "settled", "observedAt"], additionalProperties: false } } }) : undefined;
  const email = withEmail ? toolSchema.parse({ ...write, tool_id: "email-fixture", name: "demo.email", mcp_tool_name: "demo.email",
    input_schema: { type: "object", properties: { recipient: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["recipient", "subject", "body"], additionalProperties: false },
    side_effects: ["Synthetic email acceptance"], email_delivery_contract: { profile: "email-delivery-input/v1", recipient_parameter: "recipient", subject_parameter: "subject", body_parameter: "body" },
    bridge_contract: { ...write.bridge_contract!, resource_digest: "d".repeat(64) } }) : undefined;
  if (readback) {
    write.input_schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
    write.operation_contract!.readback = { profile: "operation-readback-contract/v1", tool_id: readback.tool_id, contract_hash: capabilityContractHash(readback),
    arguments: [{ parameter: "value", source_path: ["value"] }], correlation: [{ source_path: ["value"], result_path: ["value"] }],
      outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60, evidence_meaning: "operation-state" };
  }
  const tools = [read, reportRead, write, ...(readback ? [readback] : []), ...(email ? [email] : [])];
  vi.spyOn(registries, "snapshot").mockImplementation(() => ({ ...base, tools }));
  vi.spyOn(registries, "findTool").mockImplementation(name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name)));
  vi.spyOn(registries, "hash").mockImplementation(() => capabilityContractHash(toolSchema.parse({ ...write, execution_notes: [read, reportRead, ...(readback ? [readback] : []), ...(email ? [email] : [])].map(capabilityContractHash).join(":") })));
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "operation-fixture-secret-at-least-32-characters", MCP_MODE: "mock", STORAGE_DRIVER: "memory", STORAGE_ENCRYPTION_KEY: "x".repeat(32) });
  const validator = new RegistryValidator(registries, repository);
  let dispatchAdmissionHook: (() => Promise<void>) | undefined;
  const authorize = admissionAuthorizer(repository, registries);
  const sdk = { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract!.output_schema!,
    _meta: { "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } }))),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>, _meta?: Record<string, unknown>): Promise<unknown> => name === exactBridgeName(read) ? { content: [], structuredContent: { value: String(args.value).toUpperCase() } } :
      name === exactBridgeName(reportRead) ? (() => { const page = withReportPagination ? Number(args.page) : 1, hasMore = withReportPagination && page < 3;
        return { content: [], structuredContent: { coveredStartAt: args.startAt, coveredEndAt: args.endAt, complete: !hasMore, hasMore,
          items: [{ id: `invoice-${page}` }], itemCount: 1, summary: `${page} invoice page`, ...(withReportPagination ? { page, snapshotId: "snapshot-daily-invoices", totalAvailable: 3 } : {}) } }; })() :
      readback && name === exactBridgeName(readback) ? { content: [], structuredContent: { value: args.value, state: "ABSENT", settled: true, observedAt: new Date().toISOString() } } :
      { content: [], structuredContent: { accepted: true, id: "fixture-message" } }) };
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "synthetic-only", timeoutMs: 1000, validator, sdkClient: sdk,
    admissionAuthorizer: async (...args) => { await authorize(...args); if (!args[0].is_read_only) await dispatchAdmissionHook?.(); } }); closers.push(session);
  await repository.mutate(state => {
    const now = new Date().toISOString();
    state.roles.review = { id: "review", name: "Independent approver", description: "Review only", permissions: ["execution:approve"], createdAt: now };
    for (const id of ["requester", "reviewer", "observer"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: id === "reviewer" ? "review" : "role_admin", permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: now };
    const yaml = stringify({ name: "Synthetic report dispatch", description: "Read then independently approve a synthetic notification", trigger: { type: "manual" }, steps: [
      ...(withRead ? [{ id: "lookup", action: read.name, parameters: { value: "fixture report" } }] : []), { id: "send", action: write.name, parameters: { value: withRead ? "{{lookup.structuredContent.value}}" : "fixture report" } },
    ] });
    state.workflows.flow = { id: "flow", name: "Synthetic report dispatch", description: "", owner: { id: "requester", name: "requester" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" }, steps: withRead ? 2 : 1,
      successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml, archived: false };
    state.versions.flow = [];
  });
  const actor = (await repository.effectiveUser("requester"))!;
  await repository.mutate(state => updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["review"], ttlSeconds: 300, separationOfDuties: true }));
  const observations = (await observeCapabilities({ repository, registries, session, user: actor })).observations;
  for (const observation of observations) await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash,
    decisionKey: `fixture-review-${observation.toolId}`, effectClass: observation.toolId === write.tool_id || observation.toolId === email?.tool_id ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit synthetic contract review",
    ...(observation.toolId === write.tool_id || observation.toolId === email?.tool_id ? { requireIndependentApproval: true } : {}) } });
  const services = { repository, registries, config, validator, erpbridgeSession: session, executor: new Executor(new ToolRegistry(), validator) };
  const app = await buildApp(services); closers.push(app);
  const request = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, userId = "requester") => app.inject({ method, url, headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: 3600 })}` }, ...(payload ? { payload } : {}) });
  const publish = () => request("POST", "/api/workflows/flow/publish", {});
  const run = (key = "fixture-operation-run-0001", input: Record<string, unknown> = {}) => request("POST", "/api/workflows/flow/run", { mode: "async-operation", idempotencyKey: key, input });
  const review = async (id: string) => { const response = await request("GET", `/api/executions/${id}?view=approval`, undefined, "reviewer"); expect(response.statusCode, response.body).toBe(200); return response.json().data.runtimeApproval; };
  const command = async (id: string) => { const value = await review(id); return { approvalId: value.id, baseVersion: value.version, reviewHash: value.reviewHash, decisionKey: "fixture-decision-0001" }; };
  const wait = async (id: string, status: string) => {
    await vi.waitFor(async () => { expect([status, "FAILED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "CANCELLED"]).toContain((await repository.snapshot()).executions[id]?.status); }, { timeout: 4000 });
    const run = (await repository.snapshot()).executions[id]!; expect(run.status, JSON.stringify({ failure: run.failure, progress: run.readProgress, summary: run.agentSummary, sdkCalls: sdk.callTool.mock.calls })).toBe(status);
  };
  const admit = async () => { const pub = await publish(); expect(pub.statusCode, pub.body).toBe(200); const response = await run(); expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id; await wait(id, "AWAITING_APPROVAL"); return id as string; };
  return { repository, services, app, actor, read, reportRead, write, readback, email, sdk, session, request, publish, run, review, command, wait, admit,
    setDispatchAdmissionHook: (hook: () => Promise<void>) => { dispatchAdmissionHook = hook; } };
}

const scheduleReportWindowBinding = { profile: "workflow-report-window-input-binding/v1" as const,
  startAtInput: "reportStartAt", endAtInput: "reportEndAt" };
async function prepareScheduleWorkflow(s: Awaited<ReturnType<typeof setup>>, page?: number) {
  await s.repository.mutate(state => {
    const workflow = state.workflows.flow!;
    workflow.yaml = stringify({ name: workflow.name, description: "Scheduled report fixture", trigger: { type: "manual", config: { inputSchema: {
      type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" }, unusedWindow: { type: "string" }, count: { type: "number" } },
      required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps: [
      { id: "lookupReport", action: s.reportRead.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}", ...(page === undefined ? {} : { page }) } },
      { id: "send", action: s.write.name, parameters: { value: "{{lookupReport.structuredContent.summary}}" } },
    ] });
    workflow.steps = 2;
    workflow.updatedAt = new Date().toISOString();
  });
  return (await s.repository.snapshot()).workflows.flow!;
}

test("normal publish/readiness/run/approve worker executes exact sequential operation once without a model", async () => {
  const s = await setup();
  const pub = await s.publish(); expect(pub.statusCode, pub.body).toBe(200); expect(pub.json().data).toMatchObject({ executionReadiness: "COMPILED_OPERATION", compiledOperation: { schemaVersion: "workflow-operation-ir/v1", admissionMode: "reviewed" } });
  expect(pub.json().data.compiledOperation).not.toHaveProperty("plan");
  const ready = await s.request("GET", "/api/workflows/flow/readiness"); expect(ready.statusCode, ready.body).toBe(200);
  expect(ready.json().data).toMatchObject({ can_attempt_run: true, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1" });
  const response = await s.run(); expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id; await s.wait(id, "AWAITING_APPROVAL");
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.read)]);
  expect(await s.review(id)).toMatchObject({ state: "PENDING", arguments: { value: "FIXTURE REPORT" }, canDecide: true });
  const command = await s.command(id), decision = await s.request("POST", `/api/executions/${id}/approve`, command, "reviewer");
  expect(decision.statusCode, decision.body).toBe(200); expect(decision.json().data).toMatchObject({ executionStatus: "PENDING", resumeQueued: true });
  await s.wait(id, "DONE");
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.read), exactBridgeName(s.write)]); expect(s.sdk.callTool.mock.calls[1]![1]).toEqual({ value: "FIXTURE REPORT" });
  const state = await s.repository.snapshot(), execution = state.executions[id]!;
  expect(execution.tokens.total).toBe(0); expect(execution.finalOutput).toMatchObject({ structuredContent: { accepted: true, id: "fixture-message" } });
  expect(execution.runtimeApprovalSecret!.records[execution.runtimeApprovalSecret!.activeId]!.state).toBe("CONSUMED");
  expect(execution.operationSecret!.intents.send).toMatchObject({ state: "ACKNOWLEDGED", evidenceMeaning: "operation-accepted" });
  expect(await s.review(id)).toMatchObject({ state: "CONSUMED", canDecide: false, unavailable: null, arguments: { value: "FIXTURE REPORT" } });
  const events = state.executionEvents[id]!; expect(events.map(event => event.sequence)).toEqual(events.map((_, i) => i + 1));
  const publicResponse = await s.request("GET", `/api/executions/${id}`); expect(publicResponse.body).not.toMatch(/operationSecret|runtimeApprovalSecret|synthetic-only/);
  expect((await s.run()).json().data.id).toBe(id); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  expect((await s.request("POST", `/api/executions/${id}/approve`, command, "reviewer")).json().data.replayed).toBe(true);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("an exact chat email draft requests independent approval and dispatches only server-derived fields after approval", async () => {
  const s = await setup(null, true, false, true);
  const created = await s.request("POST", "/api/chat/sessions", { title: "Email review" }); expect(created.statusCode, created.body).toBe(201);
  const sessionId = created.json().data.id as string;
  const prepared = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { content: "Email manager@example.test" });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const draft = prepared.json().data.assistantMessage.artifacts.emailDraft;
  const edit = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDraftCommand: { draftId: draft.id, baseVersion: draft.version,
    baseHash: draft.contentHash, commandId: "email-edit-command-0001", patch: { to: "manager@example.test", subject: "Daily invoice review", body: "Reviewed invoice summary." } } });
  expect(edit.statusCode, edit.body).toBe(200); const saved = edit.json().data.assistantMessage.artifacts.emailDraft;
  const deliveryCommand = { profile: "email-delivery-admission-command/v1", draftId: saved.id, baseVersion: saved.version, baseHash: saved.contentHash,
    idempotencyKey: "email-admission-key-0001", sharingConfirmed: true };
  const admitted = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDeliveryCommand: deliveryCommand });
  expect(admitted.statusCode, admitted.body).toBe(202);
  expect(admitted.json().data.emailDelivery).toMatchObject({ profile: "email-delivery-admission/v1", draftId: saved.id, draftVersion: 2,
    reviewRequested: true, freshIndependentApprovalRequired: true, bridgeDispatched: false, deliveryVerified: false, status: "PENDING" });
  expect(admitted.body).not.toContain("email-admission-key-0001"); expect(admitted.body).not.toContain("recipient_parameter");
  const executionId = admitted.json().data.emailDelivery.executionId as string; await s.wait(executionId, "AWAITING_APPROVAL");
  expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect(await s.review(executionId)).toMatchObject({ state: "PENDING", canDecide: true,
    arguments: { recipient: "manager@example.test", subject: "Daily invoice review", body: "Reviewed invoice summary." } });
  const approved = await s.request("POST", `/api/executions/${executionId}/approve`, await s.command(executionId), "reviewer");
  expect(approved.statusCode, approved.body).toBe(200); await s.wait(executionId, "DONE");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect(s.sdk.callTool.mock.calls[0]![0]).toBe(exactBridgeName(s.email!));
  expect(s.sdk.callTool.mock.calls[0]![1]).toEqual({ recipient: "manager@example.test", subject: "Daily invoice review", body: "Reviewed invoice summary." });
  const state = await s.repository.snapshot(), execution = state.executions[executionId]!;
  expect(execution.emailDeliverySource).toMatchObject({ profile: "email-delivery-source/v1", sessionId, draftId: saved.id, draftVersion: 2, draftHash: saved.contentHash });
  expect(Object.values(state.emailDeliveryAdmissions)).toHaveLength(1); expect(execution.finalOutput).toMatchObject({ structuredContent: { accepted: true } });
  expect(execution.agentSummary).not.toMatch(/delivered/i);
  const replay = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDeliveryCommand: deliveryCommand });
  expect(replay.statusCode, replay.body).toBe(202); expect(replay.json().data.emailDelivery).toMatchObject({ executionId, replayed: true });
  expect(Object.values((await s.repository.snapshot()).emailDeliveryAdmissions)).toHaveLength(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  expect((await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDeliveryCommand: { ...deliveryCommand, idempotencyKey: "email-admission-key-0002" } })).statusCode).toBe(409);
  expect((await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDraftCommand: { draftId: saved.id, baseVersion: saved.version, baseHash: saved.contentHash,
    commandId: "email-edit-command-0002", patch: { to: saved.to, subject: saved.subject, body: "Changed after request" } } })).statusCode).toBe(409);
  expect((await s.request("POST", `/api/workflows/${execution.workflowId}/run`, { mode: "async-operation", idempotencyKey: "direct-email-rerun-0001", input: {} })).statusCode).toBe(409);
  expect((await s.request("GET", `/api/workflows/${execution.workflowId}`, undefined, "observer")).statusCode).toBe(404);
  expect((await s.request("GET", `/api/workflows/${execution.workflowId}/yaml`, undefined, "observer")).statusCode).toBe(404);
  expect((await s.request("GET", `/api/executions/${executionId}`, undefined, "observer")).statusCode).toBe(404);
  expect((await s.request("PATCH", `/api/workflows/${execution.workflowId}`, { name: "Mutated email" })).statusCode).toBe(409);
  expect((await s.request("POST", `/api/workflows/${execution.workflowId}/duplicate`, {})).statusCode).toBe(409);
  expect((await s.request("DELETE", `/api/workflows/${execution.workflowId}`)).statusCode).toBe(409);
  expect((await s.request("DELETE", `/api/chat/sessions/${sessionId}`)).statusCode).toBe(409);
  expect((await s.request("PUT", `/api/workflows/${execution.workflowId}/schedule`, { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: 1, workflowHash: execution.workflowSnapshot!.contentHash, enabled: true, timezone: "UTC", localTime: "09:00", reportingPeriod: "previous-calendar-day",
    misfirePolicy: "SKIP", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: scheduleReportWindowBinding })).statusCode).toBe(409);
  await s.repository.mutate(state => {
    const admission = Object.values(state.emailDeliveryAdmissions)[0]!;
    admission.requestFingerprint = `sha256:${"0".repeat(64)}`;
  });
  const corruptReplay = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDeliveryCommand: deliveryCommand });
  expect(corruptReplay.statusCode, corruptReplay.body).toBe(503);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each(["missing-sharing", "recurring", "browser-tool", "ambiguous-connector"])("email admission denies %s before SDK dispatch", async scenario => {
  const s = await setup(null, true, false, true), created = await s.request("POST", "/api/chat/sessions", {}), sessionId = created.json().data.id as string;
  const prepared = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { content: "Email manager@example.test" });
  let draft = prepared.json().data.assistantMessage.artifacts.emailDraft as EmailDraft;
  if (scenario === "recurring") {
    await s.repository.mutate(state => {
      const message = state.chats[sessionId]!.messages.find(item => (item.artifacts as { emailDraft?: EmailDraft } | undefined)?.emailDraft?.id === draft.id)!;
      const value = (message.artifacts as { emailDraft: EmailDraft }).emailDraft;
      value.recurring = true; value.requirements = draftRequirements(value); value.contentHash = emailDraftHash(value);
    });
    draft = await s.repository.read(state => structuredClone((state.chats[sessionId]!.messages.find(item => (item.artifacts as { emailDraft?: EmailDraft } | undefined)?.emailDraft?.id === draft.id)!.artifacts as { emailDraft: EmailDraft }).emailDraft));
  }
  const edit = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDraftCommand: { draftId: draft.id, baseVersion: draft.version, baseHash: draft.contentHash,
    commandId: `email-edit-${scenario}-0001`, patch: { to: "manager@example.test", subject: "Review", body: "Exact body" } } });
  const saved = edit.json().data.assistantMessage.artifacts.emailDraft, command: Record<string, unknown> = { profile: "email-delivery-admission-command/v1", draftId: saved.id,
    baseVersion: saved.version, baseHash: saved.contentHash, idempotencyKey: `email-key-${scenario}-00000001`, sharingConfirmed: true };
  if (scenario === "missing-sharing") delete command.sharingConfirmed;
  if (scenario === "browser-tool") command.tool = "attacker.override";
  if (scenario === "ambiguous-connector") {
    const original = s.services.registries.snapshot(), email = s.email!;
    vi.mocked(s.services.registries.snapshot).mockImplementation(() => ({ ...original, tools: [...original.tools, { ...email, tool_id: "email-fixture-two", name: "demo.email.two", mcp_tool_name: "demo.email.two" }] }));
  }
  const response = await s.request("POST", `/api/chat/sessions/${sessionId}/messages`, { emailDeliveryCommand: command });
  expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect(Object.values((await s.repository.snapshot()).emailDeliveryAdmissions)).toHaveLength(0);
});

test("durable daily schedule admits one pinned service-principal occurrence and requires fresh independent approval", async () => {
  const s = await setup(); await prepareScheduleWorkflow(s); const published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
  const snapshot = await s.repository.snapshot(), workflow = snapshot.workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data).toMatchObject({ state: "ACTIVE", revision: 1, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", servicePrincipalId: "requester", workflowVersion: workflow.publishedVersion });
  const scheduledFor = saved.json().data.nextRunAt as string;
  const result = await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor)); expect(result).toEqual({ admitted: 1, skipped: 0, blocked: 0 });
  const status = await s.request("GET", "/api/workflows/flow/schedule"); expect(status.statusCode, status.body).toBe(200);
  expect(status.json().data).toMatchObject({ schedule: { state: "ACTIVE", revision: 1 }, occurrences: [{ state: "ADMITTED", scheduledFor, servicePrincipalId: "requester" }] });
  const executionId = status.json().data.occurrences[0].executionId as string; await s.wait(executionId, "AWAITING_APPROVAL");
  const reportWindow = reportWindowFor("UTC", scheduledFor, "previous-calendar-day");
  expect(status.json().data.occurrences[0].reportWindow).toEqual(reportWindow);
  const before = (await s.repository.snapshot()).executions[executionId]!;
  expect(before.scheduleSource).toMatchObject({ profile: "workflow-schedule-source/v1", scheduleId: "schedule-flow", scheduleRevision: 1,
    occurrenceId: status.json().data.occurrences[0].id, scheduledFor, reportWindow, reportWindowBinding: scheduleReportWindowBinding });
  expect(before.scheduleSource!.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(before.workflowSnapshot!.input).toEqual({ reportStartAt: reportWindow.startAt, reportEndAt: reportWindow.endAt });
  expect(before.startedBy.id).toBe("requester"); expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.reportRead)]);
  expect(s.sdk.callTool.mock.calls[0]![1]).toEqual({ startAt: reportWindow.startAt, endAt: reportWindow.endAt });
  expect(before.reportCoverage).toMatchObject({ profile: "schedule-report-coverage/v1", nodeId: "lookupReport", toolId: s.reportRead.tool_id,
    contractHash: capabilityContractHash(s.reportRead), startAt: reportWindow.startAt, endAt: reportWindow.endAt, itemCount: 1 });
  const command = await s.command(executionId), approved = await s.request("POST", `/api/executions/${executionId}/approve`, command, "reviewer");
  expect(approved.statusCode, approved.body).toBe(200); await s.wait(executionId, "DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  expect(await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor))).toEqual({ admitted: 0, skipped: 0, blocked: 0 });
  expect(Object.values((await s.repository.snapshot()).executions).filter(run => run.scheduleSource).map(run => run.id)).toEqual([executionId]);
});

test("schedule activation rejects window references that lack one reviewed complete-report contract", async () => {
  const s = await setup();
  await s.repository.mutate(state => {
    const workflow = state.workflows.flow!;
    workflow.yaml = stringify({ name: workflow.name, description: "Unqualified scheduled report fixture", trigger: { type: "manual", config: { inputSchema: {
      type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } }, required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps: [
      { id: "lookupStart", action: s.read.name, parameters: { value: "{{input.reportStartAt}}" } },
      { id: "lookupEnd", action: s.read.name, parameters: { value: "{{input.reportEndAt}}" } },
      { id: "send", action: s.write.name, parameters: { value: "{{lookupEnd.structuredContent.value}}" } },
    ] }); workflow.steps = 3; workflow.updatedAt = new Date().toISOString();
  });
  expect((await s.publish()).statusCode).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!;
  const denied = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime: "09:00",
    reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  expect(denied.statusCode, denied.body).toBe(422); expect(denied.body).toMatch(/complete-result evidence/i);
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(Object.keys((await s.repository.snapshot()).schedules)).toHaveLength(0);
});

test("an incomplete ERP report result fails closed without requesting approval or dispatching the effect", async () => {
  const s = await setup(); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  s.sdk.callTool.mockImplementationOnce(async (_name, args) => ({ content: [], structuredContent: { coveredStartAt: args.startAt, coveredEndAt: args.endAt,
    complete: false, hasMore: true, items: [{ id: "partial" }], itemCount: 1, summary: "Partial report" } }));
  const scheduledFor = saved.json().data.nextRunAt as string;
  expect(await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor))).toEqual({ admitted: 1, skipped: 0, blocked: 0 });
  const executionId = (await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0].executionId as string;
  await s.wait(executionId, "FAILED");
  const run = (await s.repository.snapshot()).executions[executionId]!;
  expect(run.failure).toMatchObject({ failureCategory: "REPORT_COVERAGE_UNCONFIRMED", failedStepId: "lookupReport" });
  expect(run.reportCoverage).toBeUndefined(); expect(run.runtimeApprovalSecret).toBeUndefined();
  expect(run.operationSecret!.intents.lookupReport).toMatchObject({ state: "ACKNOWLEDGED" });
  expect(run.agentSummary).toMatch(/No approval was requested and no effect was dispatched/i);
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.reportRead)]);
});

test("changed report coverage evidence after approval request blocks the effect before SDK dispatch", async () => {
  const s = await setup(); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string;
  await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor));
  const executionId = (await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0].executionId as string;
  await s.wait(executionId, "AWAITING_APPROVAL"); const command = await s.command(executionId);
  await s.repository.mutate(state => { state.executions[executionId]!.reportCoverage!.itemCount = 2; });
  const approved = await s.request("POST", `/api/executions/${executionId}/approve`, command, "reviewer"); expect(approved.statusCode, approved.body).toBe(200);
  await s.wait(executionId, "FAILED");
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.reportRead)]);
  expect((await s.repository.snapshot()).executions[executionId]!.operationSecret!.intents.send).toBeUndefined();
});

test("server-owned bounded report pagination aggregates every exact page before approval", async () => {
  const s = await setup(null, true, false, false, true); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string, reportWindow = reportWindowFor("UTC", scheduledFor, "previous-calendar-day");
  await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor));
  const executionId = (await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0].executionId as string;
  await s.wait(executionId, "AWAITING_APPROVAL");
  expect(s.sdk.callTool.mock.calls.map(call => call[1])).toEqual([1, 2, 3].map(page => ({ startAt: reportWindow.startAt, endAt: reportWindow.endAt, page })));
  const run = (await s.repository.snapshot()).executions[executionId]!;
  expect(run.stepOutputs!.lookupReport).toMatchObject({ structuredContent: { complete: true, hasMore: false, page: 3, itemCount: 3,
    items: [{ id: "invoice-1" }, { id: "invoice-2" }, { id: "invoice-3" }] } });
  expect((run.stepOutputs!.lookupReport as any).structuredContent.snapshotId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(run)).not.toContain("snapshot-daily-invoices");
  expect(run.reportCoverage).toMatchObject({ itemCount: 3, pagination: { profile: "report-page-evidence/v1", firstPage: 1, lastPage: 3, pageCount: 3,
    pages: [{ page: 1, hasMore: true }, { page: 2, hasMore: true }, { page: 3, hasMore: false }] } });
  expect(Object.keys(run.operationSecret!.intents)).toEqual(["lookupReport:page:1", "lookupReport:page:2", "lookupReport:page:3"]);
  expect(run.reportPageSecret).toBeUndefined();
  const approved = await s.request("POST", `/api/executions/${executionId}/approve`, await s.command(executionId), "reviewer");
  expect(approved.statusCode, approved.body).toBe(200); await s.wait(executionId, "DONE");
  expect(s.sdk.callTool.mock.calls.at(-1)![0]).toBe(exactBridgeName(s.write));
});

test("confirmed report pages resume after committed checkpoint acknowledgement loss without replay", async () => {
  const storage = new Records(), s = await setup(storage, true, false, false, true); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string;
  storage.loseWhen = state => Object.values(state.executions).some(run => run.reportPageSecret?.lookupReport?.pages.length === 1 &&
    run.readProgress?.attempts.lookupReport?.status === "PREPARING");
  await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor));
  await vi.waitFor(() => expect(() => s.repository.assertAuthority()).toThrow(), { timeout: 4000 });
  const committed = JSON.parse(storage.bytes!.toString()) as RepositoryState, interrupted = Object.values(committed.executions).find(run => run.scheduleSource)!;
  expect(interrupted.reportPageSecret!.lookupReport).toMatchObject({ nextPage: 2, pages: [{ page: 1, hasMore: true }] });
  expect(withoutSecretFields(interrupted)).not.toHaveProperty("reportPageSecret");
  expect(s.sdk.callTool.mock.calls.filter(call => call[0] === exactBridgeName(s.reportRead)).map(call => call[1].page)).toEqual([1]);
  await s.app.close(); const repository = await Repository.open(storage), validator = new RegistryValidator(s.services.registries, repository), authorize = admissionAuthorizer(repository, s.services.registries);
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "synthetic-only", timeoutMs: 1000, validator, sdkClient: s.sdk,
    admissionAuthorizer: authorize });
  const services = { ...s.services, repository, validator, erpbridgeSession: session, executor: new Executor(new ToolRegistry(), validator) };
  const operations = operationJobQueue(services); closers.push({ close: () => operations.stop() }, session, repository); await operations.start();
  await vi.waitFor(async () => expect((await repository.snapshot()).executions[interrupted.id]?.status).toBe("AWAITING_APPROVAL"), { timeout: 5000 });
  const resumed = (await repository.snapshot()).executions[interrupted.id]!;
  expect(s.sdk.callTool.mock.calls.filter(call => call[0] === exactBridgeName(s.reportRead)).map(call => call[1].page)).toEqual([1, 2, 3]);
  expect(resumed.reportCoverage).toMatchObject({ itemCount: 3, pagination: { pageCount: 3, lastPage: 3 } });
  expect(resumed.reportPageSecret).toBeUndefined();
});

test("a changed ERP snapshot marker between report pages fails before approval or effect", async () => {
  const s = await setup(null, true, false, false, true); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  const original = s.sdk.callTool.getMockImplementation()!;
  s.sdk.callTool.mockImplementation(async (name, args, meta) => {
    const output = await original(name, args, meta) as any;
    if (name === exactBridgeName(s.reportRead) && args.page === 2) output.structuredContent.snapshotId = "changed-erp-snapshot";
    return output;
  });
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string; await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor));
  const executionId = (await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0].executionId as string; await s.wait(executionId, "FAILED");
  const run = (await s.repository.snapshot()).executions[executionId]!;
  expect(run.failure).toMatchObject({ failureCategory: "REPORT_COVERAGE_UNCONFIRMED", failedStepId: "lookupReport", reason: expect.stringMatching(/stable snapshot/i) });
  expect(run.agentSummary).toMatch(/No approval was requested and no effect was dispatched/i); expect(run.runtimeApprovalSecret).toBeUndefined(); expect(run.operationSecret!.intents.send).toBeUndefined();
  expect(JSON.stringify(run.stepOutputs)).not.toMatch(/snapshot-daily-invoices|changed-erp-snapshot/);
  expect(s.sdk.callTool.mock.calls.filter(call => call[0] === exactBridgeName(s.reportRead)).map(call => call[1].page)).toEqual([1, 2]);
});

test("early report exhaustion cannot omit records from the declared total", async () => {
  const s = await setup(null, true, false, false, true); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  s.sdk.callTool.mockImplementation(async (name, args) => name === exactBridgeName(s.reportRead) ? { content: [], structuredContent: {
    coveredStartAt: args.startAt, coveredEndAt: args.endAt, complete: true, hasMore: false, items: [{ id: "invoice-1" }], itemCount: 1,
    summary: "Truncated report", page: args.page, snapshotId: "snapshot-daily-invoices", totalAvailable: 3 } } :
    { content: [], structuredContent: { accepted: true, id: "must-not-dispatch" } });
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string; await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor));
  const executionId = (await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0].executionId as string; await s.wait(executionId, "FAILED");
  const run = (await s.repository.snapshot()).executions[executionId]!;
  expect(run.failure).toMatchObject({ failureCategory: "REPORT_COVERAGE_UNCONFIRMED", reason: expect.stringMatching(/total record count/i) });
  expect(run.runtimeApprovalSecret).toBeUndefined(); expect(run.operationSecret!.intents.send).toBeUndefined();
  expect(s.sdk.callTool.mock.calls.filter(call => call[0] === exactBridgeName(s.reportRead)).map(call => call[1].page)).toEqual([1]);
});

test("pagination that never exhausts its reviewed bound fails without approval or effect", async () => {
  const s = await setup(null, true, false, false, true); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  s.sdk.callTool.mockImplementation(async (name, args) => name === exactBridgeName(s.reportRead) ? { content: [], structuredContent: {
    coveredStartAt: args.startAt, coveredEndAt: args.endAt, complete: false, hasMore: true, items: [{ id: `partial-${args.page}` }], itemCount: 1,
    summary: "Still partial", page: args.page, snapshotId: "snapshot-daily-invoices", totalAvailable: 99 } } : { content: [], structuredContent: { accepted: true, id: "must-not-dispatch" } });
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string; await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor));
  const executionId = (await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0].executionId as string; await s.wait(executionId, "FAILED");
  const run = (await s.repository.snapshot()).executions[executionId]!;
  expect(run.failure).toMatchObject({ failureCategory: "REPORT_COVERAGE_UNCONFIRMED", failedStepId: "lookupReport" });
  expect(run.runtimeApprovalSecret).toBeUndefined(); expect(run.operationSecret!.intents.send).toBeUndefined();
  expect(s.sdk.callTool.mock.calls.map(call => call[1].page)).toEqual([1, 2, 3, 4]);
});

test("an uncertain report page is never automatically replayed", async () => {
  const s = await setup(null, true, false, false, true); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  const original = s.sdk.callTool.getMockImplementation()!;
  s.sdk.callTool.mockImplementation(async (name, args, meta) => {
    if (name === exactBridgeName(s.reportRead) && args.page === 2) throw new Error("Synthetic page-two transport outcome unknown");
    return original(name, args, meta);
  });
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string; await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor));
  const executionId = (await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0].executionId as string; await s.wait(executionId, "RECONCILIATION_REQUIRED");
  const before = s.sdk.callTool.mock.calls.length, run = (await s.repository.snapshot()).executions[executionId]!;
  expect(run.operationSecret!.intents["lookupReport:page:2"]).toMatchObject({ state: "UNKNOWN" }); expect(run.reportCoverage).toBeUndefined();
  expect((await s.request("POST", `/api/executions/${executionId}/retry`, { input: {} })).statusCode).toBe(409); expect(s.sdk.callTool).toHaveBeenCalledTimes(before);
});

test.each([
  ["2026-03-09T13:00:00.000Z", "2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
  ["2026-11-02T14:00:00.000Z", "2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
])("previous local calendar day keeps exact DST boundaries for %s", (scheduledFor, localDate, startAt, endAt, hours) => {
  const window = reportWindowFor("America/New_York", scheduledFor, "previous-calendar-day");
  expect(window).toEqual({ profile: "workflow-report-window/v1", reportingPeriod: "previous-calendar-day", timezone: "America/New_York", localDate, startAt, endAt });
  expect((Date.parse(window.endAt) - Date.parse(window.startAt)) / 3_600_000).toBe(hours);
});

test("daily schedule skips an expired occurrence and never calls the SDK", async () => {
  const s = await setup(); await prepareScheduleWorkflow(s); const published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 60, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string, result = await workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor) + 61_000);
  expect(result).toEqual({ admitted: 0, skipped: 1, blocked: 0 }); expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect((await s.request("GET", "/api/workflows/flow/schedule")).json().data.occurrences[0]).toMatchObject({ state: "SKIPPED", scheduledFor });
});

test("schedule activation rejects invented timezones, stale publications and unauthorized principals", async () => {
  const s = await setup(); await prepareScheduleWorkflow(s); const published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, base = { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime: "09:00",
    reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: scheduleReportWindowBinding };
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, timezone: "Invented/Nowhere" })).statusCode).toBe(422);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, reportingPeriod: "current-week" })).statusCode).toBe(422);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, workflowHash: `sha256:${"0".repeat(64)}` })).statusCode).toBe(409);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, servicePrincipalId: "reviewer" })).statusCode).toBe(403);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, input: { apiToken: "must-not-be-stored" } })).statusCode).toBe(422);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, reportWindowBinding: undefined })).statusCode).toBe(422);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, input: { reportStartAt: "browser override" } })).statusCode).toBe(422);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, reportWindowBinding: { ...scheduleReportWindowBinding, endAtInput: "unusedWindow" } })).statusCode).toBe(422);
  expect((await s.request("PUT", "/api/workflows/flow/schedule", { ...base, reportWindowBinding: { ...scheduleReportWindowBinding, endAtInput: "count" } })).statusCode).toBe(422);
  const legacy = await s.request("PATCH", "/api/workflows/flow", { trigger: { type: "schedule", config: { cron: "0 9 * * *" } } });
  expect(legacy.statusCode, legacy.body).toBe(422); expect(legacy.body).toContain("LEGACY_SCHEDULE_TRIGGER_REJECTED");
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(Object.keys((await s.repository.snapshot()).schedules)).toHaveLength(0);
});

test("schedule activation rejects a workflow-authored report page", async () => {
  const s = await setup(null, true, false, false, true); await prepareScheduleWorkflow(s, 2);
  const published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, response = await s.request("PUT", "/api/workflows/flow/schedule", {
    profile: "workflow-daily-schedule-command/v1", baseRevision: 0, workflowVersion: workflow.publishedVersion,
    workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime: "09:00",
    reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding,
  });
  expect(response.statusCode, response.body).toBe(422); expect(response.body).toContain("SCHEDULE_REPORT_COVERAGE_REQUIRED");
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("an exact-revision pause remains available after publication and service-principal drift", async () => {
  const s = await setup(); await prepareScheduleWorkflow(s); const published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, command = { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime: "09:00",
    reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: scheduleReportWindowBinding };
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", command); expect(saved.statusCode, saved.body).toBe(200);
  await s.repository.mutate(state => { state.workflows.flow!.yaml = state.workflows.flow!.yaml.replace("Synthetic report dispatch", "Changed report dispatch");
    state.users.requester!.status = "Disabled"; state.users.other = { ...state.users.requester!, id: "other", name: "other", email: "other@example.test", status: "Active" }; });
  const currentActorPause = await s.request("PUT", "/api/workflows/flow/schedule", { ...command, baseRevision: 1, enabled: false }, "other");
  expect(currentActorPause.statusCode, currentActorPause.body).toBe(200); expect(currentActorPause.json().data).toMatchObject({ state: "PAUSED", revision: 2, nextRunAt: null });
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("schedule occurrence claim acknowledgement loss resumes after restart as one execution without effect dispatch", async () => {
  const storage = new Records(), s = await setup(storage); await prepareScheduleWorkflow(s); const published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string;
  storage.loseWhen = state => Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING");
  await expect(workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor))).rejects.toThrow(/acknowledgement loss/);
  expect(() => s.repository.assertAuthority()).toThrow(); const committed = JSON.parse(storage.bytes!.toString()) as RepositoryState;
  expect(Object.values(committed.scheduleOccurrences)).toHaveLength(1); expect(Object.values(committed.scheduleOccurrences)[0]!.state).toBe("ADMITTING");
  expect(Object.values(committed.executions).filter(run => run.scheduleSource)).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
  await s.app.close(); const repository = await Repository.open(storage), validator = new RegistryValidator(s.services.registries, repository), authorize = admissionAuthorizer(repository, s.services.registries);
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "synthetic-only", timeoutMs: 1000, validator, sdkClient: s.sdk,
    admissionAuthorizer: authorize });
  const services = { ...s.services, repository, validator, erpbridgeSession: session, executor: new Executor(new ToolRegistry(), validator) };
  const operations = operationJobQueue(services), schedules = workflowScheduleRunner(services);
  closers.push({ close: () => schedules.stop() }, { close: () => operations.stop() }, session, repository); await operations.start(); await schedules.start();
  await vi.waitFor(async () => { const state = await repository.snapshot(), occurrence = Object.values(state.scheduleOccurrences)[0];
    expect(occurrence?.state).toBe("ADMITTED"); expect(Object.values(state.executions).filter(run => run.scheduleSource)).toHaveLength(1); }, { timeout: 4000 });
  const state = await repository.snapshot(), execution = Object.values(state.executions).find(run => run.scheduleSource)!;
  await vi.waitFor(async () => expect((await repository.snapshot()).executions[execution.id]?.status).toBe("AWAITING_APPROVAL"), { timeout: 4000 });
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.reportRead)]);
  expect(Object.values((await repository.snapshot()).executions).filter(run => run.scheduleSource)).toHaveLength(1);
});

test("a pending occurrence cannot cross into a newer schedule revision", async () => {
  const storage = new Records(), s = await setup(storage); await prepareScheduleWorkflow(s); expect((await s.publish()).statusCode).toBe(200);
  const workflow = (await s.repository.snapshot()).workflows.flow!, localTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const saved = await s.request("PUT", "/api/workflows/flow/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: workflow.publishedVersion, workflowHash: workflowContentHash(workflow.yaml), enabled: true, timezone: "UTC", localTime,
    reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {},
    reportWindowBinding: scheduleReportWindowBinding });
  const scheduledFor = saved.json().data.nextRunAt as string;
  storage.loseWhen = state => Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING");
  await expect(workflowScheduleRunner(s.services).runDue(Date.parse(scheduledFor))).rejects.toThrow(/acknowledgement loss/);
  await s.app.close();
  const committed = JSON.parse(storage.bytes!.toString()) as RepositoryState, schedule = committed.schedules["schedule-flow"]!;
  schedule.revision = 2; schedule.scheduleHash = `sha256:${"c".repeat(64)}`; schedule.nextRunAt = new Date(Date.parse(scheduledFor) + 86_400_000).toISOString();
  storage.bytes = Buffer.from(JSON.stringify(committed));
  const repository = await Repository.open(storage), validator = new RegistryValidator(s.services.registries, repository), authorize = admissionAuthorizer(repository, s.services.registries);
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "synthetic-only", timeoutMs: 1000, validator, sdkClient: s.sdk,
    admissionAuthorizer: authorize });
  const services = { ...s.services, repository, validator, erpbridgeSession: session, executor: new Executor(new ToolRegistry(), validator) };
  const operations = operationJobQueue(services), schedules = workflowScheduleRunner(services);
  closers.push({ close: () => schedules.stop() }, { close: () => operations.stop() }, session, repository); await operations.start(); await schedules.start();
  await vi.waitFor(async () => expect(Object.values((await repository.snapshot()).scheduleOccurrences)[0]?.state).toBe("BLOCKED"), { timeout: 4000 });
  const state = await repository.snapshot(); expect(state.schedules["schedule-flow"]).toMatchObject({ revision: 2, state: "ACTIVE" });
  expect(Object.values(state.executions).filter(run => run.scheduleSource)).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("normal operation publication/readiness binds its separately reviewed read-back target without calling it", async () => {
  const s = await setup(null, false, true), published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
  const snapshot = await s.repository.snapshot(), stored = snapshot.versions.flow![0]!.compiledOperation as any;
  expect(stored.plan.ir.root.nodes[0].readback).toMatchObject({ profile: "operation-readback-binding/v1", toolId: s.readback!.tool_id, contractHash: capabilityContractHash(s.readback!) });
  expect(stored.plan.ir.root.nodes).toHaveLength(1);
  const ready = await s.request("GET", "/api/workflows/flow/readiness"); expect(ready.statusCode, ready.body).toBe(200); expect(ready.json().data.can_attempt_run).toBe(true);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["disabled-before-publication", "changed-target", "changed-admission", "tampered-binding"])("normal operation gates deny %s read-back qualification before any call", async scenario => {
  const s = await setup(null, false, true);
  const targetPin = await s.repository.readAuthoritative(state => captureReadAdmissionPin(state, s.services.registries, s.readback!, s.session.admissionBinding!));
  if (scenario === "disabled-before-publication") {
    await s.repository.mutate(state => { state.capabilityAdmissions[targetPin.capabilityId]!.state = "DISABLED"; });
    const denied = await s.publish(); expect(denied.statusCode, denied.body).toBe(422);
  } else {
    const published = await s.publish(); expect(published.statusCode, published.body).toBe(200);
    if (scenario === "changed-target") s.readback!.description = "Unreviewed changed status contract";
    if (scenario === "changed-admission") await s.repository.mutate(state => { (state.capabilityAdmissions[targetPin.capabilityId] as { version: number }).version++; });
    if (scenario === "tampered-binding") await s.repository.mutate(state => { (state.versions.flow![0]!.compiledOperation as any).plan.ir.root.nodes[0].readback.admission.contractHash = `sha256:${"0".repeat(64)}`; });
    const denied = await s.run(); expect(denied.statusCode, denied.body).toBe(409);
  }
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});
test.each(["disabled-admission", "changed-admission", "changed-contract", "tampered-binding"])("read-back %s at final consumed-intent admission fences the original SDK entry", async scenario => {
  const s = await setup(null, false, true), id = await s.admit(), command = await s.command(id);
  const targetPin = await s.repository.readAuthoritative(state => captureReadAdmissionPin(state, s.services.registries, s.readback!, s.session.admissionBinding!));
  let hookEntered = false;
  s.setDispatchAdmissionHook(async () => {
    const run = (await s.repository.snapshot()).executions[id]!;
    if (!run.operationSecret!.intents.send) return;
    expect(run.operationSecret!.intents.send!.state).toBe("DISPATCH_INTENT");
    expect(run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!.state).toBe("CONSUMED"); hookEntered = true;
    if (scenario === "changed-contract") s.readback!.description = "Changed after the acknowledged original intent";
    else await s.repository.mutate(state => {
      if (scenario === "disabled-admission") state.capabilityAdmissions[targetPin.capabilityId]!.state = "DISABLED";
      if (scenario === "changed-admission") (state.capabilityAdmissions[targetPin.capabilityId] as { version: number }).version++;
      if (scenario === "tampered-binding") (state.versions.flow![0]!.compiledOperation as any).plan.ir.root.nodes[0].readback.admission.admissionVersion++;
    });
  });
  const response = await s.request("POST", `/api/executions/${id}/approve`, command, "reviewer"); expect(response.statusCode, response.body).toBe(200);
  await s.wait(id, "RECONCILIATION_REQUIRED"); expect(hookEntered).toBe(true); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const run = (await s.repository.snapshot()).executions[id]!;
  expect(run.operationSecret!.intents.send!.state).toBe("UNKNOWN"); expect(run.stepOutputs).toEqual({}); expect(run.finalOutput).toBeUndefined();
});

test("reviewed operation does not acquire read authority or bypass approval with a validator capability/callback/forged permit", async () => {
  const s = await setup(null, false); const yaml = (await s.repository.snapshot()).workflows.flow!.yaml;
  await expect(s.repository.readAuthoritative(state => captureReadAdmissionPin(state, s.services.registries, s.write, s.session.admissionBinding!))).rejects.toThrow();
  await expect(dispatchReadTool(s.services, "requester", s.write.name, { value: "fixture report" })).rejects.toThrow(/writes are blocked/);
  const gate = await s.services.validator.validateAndIssueToken("fixture", yaml, "Platform Admin"), identity = createDispatchIdentity(s.actor, {});
  const resolved = await s.services.validator.evaluateResolvedStep("fixture", yaml, 0, { value: "fixture report" }, gate.token, identity);
  expect(resolved.capability).not.toBeNull();
  await expect(s.session.clientFor(s.write).execute(s.write.name, resolved.capability!, { value: "fixture report" }, identity, undefined, async () => {}, () => {}, { profile: "operation-sdk-permit/v1" })).rejects.toThrow(/authentic exact/);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

async function uncertainReadbackOperation(storage: PersistenceBackend | null = null) {
  const s = await setup(storage, false, true), id = await s.admit();
  s.sdk.callTool.mockImplementationOnce(async () => { throw new Error("Synthetic unknown original send; never automatically replay"); });
  const approved = await s.request("POST", `/api/executions/${id}/approve`, await s.command(id), "reviewer"); expect(approved.statusCode, approved.body).toBe(200);
  await s.wait(id, "RECONCILIATION_REQUIRED");
  const history = async (actor = "requester") => {
    const reply = await s.request("GET", `/api/executions/${id}/readbacks`, undefined, actor); expect(reply.statusCode, reply.body).toBe(200); return reply.json().data;
  };
  const queryCommand = async (key = "readback-query-key-0001") => {
    const value = await history(); return { intentId: value.intentId, baseVersion: value.baseVersion, factsHash: value.factsHash, idempotencyKey: key };
  };
  const waitQuery = async (queryId: string, status: string) => {
    await vi.waitFor(async () => { expect((await s.repository.snapshot()).executions[id]!.operationSecret!.readbacks![queryId]!.state).toBe(status); }, { timeout: 4000 });
  };
  return { ...s, id, history, queryCommand, waitQuery };
}

test.each([['APPLIED', true, 'APPLIED'], ['ABSENT', true, 'NOT_APPLIED'], ['PENDING', true, 'UNRESOLVED'], ['ABSENT', false, 'UNRESOLVED']] as const)("normal saved read-back classifies %s/settled=%s without closing, replaying or resuming its original operation", async (stateLabel, settled, outcome) => {
  const s = await uncertainReadbackOperation(), before = await s.repository.snapshot(), original = before.executions[s.id]!;
  s.sdk.callTool.mockImplementationOnce(async (_name, args) => ({ content: [], structuredContent: { value: args.value, state: stateLabel, settled, observedAt: new Date().toISOString() } }));
  const command = await s.queryCommand(), admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, command); expect(admitted.statusCode, admitted.body).toBe(202);
  const queryId = admitted.json().data.id; await s.waitQuery(queryId, "ANSWERED");
  const after = await s.repository.snapshot(), run = after.executions[s.id]!, job = run.operationSecret!.readbacks![queryId]!;
  expect(job.evaluation).toMatchObject({ outcome, settled, canResume: false, noReplay: true, deliveryVerified: false });
  expect(job.result).toMatchObject({ structuredContent: { value: "fixture report" } }); expect(job.lease).toBeUndefined();
  expect(run.status).toBe("RECONCILIATION_REQUIRED"); expect(run.completedAt).toBe(original.completedAt); expect(run.operationSecret!.intents).toEqual(original.operationSecret!.intents);
  expect(run.stepOutputs).toEqual(original.stepOutputs); expect(run.finalOutput).toBeUndefined(); expect(run.readProgress!.epoch).toBe(original.readProgress!.epoch);
  expect(run.readProgress!.nextStepIndex).toBe(original.readProgress!.nextStepIndex); expect(after.timelines[s.id]).toEqual(before.timelines[s.id]);
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.write), exactBridgeName(s.readback!)]);
  expect(s.sdk.callTool.mock.calls[1]![1]).toEqual({ value: "fixture report" });
  const history = await s.history(); expect(history).toMatchObject({ executionId: s.id, intentId: original.operationSecret!.intents.send!.id, nodeId: "send", canQuery: true, canResume: false,
    jobs: [{ id: queryId, executionId: s.id, intentId: original.operationSecret!.intents.send!.id, nodeId: "send", state: "ANSWERED", canCancel: false, basis: "queried-operation-state", observation: { outcome } }] });
  expect(JSON.stringify(history)).not.toMatch(/"(?:arguments|result|admission|connectionBinding|keyHash|requestFingerprint)":/);
  expect((await s.request("POST", `/api/executions/${s.id}/readbacks`, command)).json().data).toMatchObject({ id: queryId, replayed: true, state: "ANSWERED" });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const queryEvents = after.executionEvents[s.id]!.filter(event => event.type.startsWith("operation.readback_"));
  expect(queryEvents.map(event => event.type)).toEqual(["operation.readback_queued", "operation.readback_started", "operation.readback_dispatch_intent", "operation.readback_answered"]);
  expect(queryEvents.every(event => event.attemptId === queryId && event.nodeId === "send")).toBe(true);
});

test.each([["APPLIED", "APPLIED"], ["ABSENT", "NOT_APPLIED"]] as const)("an independent reviewer may close the exact case from a settled %s query without replay or resume", async (remoteState, outcome) => {
  const s = await uncertainReadbackOperation();
  await s.repository.mutate(state => {
    state.roles.recovery_only = { id: "recovery_only", name: "Recovery only", description: "Independent resolution", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", name: "Operator", email: "operator@example.test", roleId: "recovery_only" };
  });
  s.sdk.callTool.mockImplementationOnce(async (_name, args) => ({ content: [], structuredContent: { value: args.value, state: remoteState, settled: true, observedAt: new Date().toISOString() } }));
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand());
  const queryId = admitted.json().data.id; await s.waitQuery(queryId, "ANSWERED");
  expect((await s.history()).jobs[0]).toMatchObject({ id: queryId, canResolve: false });
  expect((await s.history("operator")).jobs[0]).toMatchObject({ id: queryId, canResolve: true, observation: { outcome } });
  const before = await s.repository.snapshot();
  const viewResponse = await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "operator");
  const view = viewResponse.json().data.operationReconciliation;
  const command = { intentId: view.intentId, baseVersion: view.version, factsHash: view.factsHash, decisionKey: `query-resolution-${remoteState.toLowerCase()}-0001`, queryId };
  const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ outcome, state: "RESOLVED", basis: "queried-operation-state", toolWasCalled: false, canResume: false, noReplay: true, replayed: false });
  const after = await s.repository.snapshot(), run = after.executions[s.id]!;
  expect(run.status).toBe("RECONCILED"); expect(run.operationSecret!.intents.send!.state).toBe("UNKNOWN");
  expect(run.stepOutputs).toEqual(before.executions[s.id]!.stepOutputs); expect(run.finalOutput).toBeUndefined();
  expect(Object.values(run.operationSecret!.reconciliations!)[0]).toMatchObject({ basis: "queried-operation-state", queryId, outcome, observation: { outcome, settled: true } });
  expect(after.timelines[s.id]!.find(item => item.nodeId === "send")?.reconciliation).toMatchObject({ basis: "queried-operation-state", queryId, outcome });
  expect((await s.request("GET", "/api/execution-reviews?state=closed", undefined, "operator")).json().data.items).toMatchObject([
    { executionId: s.id, statusLabel: "Closed by reviewed ERP status", actionable: false }]);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const replay = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.replayed).toBe(true);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

async function resolvedNotAppliedQueryOperation(storage: PersistenceBackend | null = null) {
  const s = await uncertainReadbackOperation(storage);
  await s.repository.mutate(state => {
    state.roles.recovery_only = { id: "recovery_only", name: "Recovery only", description: "Independent resolution", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", name: "Operator", email: "operator@example.test", roleId: "recovery_only" };
  });
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()), queryId = admitted.json().data.id;
  await s.waitQuery(queryId, "ANSWERED");
  const view = (await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "operator")).json().data.operationReconciliation;
  const decision = await s.request("POST", `/api/executions/${s.id}/reconcile`, { intentId: view.intentId, baseVersion: view.version, factsHash: view.factsHash,
    decisionKey: "query-recovery-source-0001", queryId }, "operator");
  expect(decision.statusCode, decision.body).toBe(200); expect(decision.json().data.outcome).toBe("NOT_APPLIED");
  return { ...s, queryId, reconciliationId: decision.json().data.recordId as string };
}

async function savedRecoveryPlan(storage: PersistenceBackend | null = null) {
  const s = await resolvedNotAppliedQueryOperation(storage), history = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  const command = { intentId: history.intentId, sourceVersion: history.sourceVersion, factsHash: history.factsHash, reconciliationId: s.reconciliationId,
    queryId: s.queryId, idempotencyKey: "linked-recovery-plan-helper-01" };
  const response = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, command); expect(response.statusCode, response.body).toBe(201);
  return { ...s, artifact: response.json().data.artifact as { id: string; artifactHash: string; action: { capabilityId: string } } };
}

test("the source requester can save one immutable linked recovery plan without dispatching or changing the closed run", async () => {
  const s = await resolvedNotAppliedQueryOperation(), before = await s.repository.snapshot(), calls = s.sdk.callTool.mock.calls.length;
  const ownerHistory = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  expect(ownerHistory).toMatchObject({ profile: "operation-recovery-artifact-history/v1", sourceExecutionId: s.id, state: "CLOSED_NOT_APPLIED", canCreate: true,
    dispatchAuthority: false, artifacts: [] });
  expect((await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`, undefined, "operator")).json().data.canCreate).toBe(false);
  const command = { intentId: ownerHistory.intentId, sourceVersion: ownerHistory.sourceVersion, factsHash: ownerHistory.factsHash,
    reconciliationId: s.reconciliationId, queryId: s.queryId, idempotencyKey: "linked-recovery-plan-0001" };
  const created = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, command); expect(created.statusCode, created.body).toBe(201);
  expect(created.json().data).toMatchObject({ replayed: false, artifact: { profile: "operation-recovery-artifact/v1", state: "REVIEW_REQUIRED", dispatchAuthority: false,
    sourceRunUnchanged: true, source: { executionId: s.id, intentId: command.intentId, reconciliationId: s.reconciliationId, queryId: s.queryId, outcome: "NOT_APPLIED" },
    action: { toolId: s.write.tool_id, arguments: { value: "fixture report" } },
    requirements: ["current-capability-validation", "fresh-independent-approval", "new-execution-and-intent", "new-idempotency-boundary"] } });
  expect(created.body).not.toMatch(/keyHash|requestFingerprint|roleId|operationSecret|runtimeApprovalSecret/);
  const after = await s.repository.snapshot(), source = after.executions[s.id]!;
  expect(source.status).toBe("RECONCILED"); expect(source.operationSecret!.intents.send!.state).toBe("UNKNOWN"); expect(source.stepOutputs).toEqual(before.executions[s.id]!.stepOutputs);
  expect(source.finalOutput).toBeUndefined(); expect(source.readProgress!.nextStepIndex).toBe(before.executions[s.id]!.readProgress!.nextStepIndex);
  expect(source.readProgress!.lastSequence).toBe(before.executions[s.id]!.readProgress!.lastSequence + 1); expect(s.sdk.callTool).toHaveBeenCalledTimes(calls);
  const history = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  expect(history.canCreate).toBe(false); expect(history.artifacts).toHaveLength(1); expect(history.artifacts[0].id).toBe(created.json().data.artifact.id);
  const replay = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, command); expect(replay.statusCode).toBe(200); expect(replay.json().data.replayed).toBe(true);
  expect((await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, { ...command, idempotencyKey: "linked-recovery-plan-0002" })).statusCode).toBe(409);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(calls);
});

test("linked recovery cannot be created by a reviewer, from APPLIED/operator evidence, or with browser-authored action fields", async () => {
  const s = await resolvedNotAppliedQueryOperation(), history = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  const command = { intentId: history.intentId, sourceVersion: history.sourceVersion, factsHash: history.factsHash, reconciliationId: s.reconciliationId,
    queryId: s.queryId, idempotencyKey: "linked-recovery-denial-01" };
  expect((await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, command, "operator")).statusCode).toBe(403);
  expect((await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, { ...command, outcome: "NOT_APPLIED", arguments: { value: "changed" } })).statusCode).toBe(422);
  const applied = await uncertainReadbackOperation();
  await applied.repository.mutate(state => { state.roles.review!.permissions.push("execution:reconcile"); });
  applied.sdk.callTool.mockImplementationOnce(async (_name, args) => ({ content: [], structuredContent: { value: args.value, state: "APPLIED", settled: true, observedAt: new Date().toISOString() } }));
  const admitted = await applied.request("POST", `/api/executions/${applied.id}/readbacks`, await applied.queryCommand()), queryId = admitted.json().data.id; await applied.waitQuery(queryId, "ANSWERED");
  const review = (await applied.request("GET", `/api/executions/${applied.id}?view=reconciliation`, undefined, "reviewer")).json().data.operationReconciliation;
  await applied.request("POST", `/api/executions/${applied.id}/reconcile`, { intentId: review.intentId, baseVersion: review.version, factsHash: review.factsHash, decisionKey: "applied-query-close-0001", queryId }, "reviewer");
  expect((await applied.request("GET", `/api/executions/${applied.id}/recovery-artifacts`)).json().data).toMatchObject({ state: "EFFECT_OBSERVED", canCreate: false, artifacts: [] });
  const attested = await uncertainOperation(); await attested.request("POST", `/api/executions/${attested.id}/reconcile`, await attested.evidenceCommand("NOT_APPLIED"), "operator");
  expect((await attested.request("GET", `/api/executions/${attested.id}/recovery-artifacts`)).json().data).toMatchObject({ state: "EVIDENCE_NOT_QUALIFIED", canCreate: false, artifacts: [] });
});

test("tampered linked recovery evidence fails closed and normalized storage preserves the exact record", async () => {
  const s = await resolvedNotAppliedQueryOperation(), history = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  const command = { intentId: history.intentId, sourceVersion: history.sourceVersion, factsHash: history.factsHash, reconciliationId: s.reconciliationId,
    queryId: s.queryId, idempotencyKey: "linked-recovery-tamper-01" };
  const created = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, command), artifactId = created.json().data.artifact.id;
  const snapshot = await s.repository.snapshot(), layout = splitFirestoreState(snapshot), leaf = layout.find(record => record.path[0] === "operation-recoveries" && record.path[2] === artifactId);
  expect(leaf).toBeDefined(); expect((layout.find(record => record.path[0] === "executions" && record.path[1] === s.id)!.value as any).operationSecret.recoveries).toEqual({});
  expect(assembleFirestoreState(layout).executions[s.id]!.operationSecret!.recoveries![artifactId]).toEqual(snapshot.executions[s.id]!.operationSecret!.recoveries![artifactId]);
  await s.repository.mutateExecution(s.id, state => { state.executions[s.id]!.operationSecret!.recoveries![artifactId]!.action.arguments.value = "tampered"; });
  expect((await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).statusCode).toBe(409); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("linked recovery post-commit acknowledgement loss requires authoritative reload and same-key replay", async () => {
  const storage = new Records(), s = await resolvedNotAppliedQueryOperation(storage), history = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  const command = { intentId: history.intentId, sourceVersion: history.sourceVersion, factsHash: history.factsHash, reconciliationId: s.reconciliationId,
    queryId: s.queryId, idempotencyKey: "linked-recovery-ack-loss-01" };
  storage.loseWhen = state => Object.keys(state.executions[s.id]?.operationSecret?.recoveries ?? {}).length === 1;
  const unknown = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, command); expect(unknown.statusCode, unknown.body).toBe(503);
  expect(unknown.json().message).toMatch(/unconfirmed|reload/i); expect(() => s.repository.assertAuthority()).toThrow();
  await s.repository.recoverPersistenceState(); const recovered = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  expect(recovered.artifacts).toHaveLength(1); expect(recovered.canCreate).toBe(false);
  const replay = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts`, command); expect(replay.statusCode).toBe(200); expect(replay.json().data.replayed).toBe(true);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("a saved plan admits a separate operation with new identity and fresh approval before one SDK dispatch", async () => {
  const s = await savedRecoveryPlan(), before = await s.repository.snapshot(), sourceBefore = structuredClone(before.executions[s.id]!);
  const originalApprovalId = sourceBefore.runtimeApprovalSecret!.activeId, command = { artifactHash: s.artifact.artifactHash, idempotencyKey: "recovery-execution-admit-01" };
  const admitted = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, command); expect(admitted.statusCode, admitted.body).toBe(202);
  const receipt = admitted.json().data; expect(receipt).toMatchObject({ sourceExecutionId: s.id, artifactId: s.artifact.id, replayed: false, freshApprovalRequired: true, sourceRunUnchanged: true });
  expect(receipt.executionId).not.toBe(s.id); expect(receipt.workflowId).not.toBe("flow"); await s.wait(receipt.executionId, "AWAITING_APPROVAL");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const approval = await s.review(receipt.executionId); expect(approval).toMatchObject({ state: "PENDING", canDecide: true, arguments: { value: "fixture report" } });
  expect(approval.id).not.toBe(originalApprovalId);
  const approved = await s.request("POST", `/api/executions/${receipt.executionId}/approve`, { approvalId: approval.id, baseVersion: approval.version, reviewHash: approval.reviewHash,
    decisionKey: "recovery-fresh-approval-01" }, "reviewer"); expect(approved.statusCode, approved.body).toBe(200);
  await s.wait(receipt.executionId, "DONE"); const after = await s.repository.snapshot(), recovery = after.executions[receipt.executionId]!;
  expect(s.sdk.callTool).toHaveBeenCalledTimes(3); expect(s.sdk.callTool.mock.calls[2]![1]).toEqual({ value: "fixture report" });
  expect(recovery.recoverySource).toEqual({ profile: "operation-recovery-source/v1", sourceExecutionId: s.id, artifactId: s.artifact.id, artifactHash: s.artifact.artifactHash });
  expect(recovery.operationSecret!.intents.recover_action!.id).not.toBe(sourceBefore.operationSecret!.intents.send!.id); expect(recovery.finalOutput).toMatchObject({ structuredContent: { accepted: true } });
  expect(after.executions[s.id]).toEqual(sourceBefore);
  const history = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data;
  expect(history).toMatchObject({ canAdmit: false, linkedExecution: { executionId: receipt.executionId, workflowId: receipt.workflowId, status: "DONE" } });
  const replay = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, command); expect(replay.statusCode).toBe(202); expect(replay.json().data.replayed).toBe(true);
  expect((await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, { ...command, idempotencyKey: "recovery-execution-admit-02" })).statusCode).toBe(409);
  expect((await s.request("POST", `/api/workflows/${receipt.workflowId}/run`, { mode: "async-operation", idempotencyKey: "forbidden-second-recovery-01", input: {} })).statusCode).toBe(409);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(3);
});

test("recovery admission rejects reviewer/client authority, browser-authored action and changed current capability before dispatch", async () => {
  const s = await savedRecoveryPlan(), command = { artifactHash: s.artifact.artifactHash, idempotencyKey: "recovery-admission-denied-01" };
  expect((await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, command, "reviewer")).statusCode).toBe(403);
  expect((await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, { ...command, arguments: { value: "changed" }, outcome: "NOT_APPLIED" })).statusCode).toBe(422);
  await s.repository.mutate(state => { state.capabilityAdmissions[s.artifact.action.capabilityId]!.state = "DISABLED"; });
  const denied = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, command); expect([409, 422]).toContain(denied.statusCode);
  expect(Object.values((await s.repository.snapshot()).executions).filter(item => item.recoverySource)).toHaveLength(0); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("recovery admission post-commit acknowledgement loss reveals one new pending execution and same-key replay only", async () => {
  const storage = new Records(), s = await savedRecoveryPlan(storage), command = { artifactHash: s.artifact.artifactHash, idempotencyKey: "recovery-admission-ack-loss-01" };
  storage.loseWhen = state => Object.values(state.executions).some(item => item.recoverySource?.artifactId === s.artifact.id);
  const unknown = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, command); expect(unknown.statusCode, unknown.body).toBe(503);
  expect(unknown.json().message).toMatch(/unconfirmed|reload/i); expect(() => s.repository.assertAuthority()).toThrow(); await s.repository.recoverPersistenceState();
  const state = await s.repository.snapshot(), linked = Object.values(state.executions).filter(item => item.recoverySource?.artifactId === s.artifact.id);
  expect(linked).toHaveLength(1); expect(linked[0]!.status).toBe("PENDING"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const history = (await s.request("GET", `/api/executions/${s.id}/recovery-artifacts`)).json().data; expect(history.linkedExecution.executionId).toBe(linked[0]!.id);
  const replay = await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, command); expect(replay.statusCode).toBe(202); expect(replay.json().data.replayed).toBe(true);
  expect((await s.request("POST", `/api/executions/${s.id}/recovery-artifacts/${s.artifact.id}/admit`, { ...command, idempotencyKey: "recovery-admission-ack-loss-02" })).statusCode).toBe(409);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("query-backed resolution rejects browser-supplied outcomes, unresolved observations and the original requester", async () => {
  const s = await uncertainReadbackOperation();
  await s.repository.mutate(state => {
    state.roles.recovery_only = { id: "recovery_only", name: "Recovery only", description: "Independent resolution", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", roleId: "recovery_only" };
  });
  s.sdk.callTool.mockImplementationOnce(async (_name, args) => ({ content: [], structuredContent: { value: args.value, state: "PENDING", settled: true, observedAt: new Date().toISOString() } }));
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand());
  const queryId = admitted.json().data.id; await s.waitQuery(queryId, "ANSWERED");
  const view = (await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "operator")).json().data.operationReconciliation;
  const command = { intentId: view.intentId, baseVersion: view.version, factsHash: view.factsHash, decisionKey: "query-resolution-denied-0001", queryId };
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, { ...command, outcome: "NOT_APPLIED" }, "operator")).statusCode).toBe(422);
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator")).statusCode).toBe(409);
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "requester")).statusCode).toBe(403);
  expect((await s.repository.snapshot()).executions[s.id]!.status).toBe("RECONCILIATION_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("tampering with a query result after reviewed resolution invalidates the evidence chain instead of preserving a false closure", async () => {
  const s = await uncertainReadbackOperation();
  await s.repository.mutate(state => {
    state.roles.recovery_only = { id: "recovery_only", name: "Recovery only", description: "Independent resolution", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", roleId: "recovery_only" };
  });
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()), queryId = admitted.json().data.id; await s.waitQuery(queryId, "ANSWERED");
  const view = (await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "operator")).json().data.operationReconciliation;
  const command = { intentId: view.intentId, baseVersion: view.version, factsHash: view.factsHash, decisionKey: "query-resolution-tamper-0001", queryId };
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator")).statusCode).toBe(200);
  await s.repository.mutate(state => { state.executions[s.id]!.operationSecret!.readbacks![queryId]!.result!.structuredContent.state = "APPLIED"; });
  const denied = await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "operator"); expect(denied.statusCode, denied.body).toBe(409);
  expect(denied.json().message).toMatch(/evidence|classification/i); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("status history is minimum/scoped and review or reconciliation authority alone never grants query dispatch", async () => {
  const s = await uncertainReadbackOperation();
  await s.repository.mutate(state => {
    state.roles.recovery_only = { id: "recovery_only", name: "Recovery only", description: "No dispatch grant", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", roleId: "recovery_only" };
    state.users.outsider = { ...state.users.reviewer!, id: "outsider", roleId: "role_client" };
  });
  expect(await s.history("operator")).toMatchObject({ canQuery: false, jobs: [] }); const command = await s.queryCommand();
  for (const actor of ["reviewer", "operator", "outsider"]) {
    expect((await s.request("POST", `/api/executions/${s.id}/readbacks`, command, actor)).statusCode).toBe(actor === "outsider" ? 404 : 403);
  }
  expect((await s.request("GET", `/api/executions/${s.id}/readbacks`, undefined, "reviewer")).statusCode).toBe(403);
  expect((await s.request("GET", `/api/executions/${s.id}/readbacks`, undefined, "outsider")).statusCode).toBe(404);
  expect((await s.request("GET", `/api/executions/${s.id}`, undefined, "operator")).statusCode).toBe(404);
  const unauthenticated = await s.app.inject({ method: "GET", url: `/api/executions/${s.id}/readbacks` }); expect(unauthenticated.statusCode).toBe(401);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each(["client-result", "role", "bad-key", "wrong-intent", "stale-case", "wrong-facts"])("normal read-back admission rejects %s without another tool call", async scenario => {
  const s = await uncertainReadbackOperation(), command: Record<string, unknown> = await s.queryCommand();
  if (scenario === "client-result") command.result = { state: "APPLIED" };
  if (scenario === "role") command.role = "Platform Admin";
  if (scenario === "bad-key") command.idempotencyKey = "short";
  if (scenario === "wrong-intent") command.intentId = "not-the-original-intent";
  if (scenario === "stale-case") command.baseVersion = 100;
  if (scenario === "wrong-facts") command.factsHash = `sha256:${"0".repeat(64)}`;
  const response = await s.request("POST", `/api/executions/${s.id}/readbacks`, command);
  expect(response.statusCode, response.body).toBe(["client-result", "role", "bad-key"].includes(scenario) ? 422 : 409);
  expect((await s.history()).jobs).toEqual([]); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each(["wrong-identity", "stale-result", "text-only", "tool-error"])("normal read-back cannot save %s as qualified evidence", async scenario => {
  const s = await uncertainReadbackOperation();
  s.sdk.callTool.mockImplementationOnce(async () => {
    const structuredContent = { value: scenario === "wrong-identity" ? "ANOTHER" : "fixture report", state: "APPLIED", settled: true,
      observedAt: new Date(Date.now() - (scenario === "stale-result" ? 120000 : 0)).toISOString() };
    return scenario === "text-only" ? { content: [{ type: "text", text: "Sent successfully" }] } : { content: [], structuredContent, ...(scenario === "tool-error" ? { isError: true } : {}) };
  });
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()); expect(admitted.statusCode, admitted.body).toBe(202);
  // Reviewed-schema and tool-error failures are contained by the SDK adapter
  // before the broker returns an envelope. They cannot become query evidence.
  const interrupted = ["text-only", "tool-error"].includes(scenario);
  const id = admitted.json().data.id; await s.waitQuery(id, interrupted ? "RECOVERY_REQUIRED" : "FAILED");
  const job = (await s.repository.snapshot()).executions[s.id]!.operationSecret!.readbacks![id]!;
  expect(job.result).toBeUndefined(); expect(job.evaluation).toBeUndefined(); expect(job.failure).toBe(interrupted ? "READBACK_INTERRUPTED" : "READBACK_RESULT_UNQUALIFIED");
  expect((await s.history()).jobs[0]).toMatchObject({ queryOutcome: interrupted ? "UNKNOWN" : "UNQUALIFIED_RESULT", observation: null, noReplay: true, canResume: false });
  const run = (await s.repository.snapshot()).executions[s.id]!;
  expect(run.status).toBe("RECONCILIATION_REQUIRED"); expect(run.operationSecret!.intents.send!.state).toBe("UNKNOWN"); expect(run.stepOutputs).toEqual({});
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each(["disable-actor", "revoke-run", "disable-target", "change-role-map", "change-target"])("read-back %s immediately after intent acknowledgement fences final SDK entry", async scenario => {
  const s = await uncertainReadbackOperation(), mutate = s.repository.mutateExecution.bind(s.repository); let injected = false;
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (...args) => {
    const result = await mutate(...args), jobs = (await s.repository.snapshot()).executions[s.id]!.operationSecret!.readbacks;
    const job = Object.values(jobs ?? {}).find(job => job.state === "RUNNING" && job.dispatchIntentAt);
    if (job && !injected) {
      injected = true;
      if (scenario === "change-role-map") s.services.config.erpbridgeRoleMap = { "Platform Admin": "another-role" };
      else if (scenario === "change-target") s.readback!.description = "Changed after exact query intent";
      else await s.repository.mutate(state => {
        if (scenario === "disable-actor") state.users.requester!.status = "Disabled";
        if (scenario === "revoke-run") state.users.requester!.roleId = "review";
        if (scenario === "disable-target") state.capabilityAdmissions[job.admission.capabilityId]!.state = "DISABLED";
      });
    }
    return result;
  });
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()); expect(admitted.statusCode, admitted.body).toBe(202);
  await s.waitQuery(admitted.json().data.id, "RECOVERY_REQUIRED"); expect(injected).toBe(true); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("an entered query can be cancelled without adopting a late answer or changing its original unknown effect", async () => {
  const s = await uncertainReadbackOperation(); let release!: () => void;
  s.sdk.callTool.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { content: [], structuredContent: {
    value: "fixture report", state: "APPLIED", settled: true, observedAt: new Date().toISOString() } }; });
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()); expect(admitted.statusCode, admitted.body).toBe(202);
  const id = admitted.json().data.id; await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect((await s.request("POST", `/api/executions/${s.id}/readbacks/${id}/cancel`, {})).statusCode).toBe(202); release();
  await s.waitQuery(id, "RECOVERY_REQUIRED"); const run = (await s.repository.snapshot()).executions[s.id]!;
  expect(run.operationSecret!.readbacks![id]!.result).toBeUndefined(); expect(run.operationSecret!.intents.send!.state).toBe("UNKNOWN");
  expect(run.status).toBe("RECONCILIATION_REQUIRED"); expect(run.stepOutputs).toEqual({}); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each(["intent", "result"])("durable read-back %s post-COMMIT ACK loss survives authoritative recovery/restart without another query or effect", async phase => {
  const storage = new Records(), s = await uncertainReadbackOperation(storage), command = await s.queryCommand(); let lost = false;
  storage.loseWhen = state => {
    const job = Object.values(state.executions[s.id]!.operationSecret!.readbacks ?? {})[0];
    if (!job || (phase === "intent" ? !job.dispatchIntentAt || job.state !== "RUNNING" : job.state !== "ANSWERED")) return false;
    lost = true; return true;
  };
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, command); expect(admitted.statusCode, admitted.body).toBe(202);
  await vi.waitFor(() => expect(lost).toBe(true)); expect(() => s.repository.assertAuthority()).toThrow();
  expect((await s.request("GET", `/api/executions/${s.id}/readbacks`)).statusCode).toBe(503);
  await s.repository.recoverPersistenceState(); const count = s.sdk.callTool.mock.calls.length;
  await operationReadbackQueue(s.services).stop(); const restarted = operationReadbackQueue(s.services); closers.push({ close: () => restarted.stop() }); await restarted.start();
  const id = admitted.json().data.id; await s.waitQuery(id, phase === "intent" ? "RECOVERY_REQUIRED" : "ANSWERED");
  const history = await s.history(); expect(history.jobs[0]).toMatchObject({ id, state: phase === "intent" ? "RECOVERY_REQUIRED" : "ANSWERED" });
  const replay = await s.request("POST", `/api/executions/${s.id}/readbacks`, command); expect(replay.statusCode, replay.body).toBe(202); expect(replay.json().data).toMatchObject({ id, replayed: true });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(count); expect(count).toBe(phase === "intent" ? 1 : 2);
  const layout = splitFirestoreState(await s.repository.snapshot()), leaf = layout.find(record => record.path[0] === "operation-readbacks" && record.path[2] === id);
  expect(leaf).toBeDefined(); expect((layout.find(record => record.path[0] === "executions" && record.path[1] === s.id)!.value as any).operationSecret.readbacks).toEqual({});
  expect(assembleFirestoreState(layout).executions[s.id]!.operationSecret!.readbacks![id]).toEqual((await s.repository.snapshot()).executions[s.id]!.operationSecret!.readbacks![id]);
});

test.each(["arguments", "classification", "result", "target-pin", "source-facts", "request-fingerprint", "actor", "key", "state"])("altered saved read-back %s cannot be shown as trusted historical evidence", async scenario => {
  const s = await uncertainReadbackOperation(), admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand());
  expect(admitted.statusCode, admitted.body).toBe(202); const id = admitted.json().data.id; await s.waitQuery(id, "ANSWERED");
  await s.repository.mutate(state => {
    const job = state.executions[s.id]!.operationSecret!.readbacks![id]!;
    if (scenario === "arguments") job.arguments.value = "FORGED";
    if (scenario === "classification") job.evaluation!.outcome = "APPLIED";
    if (scenario === "result") job.result!.structuredContent.value = "ANOTHER";
    if (scenario === "target-pin") job.admission.admissionVersion++;
    if (scenario === "source-facts") job.factsHash = `sha256:${"0".repeat(64)}`;
    if (scenario === "request-fingerprint") job.requestFingerprint = `sha256:${"0".repeat(64)}`;
    if (scenario === "actor") job.actorId = "another-actor";
    if (scenario === "key") job.keyHash = `sha256:${"0".repeat(64)}`;
    if (scenario === "state") job.state = "RECOVERY_REQUIRED";
  });
  const denied = await s.request("GET", `/api/executions/${s.id}/readbacks`); expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().data).toBeNull(); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("query admission post-COMMIT ACK loss reloads the original key and one queued query without repeating its effect", async () => {
  const storage = new Records(), s = await uncertainReadbackOperation(storage), command = await s.queryCommand();
  storage.loseWhen = state => Object.values(state.executions[s.id]!.operationSecret!.readbacks ?? {}).some(job => job.state === "QUEUED");
  const unconfirmed = await s.request("POST", `/api/executions/${s.id}/readbacks`, command); expect(unconfirmed.statusCode, unconfirmed.body).toBe(503);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect(() => s.repository.assertAuthority()).toThrow();
  await s.repository.recoverPersistenceState(); const queued = Object.values((await s.repository.snapshot()).executions[s.id]!.operationSecret!.readbacks!);
  expect(queued).toHaveLength(1); expect(queued[0]!.state).toBe("QUEUED");
  await operationReadbackQueue(s.services).stop(); const restarted = operationReadbackQueue(s.services); closers.push({ close: () => restarted.stop() }); await restarted.start();
  await s.waitQuery(queued[0]!.id, "ANSWERED");
  const events = (await s.repository.snapshot()).executionEvents[s.id];
  const replay = await s.request("POST", `/api/executions/${s.id}/readbacks`, command); expect(replay.statusCode, replay.body).toBe(202);
  expect(replay.json().data).toMatchObject({ id: queued[0]!.id, replayed: true, state: "ANSWERED" });
  expect((await s.repository.snapshot()).executionEvents[s.id]).toEqual(events); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("query keys cannot be reused for different case evidence", async () => {
  const s = await uncertainReadbackOperation(), command = await s.queryCommand();
  const receipt = await s.request("POST", `/api/executions/${s.id}/readbacks`, command); await s.waitQuery(receipt.json().data.id, "ANSWERED");
  const denied = await s.request("POST", `/api/executions/${s.id}/readbacks`, { ...command, baseVersion: command.baseVersion + 1 });
  expect(denied.statusCode, denied.body).toBe(409); expect((await s.history()).jobs).toHaveLength(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("one queued query per case is enforced and queued cancellation starts no SDK call", async () => {
  const s = await uncertainReadbackOperation(); await operationReadbackQueue(s.services).stop();
  const paused = operationReadbackQueue(s.services); closers.push({ close: () => paused.stop() });
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()); expect(admitted.statusCode, admitted.body).toBe(202);
  const id = admitted.json().data.id; expect(admitted.json().data).toMatchObject({ executionId: s.id, intentId: (await s.history()).intentId, nodeId: "send", state: "QUEUED" });
  expect(admitted.json().data).not.toHaveProperty("canCancel");
  expect(await s.history()).toMatchObject({ canQuery: false, jobs: [{ id, canCancel: true }] });
  expect((await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand("different-query-key-0001"))).statusCode).toBe(429);
  expect((await s.request("POST", `/api/executions/${s.id}/readbacks/${id}/cancel`, { result: "cancelled" })).statusCode).toBe(400);
  const cancelled = await s.request("POST", `/api/executions/${s.id}/readbacks/${id}/cancel`, {}); expect(cancelled.statusCode, cancelled.body).toBe(200);
  expect(cancelled.json().data).toMatchObject({ executionId: s.id, intentId: admitted.json().data.intentId, nodeId: "send", state: "CANCELLED", queryOutcome: "NOT_DISPATCHED" });
  expect((await s.history()).jobs[0].canCancel).toBe(false);
  await paused.start(); expect((await s.history()).canQuery).toBe(true); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("query history control metadata follows fresh authority without granting minimum recovery-only readers cancellation", async () => {
  const s = await uncertainReadbackOperation(); await operationReadbackQueue(s.services).stop();
  const paused = operationReadbackQueue(s.services); closers.push({ close: () => paused.stop() });
  await s.repository.mutate(state => {
    state.roles.recovery_only = { id: "recovery_only", name: "Recovery only", description: "No query control", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", roleId: "recovery_only" };
  });
  const receipt = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()), id = receipt.json().data.id;
  expect(receipt.statusCode, receipt.body).toBe(202);
  expect((await s.history()).jobs[0]).toMatchObject({ id, executionId: s.id, nodeId: "send", canCancel: true });
  const minimum = await s.history("operator");
  expect(minimum).toMatchObject({ executionId: s.id, nodeId: "send", canQuery: false, jobs: [{ id, intentId: minimum.intentId, canCancel: false }] });
  expect((await s.request("POST", `/api/executions/${s.id}/readbacks/${id}/cancel`, {}, "operator")).statusCode).toBe(403);
  expect((await s.request("GET", `/api/executions/${s.id}`, undefined, "operator")).statusCode).toBe(404);
  await s.repository.mutate(state => { state.users.requester!.roleId = "review"; state.users.requester!.permissionOverrides = ["execution:read_own"]; });
  expect(await s.history()).toMatchObject({ canQuery: false, jobs: [{ id, state: "QUEUED", canCancel: false }] });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each(["disconnect", "revoke-target", "revoke-run"])("saved query history survives %s without granting another dispatch", async scenario => {
  const s = await uncertainReadbackOperation(), admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand());
  const id = admitted.json().data.id; await s.waitQuery(id, "ANSWERED"); const history = await s.history();
  if (scenario === "disconnect") s.services.erpbridgeSession = { ...s.session, available: false };
  else await s.repository.mutate(state => {
    if (scenario === "revoke-run") state.users.requester!.permissionOverrides = ["execution:read_own"], state.users.requester!.roleId = "review";
    else state.capabilityAdmissions[state.executions[s.id]!.operationSecret!.readbacks![id]!.admission.capabilityId]!.state = "DISABLED";
  });
  const after = await s.history(); expect(after.jobs).toEqual(history.jobs); expect(after.canQuery).toBe(false);
  const denied = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand("new-after-revoke-key-0001"));
  expect([403, 409, 503]).toContain(denied.statusCode); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("independent observations and closure keep earlier query evidence bound to its historical case revision", async () => {
  const s = await uncertainReadbackOperation(), first = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand());
  await s.waitQuery(first.json().data.id, "ANSWERED"); const originalQuery = (await s.history()).jobs[0];
  await s.repository.mutate(state => {
    state.roles.recovery_only = { id: "recovery_only", name: "Recovery only", description: "No dispatch", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", roleId: "recovery_only" };
  });
  for (const outcome of ["UNRESOLVED", "NOT_APPLIED"] as const) {
    const view = (await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "operator")).json().data.operationReconciliation;
    const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, { intentId: view.intentId, baseVersion: view.version, factsHash: view.factsHash,
      decisionKey: `readback-observation-${outcome}`, outcome, evidence: { kind: "external-support", reference: "SYNTHETIC-ONLY", note: "Independent fixture evidence, not delivery proof", observedAt: new Date().toISOString() } }, "operator");
    expect(response.statusCode, response.body).toBe(200);
    const history = await s.history(); expect(history.jobs[0]).toEqual(originalQuery); expect(history.baseVersion).toBe(view.version + 1);
    expect(history.canQuery).toBe(outcome === "UNRESOLVED");
  }
  const run = (await s.repository.snapshot()).executions[s.id]!; expect(run.status).toBe("RECONCILED");
  expect(run.operationSecret!.intents.send!.state).toBe("UNKNOWN"); expect(run.stepOutputs).toEqual({}); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("query lease expiry discards a late SDK answer and never repeats the original effect", async () => {
  const s = await uncertainReadbackOperation(); let release!: () => void;
  s.sdk.callTool.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { content: [], structuredContent: {
    value: "fixture report", state: "APPLIED", settled: true, observedAt: new Date().toISOString() } }; });
  const admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, await s.queryCommand()), id = admitted.json().data.id;
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await s.repository.mutateExecution(s.id, state => { state.executions[s.id]!.operationSecret!.readbacks![id]!.lease!.expiresAt = Date.now() - 1; });
  release(); await s.waitQuery(id, "RECOVERY_REQUIRED");
  const history = await s.history(); expect(history.jobs[0]).toMatchObject({ queryOutcome: "UNKNOWN", observation: null, canResume: false, noReplay: true });
  expect((await s.repository.snapshot()).executions[s.id]!.operationSecret!.intents.send!.state).toBe("UNKNOWN"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("query heartbeat ACK loss fences an entered query and recovery never adopts its late answer", async () => {
  const storage = new Records(), s = await uncertainReadbackOperation(storage); s.services.config.readWorkerLeaseMs = 3000;
  let release!: () => void;
  s.sdk.callTool.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { content: [], structuredContent: {
    value: "fixture report", state: "APPLIED", settled: true, observedAt: new Date().toISOString() } }; });
  const command = await s.queryCommand(), admitted = await s.request("POST", `/api/executions/${s.id}/readbacks`, command), id = admitted.json().data.id;
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const initialExpiry = (await s.repository.snapshot()).executions[s.id]!.operationSecret!.readbacks![id]!.lease!.expiresAt; let lost = false;
  storage.loseWhen = state => {
    const query = state.executions[s.id]!.operationSecret!.readbacks![id]!;
    if (query.state !== "RUNNING" || !query.lease || query.lease.expiresAt <= initialExpiry) return false;
    lost = true; return true;
  };
  await vi.waitFor(() => expect(lost).toBe(true), { timeout: 3000 }); expect(() => s.repository.assertAuthority()).toThrow(); release();
  expect((await s.request("GET", `/api/executions/${s.id}/readbacks`)).statusCode).toBe(503);
  await s.repository.recoverPersistenceState(); await operationReadbackQueue(s.services).stop();
  const restarted = operationReadbackQueue(s.services); closers.push({ close: () => restarted.stop() }); await restarted.start(); await s.waitQuery(id, "RECOVERY_REQUIRED");
  expect((await s.history()).jobs[0]).toMatchObject({ queryOutcome: "UNKNOWN", observation: null });
  expect((await s.request("POST", `/api/executions/${s.id}/readbacks`, command)).json().data.replayed).toBe(true); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});
test.each(["reject", "cancel", "self", "revoke-requester", "revoke-admission", "change-args", "expire"])("a waiting operation contains %s without write dispatch", async scenario => {
  const s = await setup(null, false), id = await s.admit(), command = await s.command(id);
  if (scenario === "reject") expect((await s.request("POST", `/api/executions/${id}/reject`, command, "reviewer")).statusCode).toBe(200);
  else if (scenario === "cancel") { const result = await s.request("POST", `/api/executions/${id}/cancel`, {}); expect(result.statusCode, result.body).toBe(200); expect(result.body).not.toMatch(/operationSecret|runtimeApprovalSecret/); }
  else {
    await s.repository.mutate(state => {
      if (scenario === "revoke-requester") state.users.requester!.status = "Disabled";
      if (scenario === "revoke-admission") { const record = state.executions[id]!.runtimeApprovalSecret!; state.capabilityAdmissions[record.records[record.activeId]!.binding.capabilityId]!.state = "DISABLED"; }
      if (scenario === "change-args") state.executions[id]!.workflowSnapshot!.input = { changed: true }; // irrelevant inputs do not change literal arguments
    });
    if (scenario === "change-args") await s.repository.mutate(state => { state.executions[id]!.workflowSnapshot!.yaml += "# tampered\n"; });
    if (scenario === "expire") { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 301000); }
    const result = await s.request("POST", `/api/executions/${id}/approve`, command, scenario === "self" ? "requester" : "reviewer"); expect([403, 409]).toContain(result.statusCode);
  }
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});
test.each(["transport", "error-envelope", "false-confirmation", "wrong-schema"])("uncertain %s is never replayed or exposed as a successful operation", async scenario => {
  const s = await setup(null, false), id = await s.admit();
  s.sdk.callTool.mockImplementation(async () => {
    if (scenario === "transport") throw new Error("Synthetic acknowledgement lost");
    return scenario === "error-envelope" ? { content: [], isError: true } : { content: [], structuredContent: scenario === "false-confirmation" ? { accepted: false, id: "fixture" } : { unexpected: "fixture" } };
  });
  expect((await s.request("POST", `/api/executions/${id}/approve`, await s.command(id), "reviewer")).statusCode).toBe(200);
  await s.wait(id, "RECONCILIATION_REQUIRED"); const execution = (await s.repository.snapshot()).executions[id]!;
  expect(execution.stepOutputs).toEqual({}); expect(execution.finalOutput).toBeUndefined(); expect(execution.readProgress!.attempts.send!.status).toBe("UNKNOWN");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect((await s.run()).json().data.id).toBe(id); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});
test("private normalized operation intent/result leaves survive reopen without growing the execution metadata or granting public access", async () => {
  const records = new Records(), s = await setup(records, false), id = await s.admit();
  await s.request("POST", `/api/executions/${id}/approve`, await s.command(id), "reviewer"); await s.wait(id, "DONE");
  const state = await s.repository.snapshot(), cells = splitFirestoreState(state);
  expect(cells.filter(cell => cell.path[0] === "operation-intents")).toHaveLength(1);
  expect(assembleFirestoreState(cells)).toEqual(state); expect(withoutSecretFields(state.executions[id])).not.toHaveProperty("operationSecret");
  const restored = await Repository.open(records); expect((await restored.snapshot()).executions[id]!.operationSecret).toEqual(state.executions[id]!.operationSecret);
});
test("post-commit intent acknowledgement loss fences SDK entry and restart reconciles without replay", async () => {
  const records = new Records(), s = await setup(records, false), id = await s.admit();
  records.loseWhen = state => state.executions[id]?.operationSecret?.intents.send?.state === "DISPATCH_INTENT";
  await s.request("POST", `/api/executions/${id}/approve`, await s.command(id), "reviewer");
  await vi.waitFor(() => expect(JSON.parse(records.bytes!.toString()).executions[id].operationSecret.intents.send.state).toBe("DISPATCH_INTENT"));
  expect(s.sdk.callTool).not.toHaveBeenCalled();
  await s.app.close();
  const repository = await Repository.open(records), services = { ...s.services, repository };
  const queue = operationJobQueue(services); await queue.start();
  expect((await repository.snapshot()).executions[id]!.status).toBe("RECONCILIATION_REQUIRED"); expect(s.sdk.callTool).not.toHaveBeenCalled(); await queue.stop();
});

test("an expired durable wait becomes terminal with readable node evidence and no dispatch", async () => {
  const s = await setup(), id = await s.admit(), state = await s.repository.snapshot();
  const record = state.executions[id]!.runtimeApprovalSecret!.records[state.executions[id]!.runtimeApprovalSecret!.activeId]!;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(record.expiresAt) + 1);
  // A committed change reschedules the timer at the already expired deadline.
  await s.repository.mutate(next => { next.settings.approvalExpiryFixture = true; });
  await s.wait(id, "FAILED"); const expired = await s.repository.snapshot(), run = expired.executions[id]!;
  expect(run.failure).toMatchObject({ failureCategory: "RUNTIME_APPROVAL_EXPIRED", failedStepId: "send" });
  expect(run.pendingApproval).toBeUndefined(); expect(run.operationSecret!.lease).toBeUndefined();
  expect(run.readProgress!.attempts.send).toMatchObject({ status: "FAILED", completedAt: expect.any(String) });
  expect(expired.timelines[id]!.find(entry => entry.nodeId === "send")).toMatchObject({ status: "FAILED", outcome: "NOT_DISPATCHED" });
  expect(run.stepOutputs!.lookup).toMatchObject({ structuredContent: { value: "FIXTURE REPORT" } });
  expect(s.sdk.callTool.mock.calls.map(call => call[0])).toEqual([exactBridgeName(s.read)]);
});

test.each(["approver", "admission", "governance", "cancel", "lease", "arguments"])("%s change after consumed intent fences final SDK entry and retires the permit", async scenario => {
  const s = await setup(null, false), id = await s.admit(), command = await s.command(id);
  let observers = 0, hookEntered = false;
  const observe = s.repository.observeCommits.bind(s.repository);
  vi.spyOn(s.repository, "observeCommits").mockImplementation(observer => {
    observers++; const unsubscribe = observe(observer);
    return () => { observers--; unsubscribe(); };
  });
  s.setDispatchAdmissionHook(async () => {
    const run = (await s.repository.snapshot()).executions[id]!;
    // Discovery also checks admission. Inject the fault only at final dispatch
    // admission, after the acknowledged intent and opaque permit exist.
    if (!run.operationSecret!.intents.send) return;
    expect(run.operationSecret!.intents.send!.state).toBe("DISPATCH_INTENT");
    expect(run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!.state).toBe("CONSUMED");
    expect(observers).toBe(1); hookEntered = true;
    if (scenario === "cancel") expect((await s.request("POST", `/api/executions/${id}/cancel`, {})).statusCode).toBe(202);
    else await s.repository.mutate(state => {
      const current = state.executions[id]!;
      if (scenario === "approver") state.users.reviewer!.status = "Disabled";
      if (scenario === "admission") state.capabilityAdmissions[current.runtimeApprovalSecret!.records[current.runtimeApprovalSecret!.activeId]!.binding.capabilityId]!.state = "DISABLED";
      if (scenario === "governance") state.governancePolicy = { fixtureRevision: "changed-after-verification" };
      if (scenario === "lease") current.operationSecret!.lease!.expiresAt = Date.now() - 1;
      if (scenario === "arguments") current.workflowSnapshot!.yaml += "# changed exact source\n";
    });
  });
  expect((await s.request("POST", `/api/executions/${id}/approve`, command, "reviewer")).statusCode).toBe(200);
  await s.wait(id, "RECONCILIATION_REQUIRED");
  expect(hookEntered).toBe(true); await vi.waitFor(() => expect(observers).toBe(0));
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions[id]!.stepOutputs).toEqual({});
});

test("cancellation during an entered SDK action keeps prior answers but never adopts the late response or retries", async () => {
  const s = await setup(), id = await s.admit();
  let release!: () => void;
  s.sdk.callTool.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { content: [], structuredContent: { accepted: true, id: "late" } }; });
  await s.request("POST", `/api/executions/${id}/approve`, await s.command(id), "reviewer");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const cancellation = await s.request("POST", `/api/executions/${id}/cancel`, {}); expect(cancellation.statusCode).toBe(202);
  release(); await s.wait(id, "RECONCILIATION_REQUIRED");
  const run = (await s.repository.snapshot()).executions[id]!;
  expect(run.stepOutputs!.lookup).toMatchObject({ structuredContent: { value: "FIXTURE REPORT" } }); expect(run.stepOutputs).not.toHaveProperty("send");
  expect(run.finalOutput).toBeUndefined(); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  expect((await s.run()).json().data.id).toBe(id); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("each effect in a multi-operation workflow obtains a different exact independent decision", async () => {
  const s = await setup(null, false);
  await s.repository.mutate(state => {
    const flow = state.workflows.flow!;
    flow.yaml = stringify({ name: flow.name, description: "Two exact synthetic notifications", trigger: { type: "manual" }, steps: [
      { id: "send", action: s.write.name, parameters: { value: "first report" } },
      { id: "send_again", action: s.write.name, parameters: { value: "{{send.structuredContent.id}}" } },
    ] }); flow.steps = 2;
  });
  const id = await s.admit(), first = await s.command(id);
  await s.request("POST", `/api/executions/${id}/approve`, first, "reviewer");
  await vi.waitFor(async () => {
    const run = (await s.repository.snapshot()).executions[id]!;
    expect(run.status).toBe("AWAITING_APPROVAL"); expect(run.pendingApproval?.stepId).toBe("send_again");
  });
  const second = await s.command(id); expect(second.approvalId).not.toBe(first.approvalId);
  const historicalReview = await s.request("GET", `/api/executions/${id}?view=approval&approvalId=${encodeURIComponent(first.approvalId)}`, undefined, "reviewer");
  expect(historicalReview.statusCode, historicalReview.body).toBe(200);
  expect(historicalReview.json().data.runtimeApproval).toMatchObject({ id: first.approvalId, state: "CONSUMED", canDecide: false, arguments: { value: "first report" } });
  const pendingReviews = (await s.request("GET", "/api/execution-reviews?kind=approval", undefined, "reviewer")).json().data.items;
  expect(pendingReviews.map((item: { reviewId: string }) => item.reviewId)).toEqual([second.approvalId]);
  const priorReviews = (await s.request("GET", "/api/execution-reviews?kind=approval&state=closed", undefined, "reviewer")).json().data.items;
  expect(priorReviews.map((item: { reviewId: string }) => item.reviewId)).toEqual([first.approvalId]); expect(priorReviews[0].actionable).toBe(false);
  expect((await s.request("POST", `/api/executions/${id}/approve`, first, "reviewer")).statusCode).toBe(409);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect((await s.review(id)).arguments).toEqual({ value: "fixture-message" });
  await s.request("POST", `/api/executions/${id}/approve`, second, "reviewer"); await s.wait(id, "DONE");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const records = Object.values((await s.repository.snapshot()).executions[id]!.runtimeApprovalSecret!.records);
  expect(records).toHaveLength(2); expect(records.every(record => record.state === "CONSUMED")).toBe(true);
  expect(new Set(records.map(record => record.consumption!.intentId)).size).toBe(2);
  const firstPage = (await s.request("GET", "/api/execution-reviews?kind=approval&state=closed&limit=1", undefined, "reviewer")).json().data;
  const secondPage = (await s.request("GET", `/api/execution-reviews?kind=approval&state=closed&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, undefined, "reviewer")).json().data;
  expect(firstPage.items[0].executionId).toBe(secondPage.items[0].executionId); expect(firstPage.items[0].reviewId).not.toBe(secondPage.items[0].reviewId);
  expect(secondPage.hasMore).toBe(false); expect(secondPage.nextCursor).toBeNull(); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("stable operation admission rejects changed input and still deduplicates through credential rotation", async () => {
  const s = await setup(null, false), id = await s.admit();
  expect((await s.run(undefined, { changed: true })).statusCode).toBe(409);
  s.services.config.jwtSecret = "rotated-fixture-secret-at-least-32-characters";
  const replay = await s.run(); expect(replay.statusCode).toBe(202); expect(replay.json().data.id).toBe(id);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

async function uncertainOperation(storage: PersistenceBackend | null = null) {
  const system = await setup(storage), id = await system.admit();
  system.sdk.callTool.mockRejectedValueOnce(new Error("Synthetic effect response lost after possible acceptance"));
  const approved = await system.request("POST", `/api/executions/${id}/approve`, await system.command(id), "reviewer");
  expect(approved.statusCode, approved.body).toBe(200); await system.wait(id, "RECONCILIATION_REQUIRED");
  await system.repository.mutate(state => {
    state.roles.reconciler = { id: "reconciler", name: "Business recovery operator", description: "Minimum recovery only", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer!, id: "operator", name: "Operator", email: "operator@example.test", roleId: "reconciler" };
    state.users.outsider = { ...state.users.reviewer!, id: "outsider", name: "Other client", email: "other@example.test", roleId: "role_client" };
  });
  const caseView = async (user = "operator") => {
    const response = await system.request("GET", `/api/executions/${id}?view=reconciliation`, undefined, user);
    expect(response.statusCode, response.body).toBe(200); return response.json().data.operationReconciliation;
  };
  const evidenceCommand = async (outcome = "APPLIED") => {
    const view = await caseView(); return { intentId: view.intentId, baseVersion: view.version, factsHash: view.factsHash, decisionKey: "reconciliation-decision-0001", outcome,
      evidence: { kind: "erp-record", reference: "SANDBOX-ERP-RECORD-123", note: "Independently inspected the synthetic operation record. This is not a delivery guarantee.", observedAt: new Date().toISOString() } };
  };
  return { ...system, id, caseView, evidenceCommand };
}

test("review inbox discovers exact independent approval waits without arguments, full runs, mutation or SDK calls", async () => {
  const s = await setup(), id = await s.admit(), before = await s.repository.snapshot(), calls = s.sdk.callTool.mock.calls.length;
  const response = await s.request("GET", "/api/execution-reviews", undefined, "reviewer"); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ profile: "execution-review-inbox/v1", kind: "all", state: "open", scopes: { approval: true, reconciliation: false },
    hasMore: false, nextCursor: null, canResume: false, noReplay: true, items: [{ executionId: id, kind: "approval", state: "open", statusLabel: "Awaiting decision", actionable: true }] });
  expect(response.body).not.toContain("FIXTURE REPORT");
  expect(response.body).not.toMatch(/"(?:arguments|decisionKey|reviewHash|connectionBinding|stepOutputs|runtimeApprovalSecret|operationSecret)":/);
  expect((await s.request("GET", "/api/execution-reviews")).json().data.items).toEqual([]);
  expect((await s.request("GET", `/api/executions/${id}`, undefined, "reviewer")).statusCode).toBe(404);
  expect(s.sdk.callTool.mock.calls).toHaveLength(calls); expect(await s.repository.snapshot()).toEqual(before);
  const noAuth = await s.app.inject({ method: "GET", url: "/api/execution-reviews" }); expect(noAuth.statusCode).toBe(401);
});

test("review inbox keyset pages remain actor/filter/authority bound and cannot forge a task or command", async () => {
  const s = await setup(); await s.admit();
  for (const key of ["inbox-operation-run-0002", "inbox-operation-run-0003"]) { const response = await s.run(key); await s.wait(response.json().data.id, "AWAITING_APPROVAL"); }
  const list = async (query: string, actor = "reviewer") => s.request("GET", `/api/execution-reviews?${query}`, undefined, actor);
  const first = (await list("limit=1&kind=approval")).json().data; expect(first.items).toHaveLength(1); expect(first.hasMore).toBe(true);
  const cursor = encodeURIComponent(first.nextCursor), second = (await list(`limit=1&kind=approval&cursor=${cursor}`)).json().data;
  const third = (await list(`limit=1&kind=approval&cursor=${encodeURIComponent(second.nextCursor)}`)).json().data;
  expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.executionId)).size).toBe(3); expect(third.nextCursor).toBeNull();
  expect((await list(`kind=reconciliation&cursor=${cursor}`)).statusCode).toBe(400);
  expect((await list(`kind=approval&state=closed&cursor=${cursor}`)).statusCode).toBe(400);
  expect((await list(`kind=approval&cursor=${cursor}`, "requester")).statusCode).toBe(400);
  expect((await list(`kind=approval&cursor=${encodeURIComponent(first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith("a") ? "b" : "a"))}`)).statusCode).toBe(400);
  await s.repository.mutate(state => { state.roles.review!.permissions.push("execution:reconcile"); });
  expect((await list(`kind=approval&cursor=${cursor}`)).statusCode).toBe(400);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(3);
});

test.each(["limit=0", "limit=51", "limit=1.5", "kind=write", "state=all", "cursor=forged", "view=approval", "actorId=requester", "kind=approval&kind=reconciliation"])("review inbox rejects unsupported query %s", async query => {
  const s = await setup(); expect((await s.request("GET", `/api/execution-reviews?${query}`, undefined, "reviewer")).statusCode).toBe(400); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("current policy scope, active roles and revocation filter discovery without accepting a requester as its own reviewer", async () => {
  const s = await setup(); await s.admit();
  await s.repository.mutate(state => {
    state.roles.other_review = { ...state.roles.review!, id: "other_review" };
    state.users.other_review = { ...state.users.reviewer!, id: "other_review", roleId: "other_review" };
    state.users.ordinary = { ...state.users.reviewer!, id: "ordinary", roleId: "role_builder" };
  });
  expect((await s.request("GET", "/api/execution-reviews", undefined, "other_review")).json().data).toMatchObject({ scopes: { approval: false }, items: [] });
  expect((await s.request("GET", "/api/execution-reviews", undefined, "ordinary")).statusCode).toBe(403);
  await s.repository.mutate(state => { state.users.requester!.roleId = "review"; });
  expect((await s.request("GET", "/api/execution-reviews", undefined, "requester")).json().data.items).toEqual([]);
  await s.repository.mutate(state => { state.roles.review!.permissions = []; });
  expect((await s.request("GET", "/api/execution-reviews", undefined, "reviewer")).statusCode).toBe(403);
});

test("tampered exact waits remain visible as unavailable tasks and the inbox never repairs or approves them", async () => {
  const s = await setup(), id = await s.admit();
  await s.repository.mutate(state => { const run = state.executions[id]!; run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!.arguments = { value: "tampered" }; });
  const response = await s.request("GET", "/api/execution-reviews", undefined, "reviewer"); expect(response.statusCode).toBe(200);
  expect(response.json().data.items).toMatchObject([{ executionId: id, reviewAvailable: false, actionable: false, statusLabel: "Review unavailable" }]);
  expect(response.body).not.toContain("tampered"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("inbox denies an uncertain durable authorization image and reload observes the remotely committed revocation", async () => {
  const storage = new Records(), s = await setup(storage); await s.admit();
  storage.loseWhen = state => state.roles.review!.permissions.length === 0;
  await expect(s.repository.mutate(state => { state.roles.review!.permissions = []; })).rejects.toThrow(/acknowledgement loss/);
  const uncertain = await s.request("GET", "/api/execution-reviews", undefined, "reviewer");
  expect(uncertain.statusCode).toBe(503); expect(uncertain.body).not.toContain("Awaiting decision");
  await s.repository.recoverPersistenceState();
  expect((await s.request("GET", "/api/execution-reviews", undefined, "reviewer")).statusCode).toBe(403);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("decision history and independent recovery inbox distinguish approval, unknown effect and operator closure", async () => {
  const s = await uncertainOperation(), calls = s.sdk.callTool.mock.calls.length;
  expect((await s.request("GET", "/api/execution-reviews?kind=approval", undefined, "reviewer")).json().data.items).toEqual([]);
  const history = (await s.request("GET", "/api/execution-reviews?state=closed", undefined, "reviewer")).json().data;
  expect(history.items).toMatchObject([{ executionId: s.id, kind: "approval", actionable: false, statusLabel: "Approved — not delivery confirmation" }]);
  const open = (await s.request("GET", "/api/execution-reviews", undefined, "operator")).json().data;
  expect(open).toMatchObject({ scopes: { approval: false, reconciliation: true }, items: [{ executionId: s.id, kind: "reconciliation", statusLabel: "Outcome uncertain", actionable: true }] });
  expect(JSON.stringify(open)).not.toContain("FIXTURE REPORT");
  expect(JSON.stringify(open)).not.toMatch(/"(?:arguments|operationKey|factsHash|evidence)":/);
  expect((await s.request("GET", "/api/execution-reviews", undefined, "outsider")).statusCode).toBe(403);
  await s.request("POST", `/api/executions/${s.id}/reconcile`, await s.evidenceCommand("NOT_APPLIED"), "operator");
  expect((await s.request("GET", "/api/execution-reviews", undefined, "operator")).json().data.items).toEqual([]);
  expect((await s.request("GET", "/api/execution-reviews?state=closed", undefined, "operator")).json().data.items).toMatchObject([
    { executionId: s.id, kind: "reconciliation", actionable: false, statusLabel: "Closed by operator evidence", canResume: false, noReplay: true }]);
  expect(s.sdk.callTool.mock.calls).toHaveLength(calls);
});

test.each(["APPLIED", "NOT_APPLIED"])("normal independent %s external evidence closes a case without granting SDK/result/resume authority", async outcome => {
  const s = await uncertainOperation(), command = await s.evidenceCommand(outcome), before = await s.repository.snapshot();
  const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ intentId: command.intentId, outcome, state: "RESOLVED", version: 2, basis: "operator-attestation", toolWasCalled: false, canResume: false, noReplay: true, replayed: false });
  const after = await s.repository.snapshot(), execution = after.executions[s.id]!;
  expect(execution.status).toBe("RECONCILED"); expect(execution.operationSecret!.state).toBe("FINISHED"); expect(execution.operationSecret!.lease).toBeUndefined();
  expect(execution.operationSecret!.intents.send!.state).toBe("UNKNOWN"); expect(execution.readProgress).toEqual({ ...before.executions[s.id]!.readProgress!, lastSequence: before.executions[s.id]!.readProgress!.lastSequence + 1 });
  expect(execution.stepOutputs).toEqual(before.executions[s.id]!.stepOutputs); expect(execution.stepOutputs).not.toHaveProperty("send"); expect(execution.finalOutput).toBeUndefined();
  expect(after.timelines[s.id]!.find(item => item.nodeId === "send")).toMatchObject({ status: "UNKNOWN", outcome: "UNKNOWN", reconciliation: { outcome, basis: "operator-attestation", evidence: command.evidence } });
  expect((await s.caseView())).toMatchObject({ state: "RESOLVED", canRecord: false, canResume: false, noReplay: true, version: 2 });
  const replay = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.replayed).toBe(true);
  expect((await s.repository.snapshot()).executionEvents[s.id]).toEqual(after.executionEvents[s.id]); expect((await s.repository.snapshot()).auditLogs).toEqual(after.auditLogs);
  expect((await s.request("POST", `/api/executions/${s.id}/retry`, {})).statusCode).toBe(409);
  expect((await s.run()).json().data.id).toBe(s.id); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const publicRun = (await s.request("GET", `/api/executions/${s.id}`)).json().data;
  expect(publicRun).not.toHaveProperty("operationSecret"); expect(publicRun).not.toHaveProperty("runtimeApprovalSecret");
});

test("unresolved observations append exact versioned evidence, then a fresh definitive decision closes without a call", async () => {
  const s = await uncertainOperation(), first = await s.evidenceCommand("UNRESOLVED");
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, first, "operator")).statusCode).toBe(200);
  const view = await s.caseView(); expect(view).toMatchObject({ version: 2, state: "OPEN", canRecord: true }); expect(view.factsHash).not.toBe(first.factsHash);
  expect((await s.repository.snapshot()).executions[s.id]!.status).toBe("RECONCILIATION_REQUIRED");
  const stale = { ...first, decisionKey: "reconciliation-stale-command", outcome: "APPLIED" };
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, stale, "operator")).statusCode).toBe(409);
  const second = { ...await s.evidenceCommand("NOT_APPLIED"), decisionKey: "reconciliation-second-command" };
  const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, second, "operator"); expect(response.statusCode, response.body).toBe(200);
  expect((await s.caseView()).history.map((record: { outcome: string }) => record.outcome)).toEqual(["UNRESOLVED", "NOT_APPLIED"]);
  const previousReplay = await s.request("POST", `/api/executions/${s.id}/reconcile`, first, "operator"); expect(previousReplay.statusCode).toBe(200); expect(previousReplay.json().data).toMatchObject({ state: "OPEN", version: 2, replayed: true });
  expect((await s.repository.snapshot()).executions[s.id]!.status).toBe("RECONCILED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("reconciliation-only roles get minimum exact evidence, not full executions/logs/approval or unrelated clients' data", async () => {
  const s = await uncertainOperation(), view = await s.caseView();
  expect(view).toMatchObject({ arguments: { value: "FIXTURE REPORT" }, toolName: s.write.name, canRecord: true });
  for (const key of ["decisionKey", "keyHash", "fingerprint", "connectionBinding", "operationSecret", "stepOutputs"]) expect(view).not.toHaveProperty(key);
  expect((await s.request("GET", `/api/executions/${s.id}`, undefined, "operator")).statusCode).toBe(404);
  expect((await s.request("GET", `/api/executions/${s.id}/logs`, undefined, "operator")).statusCode).toBe(403);
  expect((await s.request("GET", `/api/executions/${s.id}?view=approval`, undefined, "operator")).statusCode).toBe(403);
  expect((await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "outsider")).statusCode).toBe(404);
  expect((await s.request("GET", `/api/executions/${s.id}?view=reconciliation`, undefined, "reviewer")).statusCode).toBe(404);
  expect((await s.caseView("requester")).canRecord).toBe(false);
  const command = await s.evidenceCommand();
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "requester")).statusCode).toBe(403);
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "reviewer")).statusCode).toBe(403);
  expect((await s.request("GET", `/api/executions/${s.id}?view=reconciliation&extra=1`, undefined, "operator")).statusCode).toBe(400);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each(["review", "reconciler"])("the original requester downgraded to %s-only authority loses full run access even though ownership is unchanged", async roleId => {
  const s = await uncertainOperation();
  await s.repository.mutate(state => { state.users.requester!.roleId = roleId; });
  expect((await s.request("GET", `/api/executions/${s.id}`)).statusCode).toBe(404);
  expect((await s.request("GET", `/api/executions/${s.id}/logs`)).statusCode).toBe(403);
  if (roleId === "reconciler") expect((await s.caseView("requester")).canRecord).toBe(false);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each(["role", "disabled", "permission", "owner"])("%s change after review cannot authorize a recovery decision", async scenario => {
  const s = await uncertainOperation(), command = await s.evidenceCommand();
  await s.repository.mutate(state => {
    if (scenario === "role") state.users.operator!.roleId = "review";
    if (scenario === "disabled") state.users.operator!.status = "Disabled";
    if (scenario === "permission") state.roles.reconciler!.permissions = [];
    if (scenario === "owner") state.executions[s.id]!.startedBy.id = "operator";
  });
  const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect([401, 403]).toContain(response.statusCode);
  expect((await s.repository.snapshot()).executions[s.id]!.operationSecret!.reconciliations).toBeUndefined(); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each(["arguments", "publication", "intent", "lease", "epoch"])("changed historical %s evidence fences reconciliation instead of trusting browser fields", async scenario => {
  const s = await uncertainOperation(), command = await s.evidenceCommand();
  await s.repository.mutate(state => {
    const execution = state.executions[s.id]!;
    if (scenario === "arguments") execution.stepOutputs!.lookup = { structuredContent: { value: "changed report" } };
    if (scenario === "publication") state.versions.flow![0]!.yaml += "# changed immutable content";
    if (scenario === "intent") execution.operationSecret!.intents.send!.argumentHash = `sha256:${"c".repeat(64)}`;
    if (scenario === "lease") execution.operationSecret!.lease = { id: "unexpected-owner", workerId: "stale-worker", expiresAt: Date.now() + 10000 };
    if (scenario === "epoch") execution.readProgress!.epoch = 1;
  });
  const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(response.statusCode, response.body).toBe(409);
  expect((await s.repository.snapshot()).executions[s.id]!.operationSecret!.reconciliations).toBeUndefined(); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("malformed/future/pre-intent evidence and changed idempotent payload cannot manufacture a successful tool result", async () => {
  const s = await uncertainOperation(), command = await s.evidenceCommand();
  for (const bad of [{ ...command, output: { accepted: true } }, { ...command, evidence: { ...command.evidence, reference: "" } },
    { ...command, evidence: { ...command.evidence, observedAt: "2020-01-01T00:00:00.000Z" } }, { ...command, evidence: { ...command.evidence, observedAt: new Date(Date.now() + 60000).toISOString() } }])
    expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, bad, "operator")).statusCode).toBe(422);
  const ok = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(ok.statusCode, ok.body).toBe(200);
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, { ...command, outcome: "NOT_APPLIED" }, "operator")).statusCode).toBe(409);
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, { ...command, decisionKey: "closed-case-new-command-01" }, "operator")).statusCode).toBe(409);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("external historical recovery does not require expired dispatch authority or an active connector", async () => {
  const s = await uncertainOperation(), command = await s.evidenceCommand();
  await s.repository.mutate(state => { state.settings.rbac = {}; state.users.reviewer!.status = "Disabled"; const run = state.executions[s.id]!;
    state.capabilityAdmissions[run.runtimeApprovalSecret!.records[run.runtimeApprovalSecret!.activeId]!.binding.capabilityId]!.state = "DISABLED"; });
  await s.session.close();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 301000);
  const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(response.statusCode, response.body).toBe(200);
  expect((await s.caseView()).state).toBe("RESOLVED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("normalized private recovery records reopen exactly and do not auto-grant the new permission to stored roles", async () => {
  const storage = new Records(), s = await uncertainOperation(storage), command = await s.evidenceCommand();
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator")).statusCode).toBe(200);
  const snapshot = await s.repository.snapshot(), cells = splitFirestoreState(snapshot);
  expect(cells.filter(item => item.path[0] === "operation-reconciliations")).toHaveLength(1); expect(assembleFirestoreState(cells)).toEqual(snapshot);
  expect(cells.find(item => item.path[0] === "executions" && item.path[1] === s.id)!.value).toMatchObject({ operationSecret: { reconciliations: {} } });
  const reopened = await Repository.open(storage); expect((await reopened.snapshot()).executions[s.id]!.operationSecret).toEqual(snapshot.executions[s.id]!.operationSecret);
  const legacy = structuredClone(snapshot); legacy.permissions = legacy.permissions.filter(item => item.key !== "execution:reconcile"); legacy.roles.role_admin!.permissions = legacy.roles.role_admin!.permissions.filter(key => key !== "execution:reconcile");
  const restored = restoreState(Buffer.from(JSON.stringify(legacy)));
  expect(restored.permissions.some(item => item.key === "execution:reconcile")).toBe(true); expect(restored.roles.role_admin!.permissions).not.toContain("execution:reconcile");
});

test("post-commit recovery decision ACK loss reloads one record and replay never dispatches or appends another decision", async () => {
  const storage = new Records(), s = await uncertainOperation(storage), command = await s.evidenceCommand();
  storage.loseWhen = state => state.executions[s.id]?.status === "RECONCILED";
  const response = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator"); expect(response.statusCode).toBe(503);
  expect(JSON.parse(storage.bytes!.toString()).executions[s.id].status).toBe("RECONCILED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  await s.repository.recoverPersistenceState();
  const authoritative = await s.repository.snapshot(), replay = await s.request("POST", `/api/executions/${s.id}/reconcile`, command, "operator");
  expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.replayed).toBe(true);
  expect((await s.repository.snapshot()).executionEvents[s.id]).toEqual(authoritative.executionEvents[s.id]); expect(Object.keys(authoritative.executions[s.id]!.operationSecret!.reconciliations!)).toHaveLength(1);
  await s.app.close(); const repository = await Repository.open(storage), queue = operationJobQueue({ ...s.services, repository });
  await queue.start(); expect((await repository.snapshot()).executions[s.id]!.status).toBe("RECONCILED"); await queue.stop(); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("altered saved attestation or corrupt event cursor cannot be repaired by another decision", async () => {
  const s = await uncertainOperation(), first = await s.evidenceCommand("UNRESOLVED");
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, first, "operator")).statusCode).toBe(200);
  const second = { ...await s.evidenceCommand(), decisionKey: "reconciliation-next-key-0001" };
  await s.repository.mutate(state => { const record = Object.values(state.executions[s.id]!.operationSecret!.reconciliations!)[0]!;
    if (record.basis !== "operator-attestation") throw new Error("Expected operator evidence"); record.evidence.note = "Altered after record"; });
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, second, "operator")).statusCode).toBe(409);
  const other = await uncertainOperation(), command = await other.evidenceCommand();
  await other.repository.mutate(state => { state.executions[other.id]!.readProgress!.lastSequence += 10; });
  expect((await other.request("POST", `/api/executions/${other.id}/reconcile`, command, "operator")).statusCode).toBe(503);
  expect((await other.repository.snapshot()).executions[other.id]!.operationSecret!.reconciliations).toBeUndefined();
});
