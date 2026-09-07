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
async function setup(storage: PersistenceBackend | null = null, withRead = true) {
  const repository = await Repository.open(storage), registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const base = registries.snapshot(), original = base.tools[0]!;
  const read = toolSchema.parse({ ...original, allowed_roles: ["Platform Admin"], bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } });
  const write = toolSchema.parse({ ...read, tool_id: "operation-fixture", name: "demo.dispatch", mcp_tool_name: "demo.dispatch", is_read_only: false, risk_level: "low", side_effects: ["Synthetic message acceptance"],
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
    bridge_contract: { ...read.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" }, id: { type: "string" } }, required: ["accepted", "id"], additionalProperties: false } } });
  const tools = [read, write];
  vi.spyOn(registries, "snapshot").mockImplementation(() => ({ ...base, tools }));
  vi.spyOn(registries, "findTool").mockImplementation(name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name)));
  vi.spyOn(registries, "hash").mockImplementation(() => capabilityContractHash(toolSchema.parse({ ...write, execution_notes: capabilityContractHash(read) })));
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "operation-fixture-secret-at-least-32-characters", MCP_MODE: "mock", STORAGE_DRIVER: "memory", STORAGE_ENCRYPTION_KEY: "x".repeat(32) });
  const validator = new RegistryValidator(registries, repository);
  let dispatchAdmissionHook: (() => Promise<void>) | undefined;
  const authorize = admissionAuthorizer(repository, registries);
  const sdk = { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract!.output_schema!,
    _meta: { "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } }))),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>, _meta?: Record<string, unknown>): Promise<unknown> => name === exactBridgeName(read) ? { content: [], structuredContent: { value: String(args.value).toUpperCase() } } : { content: [], structuredContent: { accepted: true, id: "fixture-message" } }) };
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "synthetic-only", timeoutMs: 1000, validator, sdkClient: sdk,
    admissionAuthorizer: async (...args) => { await authorize(...args); if (!args[0].is_read_only) await dispatchAdmissionHook?.(); } }); closers.push(session);
  await repository.mutate(state => {
    const now = new Date().toISOString();
    state.roles.review = { id: "review", name: "Independent approver", description: "Review only", permissions: ["execution:approve"], createdAt: now };
    for (const id of ["requester", "reviewer"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: id === "requester" ? "role_admin" : "review", permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: now };
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
    decisionKey: `fixture-review-${observation.toolId}`, effectClass: observation.toolId === write.tool_id ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit synthetic contract review",
    ...(observation.toolId === write.tool_id ? { requireIndependentApproval: true } : {}) } });
  const services = { repository, registries, config, validator, erpbridgeSession: session, executor: new Executor(new ToolRegistry(), validator) };
  const app = await buildApp(services); closers.push(app);
  const request = (method: "GET" | "POST", url: string, payload?: object, userId = "requester") => app.inject({ method, url, headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: 3600 })}` }, ...(payload ? { payload } : {}) });
  const publish = () => request("POST", "/api/workflows/flow/publish", {});
  const run = (key = "fixture-operation-run-0001", input: Record<string, unknown> = {}) => request("POST", "/api/workflows/flow/run", { mode: "async-operation", idempotencyKey: key, input });
  const review = async (id: string) => { const response = await request("GET", `/api/executions/${id}?view=approval`, undefined, "reviewer"); expect(response.statusCode, response.body).toBe(200); return response.json().data.runtimeApproval; };
  const command = async (id: string) => { const value = await review(id); return { approvalId: value.id, baseVersion: value.version, reviewHash: value.reviewHash, decisionKey: "fixture-decision-0001" }; };
  const wait = async (id: string, status: string) => {
    await vi.waitFor(async () => { expect([status, "FAILED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "CANCELLED"]).toContain((await repository.snapshot()).executions[id]?.status); }, { timeout: 4000 });
    const run = (await repository.snapshot()).executions[id]!; expect(run.status, JSON.stringify({ failure: run.failure, progress: run.readProgress, summary: run.agentSummary, sdkCalls: sdk.callTool.mock.calls })).toBe(status);
  };
  const admit = async () => { const pub = await publish(); expect(pub.statusCode, pub.body).toBe(200); const response = await run(); expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id; await wait(id, "AWAITING_APPROVAL"); return id as string; };
  return { repository, services, app, actor, read, write, sdk, session, request, publish, run, review, command, wait, admit,
    setDispatchAdmissionHook: (hook: () => Promise<void>) => { dispatchAdmissionHook = hook; } };
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
  await s.repository.mutate(state => { Object.values(state.executions[s.id]!.operationSecret!.reconciliations!)[0]!.evidence.note = "Altered after record"; });
  expect((await s.request("POST", `/api/executions/${s.id}/reconcile`, second, "operator")).statusCode).toBe(409);
  const other = await uncertainOperation(), command = await other.evidenceCommand();
  await other.repository.mutate(state => { state.executions[other.id]!.readProgress!.lastSequence += 10; });
  expect((await other.request("POST", `/api/executions/${other.id}/reconcile`, command, "operator")).statusCode).toBe(503);
  expect((await other.repository.snapshot()).executions[other.id]!.operationSecret!.reconciliations).toBeUndefined();
});
