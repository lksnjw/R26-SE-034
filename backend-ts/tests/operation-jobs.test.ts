import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { Repository, type PersistenceBackend, type RepositoryState } from "../src/repository/store.js";
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
  expect((await s.request("POST", `/api/executions/${id}/approve`, first, "reviewer")).statusCode).toBe(409);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect((await s.review(id)).arguments).toEqual({ value: "fixture-message" });
  await s.request("POST", `/api/executions/${id}/approve`, second, "reviewer"); await s.wait(id, "DONE");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const records = Object.values((await s.repository.snapshot()).executions[id]!.runtimeApprovalSecret!.records);
  expect(records).toHaveLength(2); expect(records.every(record => record.state === "CONSUMED")).toBe(true);
  expect(new Set(records.map(record => record.consumption!.intentId)).size).toBe(2);
});

test("stable operation admission rejects changed input and still deduplicates through credential rotation", async () => {
  const s = await setup(null, false), id = await s.admit();
  expect((await s.run(undefined, { changed: true })).statusCode).toBe(409);
  s.services.config.jwtSecret = "rotated-fixture-secret-at-least-32-characters";
  const replay = await s.run(); expect(replay.statusCode).toBe(202); expect(replay.json().data.id).toBe(id);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});
