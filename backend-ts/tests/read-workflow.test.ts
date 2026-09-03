import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository, type PersistenceBackend, type RepositoryState } from "../src/repository/store.js";
import { ReadCheckpoints, reconcileInterruptedExecutions } from "../src/runner/read-checkpoints.js";
import { readJobQueue } from "../src/runner/read-jobs.js";
import type { ApplicationServices } from "../src/http/app.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema, ruleSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { inspectReadWorkflow } from "../src/runner/read-workflow.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";
import type { Workflow } from "../src/models/schemas.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const yaml = stringify({ name: "Daily read", description: "Read invoice details", trigger: { type: "manual" }, steps: [
  { id: "lookup", action: "finance.read", parameters: { id: "{{input.invoiceId}}" } },
  { id: "details", action: "invoice-read", parameters: { id: "{{lookup.structuredContent.id}}" } },
] });

async function setup(options: { noBridge?: boolean; roleId?: string; provider?: boolean; write?: boolean; persistence?: PersistenceBackend; mcpTimeoutMs?: number } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "read-workflow-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }),
    storageEncryptionKey: "x".repeat(32), erpbridgeRoleMap: { "Platform Admin": "admin", Client: "client" } };
  const repository = await Repository.open(options.persistence ?? null);
  const tool = toolSchema.parse({ tool_id: "READ-1", name: "finance.read", mcp_tool_name: "invoice-read", allowed_roles: ["Platform Admin", "Client"],
    is_read_only: !options.write, input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
  let hash = "sha256:registry-v1";
  const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => hash,
    findTool: (name: string) => [tool.name, tool.mcp_tool_name].includes(name) ? tool : undefined, findRule: () => undefined, enabledRules: () => [] } as unknown as RegistryService;
  const validator = new RegistryValidator(registries, repository);
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<unknown> => ({ content: [], structuredContent: { id: "invoice-actual" } }));
  const listTools = vi.fn(async () => [{ name: tool.mcp_tool_name, inputSchema: tool.input_schema }]);
  const erpbridgeSession = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture-only", timeoutMs: options.mcpTimeoutMs ?? 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools, callTool } });
  const queryWithTools = vi.fn(async () => { throw new Error("Published reads must never invoke the model"); });
  const services: ApplicationServices = { config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator),
    ...(options.noBridge ? {} : { erpbridgeSession }), ...(options.provider ? { providerRuntime: { configured: true, queryWithTools } as unknown as ProviderRuntime } : {}) };
  await repository.mutate((state) => {
    state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: options.roleId ?? "role_admin", permissionOverrides: [], status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
  });
  const app = await buildApp(services);
  apps.push(app);
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "actor", expiresIn: 3600 })}` };
  async function seed(source = yaml, published = true) {
    const now = new Date().toISOString();
    const workflow: Workflow = { id: "read", name: "Daily read", description: "Read", owner: { id: options.roleId === "role_client" ? "other" : "actor", name: "Owner" }, assignedUserIds: ["actor"], status: "PENDING", trigger: { type: "manual" },
      steps: 2, successRate: 0, lastRunAt: null, publishedVersion: published ? 1 : 0, draftVersion: 1, tags: [], domainTags: [], canRun: published, createdAt: now, updatedAt: now, yaml: source, archived: false };
    await repository.mutate((state) => { state.workflows.read = workflow; state.versions.read = published ? [{ version: 1, artifactState: "PUBLISHED", yaml: source }] : []; });
  }
  const run = (payload: Record<string, unknown> = { input: { invoiceId: "invoice-requested" } }) => app.inject({ method: "POST", url: "/api/workflows/read/run", headers, payload });
  return { app, services, repository, tool, validator, listTools, callTool, queryWithTools, headers, seed, run, drift: () => { hash = "sha256:registry-v2"; } };
}

test.each([false, true])("published two-node read executes exact bindings with provider configured=%s", async (provider) => {
  const s = await setup({ provider }); await s.seed();
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(200);
  const execution = response.json().data;
  expect(execution).toMatchObject({ status: "DONE", tokens: { input: 0, output: 0, total: 0 }, costUsd: 0,
    workflowSnapshot: { version: 1, yaml, registryHash: "sha256:registry-v1", executionProfile: "sequential-read-v1" } });
  expect(s.callTool.mock.calls).toEqual([["invoice-read", { id: "invoice-requested", role: "admin" }], ["invoice-read", { id: "invoice-actual", role: "admin" }]]);
  const state = await s.repository.snapshot();
  expect(state.timelines[execution.id]?.map((step) => [step.nodeId, step.status])).toEqual([["lookup", "DONE"], ["details", "DONE"]]);
  for (const step of state.timelines[execution.id]!) {
    expect(Date.parse(String(step.completedAt))).toBeGreaterThanOrEqual(Date.parse(String(step.startedAt)));
    expect(step.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(s.listTools).toHaveBeenCalledTimes(1);
  expect(s.queryWithTools).not.toHaveBeenCalled();
});

const conditionalYAML = (predicate: unknown = { kind: "ref", source: "workflowInput", path: ["enabled"] }) => stringify({ name: "Branch report", description: "Read exactly one branch", trigger: { type: "manual" }, steps: ["yes", "no", "after"].map(id => ({ id, action: "finance.read", parameters: { id } })), metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "yes" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "no" }] } }, { kind: "action", nodeId: "after" }] } } } });

test.each([true, false])("conditional read chooses exactly one path with enabled=%s, preserves source indexes and records the other path as skipped", async enabled => {
  const s = await setup({ provider: true }); await s.seed(conditionalYAML());
  const response = await s.run({ input: { enabled } }); expect(response.statusCode, response.body).toBe(200);
  const execution = response.json().data, state = await s.repository.snapshot();
  expect(execution).toMatchObject({ status: "DONE", workflowSnapshot: { executionProfile: "conditional-read-v1", compilation: { schemaVersion: "workflow-read-ir/v2" } }, readProgress: { nextStepIndex: 3, decisions: { gate: { status: "DONE", selected: enabled ? "then" : "else" } } } });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual([enabled ? "yes" : "no", "after"]);
  expect(Object.keys(execution.stepOutputs)).toEqual([enabled ? "yes" : "no", "after"]);
  const skipped = enabled ? "no" : "yes";
  expect(execution.readProgress.attempts[skipped]).toMatchObject({ status: "SKIPPED", stepIndex: enabled ? 1 : 0 });
  expect(execution.readProgress.attempts[skipped].dispatchIntentAt).toBeUndefined();
  expect(state.timelines[execution.id]!.find(entry => entry.nodeId === "gate")).toMatchObject({ outcome: "CONDITION_SELECTED", output: { selectedBranch: enabled ? "If yes" : "If no" } });
  expect(state.executionEvents[execution.id]!.findIndex(event => event.type === "condition.selected")).toBeLessThan(state.executionEvents[execution.id]!.findIndex(event => event.type === "node.dispatch_intent"));
  expect(s.queryWithTools).not.toHaveBeenCalled();
});

test.each([[true, true], [true, false], [false, true]])("nested conditions with outer=%s inner=%s evaluate only the selected scope", async (outer, inner) => {
  const s = await setup();
  const action = (nodeId: string) => ({ kind: "action", nodeId });
  const block = (...nodes: unknown[]) => ({ kind: "sequence", nodes });
  await s.seed(stringify({ name: "Nested read", description: "Select one nested path", trigger: { type: "manual" },
    steps: ["first", "yes", "no", "outside", "after"].map(id => ({ id, action: "finance.read", parameters: { id } })),
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: block({ kind: "if", id: "outerGate", predicate: { kind: "ref", source: "workflowInput", path: ["outer"] },
      then: block(action("first"), { kind: "if", id: "innerGate", predicate: { kind: "ref", source: "workflowInput", path: ["inner"] }, then: block(action("yes")), else: block(action("no")) }),
      else: block(action("outside")) }, action("after")) } } }));
  const response = await s.run({ input: { outer, inner } }); expect(response.statusCode, response.body).toBe(200);
  const item = response.json().data;
  expect(item.status).toBe("DONE"); expect(item.readProgress.nextStepIndex).toBe(5);
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(outer ? ["first", inner ? "yes" : "no", "after"] : ["outside", "after"]);
  expect(Object.keys(item.readProgress.decisions)).toEqual(outer ? ["outerGate", "innerGate"] : ["outerGate"]);
  for (const id of ["first", "yes", "no", "outside", "after"]) {
    const called = s.callTool.mock.calls.some(call => call[1].id === id);
    expect(item.readProgress.attempts[id].status).toBe(called ? "DONE" : "SKIPPED");
    if (!called) { expect(item.readProgress.attempts[id].dispatchIntentAt).toBeUndefined(); expect(item.stepOutputs[id]).toBeUndefined(); }
  }
});

test("condition and skipped action IDs can match inherited object members without false replay detection", async () => {
  const s = await setup(), blueprint = parseWorkflowYAMLStrict(conditionalYAML());
  blueprint.steps[0]!.id = "valueOf";
  const flow = blueprint.metadata!.controlFlow as { root: { nodes: Array<{ id?: string; then?: { nodes: Array<{ nodeId: string }> } }> } };
  flow.root.nodes[0]!.id = "toString"; flow.root.nodes[0]!.then!.nodes[0]!.nodeId = "valueOf";
  await s.seed(stringify(blueprint)); const response = await s.run({ input: { enabled: false } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.readProgress).toMatchObject({ decisions: { toString: { status: "DONE", selected: "else" } }, attempts: { valueOf: { status: "SKIPPED" } } });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["no", "after"]);
});

test.each([undefined, null, "true", 1, {}, []])("condition input %j fails without truthiness coercion or a branch SDK call", async enabled => {
  const s = await setup(); await s.seed(conditionalYAML());
  const response = await s.run({ input: enabled === undefined ? {} : { enabled } }); expect(response.statusCode, response.body).toBe(422);
  const execution = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(execution).toMatchObject({ status: "FAILED", failure: { failedStepId: "gate" }, readProgress: { decisions: { gate: { status: "FAILED" } }, nextStepIndex: 0 } });
  expect(execution.stepOutputs).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
});

test("condition checkpoint lost acknowledgement stops all branch work and never replays the decision or reads", async () => {
  const s = await setup(); await s.seed(conditionalYAML());
  const original = s.repository.mutate.bind(s.repository);
  vi.spyOn(s.repository, "mutate").mockImplementation(async mutation => {
    let decisionWritten = false;
    const result = await original(state => { const before = Object.values(state.executions).some(item => item.readProgress?.decisions?.gate); const value = mutation(state); decisionWritten = !before && Object.values(state.executions).some(item => item.readProgress?.decisions?.gate); return value; });
    if (decisionWritten) throw new Error("Lost decision acknowledgement"); return result;
  });
  const response = await s.run({ input: { enabled: true } }); expect(response.statusCode).toBe(503);
  expect(s.callTool).not.toHaveBeenCalled();
  expect(Object.values((await s.repository.snapshot()).executions)[0]!.status).toBe("RECOVERY_REQUIRED");
});

test("conditional read cancellation after decision stops before any branch dispatch", async () => {
  const s = await setup(); await s.seed(conditionalYAML());
  const original = s.repository.mutate.bind(s.repository);
  vi.spyOn(s.repository, "mutate").mockImplementation(mutation => original(state => { const value = mutation(state); const item = Object.values(state.executions).find(item => item.readProgress?.decisions?.gate); if (item?.readProgress && item.status === "RUNNING") item.readProgress.cancellation = { requestedAt: new Date().toISOString(), requestedBy: item.startedBy }; return value; }));
  const response = await s.run({ input: { enabled: true } }); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.status).toBe("CANCELLED"); expect(s.callTool).not.toHaveBeenCalled();
});

test("a skipped prerequisite cannot satisfy process order merely because it is earlier in the source catalog", async () => {
  const s = await setup();
  const rule = ruleSchema.parse({ rule_id: "CONFIRMED-PATH-ORDER", rule_type: "process_order", enabled: true, enforcement_action: "block", condition: { value: ["finance.read", "invoice-read"] } });
  vi.spyOn(s.services.registries, "enabledRules").mockReturnValue([rule]);
  const blueprint = parseWorkflowYAMLStrict(conditionalYAML()); blueprint.steps[1]!.action = "invoice-read"; blueprint.steps[2]!.action = "invoice-read";
  const source = stringify(blueprint); expect(s.validator.validatePlan("Original declarations", source, "Platform Admin").passed).toBe(true);
  await s.seed(source); const response = await s.run({ input: { enabled: false } }); expect(response.statusCode, response.body).toBe(422);
  expect(s.callTool).not.toHaveBeenCalled();
  const execution = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(execution).toMatchObject({ status: "FAILED", readProgress: { attempts: { yes: { status: "SKIPPED" }, no: { status: "FAILED" } } } });
});

test("queued conditional execution preserves the same selected-path checkpoints without invoking a model", async () => {
  const s = await setup({ provider: true }); await s.seed(conditionalYAML());
  const response = await s.run({ input: { enabled: false }, mode: "async-read", idempotencyKey: "conditional_job_request_0001" }); expect(response.statusCode, response.body).toBe(202);
  const id = response.json().data.id;
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("DONE"));
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["no", "after"]); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("lost branch-skip acknowledgement retains its receipt and stops before a dependent branch SDK read", async () => {
  const s = await setup(); await s.seed(conditionalYAML()); const original = s.repository.mutate.bind(s.repository);
  vi.spyOn(s.repository, "mutate").mockImplementation(async mutation => {
    let skipWritten = false;
    const result = await original(state => { const before = Object.values(state.executions).some(item => item.readProgress?.attempts.yes?.status === "SKIPPED"); const value = mutation(state); skipWritten = !before && Object.values(state.executions).some(item => item.readProgress?.attempts.yes?.status === "SKIPPED"); return value; });
    if (skipWritten) throw new Error("Lost skip acknowledgement"); return result;
  });
  expect((await s.run({ input: { enabled: false } })).statusCode).toBe(503); expect(s.callTool).not.toHaveBeenCalled();
  const execution = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(execution).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { attempts: { yes: { status: "SKIPPED" } } } });
  await reconcileInterruptedExecutions(s.repository); expect(s.callTool).not.toHaveBeenCalled();
});

test("candidate stays a draft until explicit publication, then runs without a provider", async () => {
  const s = await setup();
  const created = await s.app.inject({ method: "POST", url: "/api/workflows", headers: s.headers, payload: { candidate: { yaml } } });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id;
  const run = () => s.app.inject({ method: "POST", url: `/api/workflows/${id}/run`, headers: s.headers, payload: { input: { invoiceId: "actual" } } });
  expect((await run()).statusCode).toBe(409);
  expect(s.listTools).not.toHaveBeenCalled();
  const publication = await s.app.inject({ method: "POST", url: `/api/workflows/${id}/publish`, headers: s.headers, payload: {} });
  expect(publication.statusCode, publication.body).toBe(200);
  expect(publication.json().data.artifactState).toBe("PUBLISHED");
  expect((await run()).statusCode).toBe(200);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("offline draft simulation is static and never discovers, dispatches or invokes a model", async () => {
  const s = await setup({ provider: true }); await s.seed(yaml, false);
  const response = await s.run({ dryRun: true });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ dry_run: true, plan_valid: true, can_execute: false, live_readiness: "not_checked", simulation: "static-read-plan" });
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test("missing bridge returns a precise connection failure without inventing an execution", async () => {
  const s = await setup({ noBridge: true, provider: true }); await s.seed();
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(503);
  expect(response.json().meta.code).toBe("ERPBRIDGE_NOT_CONNECTED");
  expect((await s.repository.snapshot()).executions).toEqual({}); expect(s.queryWithTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["condition", "retryCount", "forward", "malformed", "reserved", "write", "schema"])("unsupported %s is blocked before live discovery", async (scenario) => {
  const s = await setup({ write: scenario === "write" });
  const blueprint = parseWorkflowYAMLStrict(yaml);
  if (scenario === "condition") blueprint.steps[0]!.condition = "true";
  if (scenario === "retryCount") blueprint.steps[0]!.retryCount = 1;
  if (scenario === "forward") blueprint.steps[0]!.parameters = { id: "{{details.structuredContent.id}}" };
  if (scenario === "malformed") blueprint.steps[0]!.parameters = { id: "{{ input.id + 1 }}" };
  if (scenario === "reserved") blueprint.steps[0]!.id = "input";
  if (scenario === "schema") s.tool.input_schema = { type: "invalid" };
  await s.seed(stringify(blueprint));
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(422);
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test.each(["missing-input", "invalid-input", "missing-output", "mcp-error", "malformed-output"])("%s stops at the actual failed node without replay", async (scenario) => {
  const s = await setup(); await s.seed();
  if (scenario === "missing-output") s.callTool.mockResolvedValue({ content: [], structuredContent: {} });
  if (scenario === "mcp-error") s.callTool.mockResolvedValue({ content: [{ type: "text", text: "private-remote-error" }], isError: true });
  if (scenario === "malformed-output") s.callTool.mockResolvedValue({ invented: "not an MCP envelope" });
  const response = await s.run({ input: scenario === "missing-input" ? {} : { invoiceId: scenario === "invalid-input" ? 123 : "invoice-1" } });
  expect(response.statusCode, response.body).toBe(422);
  const state = await s.repository.snapshot(), execution = Object.values(state.executions)[0]!;
  expect(execution.status).toBe(scenario === "malformed-output" ? "RECOVERY_REQUIRED" : "FAILED");
  expect(execution.failure?.failedStepId).toBe(scenario === "missing-output" ? "details" : "lookup");
  expect(s.callTool).toHaveBeenCalledTimes(["missing-input", "invalid-input"].includes(scenario) ? 0 : 1);
  expect(JSON.stringify(state.executions)).not.toContain("private-remote-error");
  expect(state.timelines[execution.id]?.at(-1)?.status).toBe(scenario === "malformed-output" ? "UNKNOWN" : "FAILED");
  if (scenario === "missing-output") expect(execution.finalOutput).toEqual({ content: [], structuredContent: {} });
  else expect(execution.finalOutput).toBeUndefined();
});

test("known bridge failure receipt belongs to its failed attempt, never successful outputs or downstream inputs", async () => {
  const s = await setup(); await s.seed();
  s.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "Rate limit reached" }], isError: true, _meta: { secret: "private-meta", "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1000 } } });
  expect((await s.run()).statusCode).toBe(422);
  const state = await s.repository.snapshot(), execution = Object.values(state.executions)[0]!;
  expect(execution.status).toBe("FAILED"); expect(execution.stepOutputs?.lookup).toBeUndefined(); expect(execution.finalOutput).toBeUndefined();
  expect(state.timelines[execution.id]?.at(-1)).toMatchObject({ nodeId: "lookup", status: "FAILED", output: { isError: true, _meta: { "com.erpbridge/error": { type: "rate_limit", retryAfterMs: 1000 } } } });
  expect(JSON.stringify(state.timelines)).not.toContain("private-meta"); expect(s.callTool).toHaveBeenCalledOnce();
});

test.each(["disabled", "assignment", "registry"])("%s revocation after first node prevents second dispatch", async (scenario) => {
  const s = await setup({ roleId: scenario === "assignment" ? "role_client" : "role_admin" }); await s.seed();
  s.callTool.mockImplementationOnce(async () => {
    if (scenario === "registry") s.drift();
    else await s.repository.mutate((state) => { if (scenario === "disabled") state.users.actor!.status = "Disabled"; else state.workflows.read!.assignedUserIds = []; });
    return { content: [], structuredContent: { id: "actual-first-output" } };
  });
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(422);
  expect(s.callTool).toHaveBeenCalledTimes(1);
  const state = await s.repository.snapshot(), execution = Object.values(state.executions)[0]!;
  expect(execution).toMatchObject({ status: "FAILED", failure: { failedStepId: "details" }, stepOutputs: { lookup: { structuredContent: { id: "actual-first-output" } } } });
  expect(execution.workflowSnapshot?.registryHash).toBe("sha256:registry-v1");
});

test("run retains its exact published snapshot despite a later draft edit and redacts structured credentials", async () => {
  const s = await setup(); await s.seed();
  s.callTool.mockImplementationOnce(async () => {
    await s.repository.mutate((state) => { state.workflows.read!.yaml = yaml.replace("Daily read", "New draft"); state.workflows.read!.draftVersion = 2; });
    return { content: [{ type: "text", text: JSON.stringify({ id: "invoice-1", api_key: "remote-secret" }) }], structuredContent: { id: "invoice-1", token: "remote-secret" } };
  });
  const response = await s.run({ input: { invoiceId: "invoice-1", api_key: "input-secret" } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.workflowSnapshot.yaml).toBe(yaml);
  expect(response.body).not.toContain("remote-secret"); expect(response.body).not.toContain("input-secret");
  expect((await s.run()).statusCode).toBe(409);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("discovery failure and schema drift do not create runnable tool contracts", async () => {
  const s = await setup(); await s.seed(); s.listTools.mockRejectedValue(new Error("secret-discovery-detail"));
  const response = await s.run();
  expect(response.statusCode).toBe(503); expect(response.json().meta.code).toBe("ERPBRIDGE_DISCOVERY_FAILED");
  expect(response.body).not.toContain("secret-discovery-detail"); expect(s.callTool).not.toHaveBeenCalled();
  s.listTools.mockResolvedValue([{ name: s.tool.mcp_tool_name, inputSchema: { type: "object" } }]);
  const drift = await s.run();
  expect(drift.statusCode).toBe(422); expect(drift.json().meta.code).toBe("LIVE_CONTRACT_NOT_READY");
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test("server-only full-plan dispatch rejects a forged original verification receipt", async () => {
  const s = await setup(); await s.seed();
  const gate = await s.validator.validateAndIssueToken("RunWorkflow", yaml, "Platform Admin");
  const forged = structuredClone(gate.token!);
  await expect(dispatchReadTool(s.services, "actor", "finance.read", { id: "invoice-1" }, { workflowId: "read", plan: { yaml, stepIndex: 0, token: forged } })).rejects.toThrow();
  expect(s.callTool).not.toHaveBeenCalled();
});

test("schema profile rejects ignored constraints, missing types and reserved reference traversal", async () => {
  const s = await setup();
  s.tool.input_schema = { type: "object", properties: { id: { description: "Missing type" } } };
  expect(inspectReadWorkflow(parseWorkflowYAMLStrict(yaml), [s.tool], "Platform Admin")).not.toEqual([]);
  s.tool.input_schema = { type: "object", properties: { id: { type: "string", minLength: 2 } } };
  expect(inspectReadWorkflow(parseWorkflowYAMLStrict(yaml), [s.tool], "Platform Admin")).not.toEqual([]);
  const blueprint = parseWorkflowYAMLStrict(yaml); blueprint.steps[0]!.parameters = { id: "{{input.__proto__.id}}" };
  expect(inspectReadWorkflow(blueprint, [s.tool], "Platform Admin")).not.toEqual([]);
});

class ReadPersistence implements PersistenceBackend {
  payload: Uint8Array | null = null;
  failWhen: ((state: RepositoryState) => boolean) | undefined;
  commitBeforeFailure = false;
  async load() { return this.payload; }
  async save(payload: Uint8Array) {
    const state = JSON.parse(Buffer.from(payload).toString("utf8")) as RepositoryState;
    if (this.failWhen?.(state)) {
      this.failWhen = undefined;
      if (this.commitBeforeFailure) this.payload = Buffer.from(payload);
      throw new Error("fixture storage acknowledgement failure");
    }
    this.payload = Buffer.from(payload);
  }
  async probe() {}
  async close() {}
  state(): RepositoryState { return JSON.parse(Buffer.from(this.payload!).toString("utf8")); }
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class QueuePersistence extends ReadPersistence { readonly readQueueDurability = "encrypted-single-writer" as const; }
const queuedInput = (key = "read-job-fixture-001", input = { invoiceId: "queued-invoice", api_key: "private-queue-secret" }) => ({ mode: "async-read", idempotencyKey: key, input });
async function waitForTerminal(repository: Repository, id: string) {
  await vi.waitFor(async () => { expect((await repository.snapshot()).executions[id]?.status).not.toMatch(/^(PENDING|RUNNING)$/); }, { timeout: 3000, interval: 10 });
  await vi.waitFor(async () => { expect((await repository.snapshot()).readJobs[id]?.state).not.toBe("CLAIMED"); }, { timeout: 3000, interval: 10 });
  return (await repository.snapshot()).executions[id]!;
}

test("async admission returns a run ID before held SDK completion; same key never dispatches twice", async () => {
  const s = await setup({ provider: true }); await s.seed(); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "queued-result" } }; });
  const response = await s.run(queuedInput()); expect(response.statusCode, response.body).toBe(202);
  const admitted = response.json().data;
  expect(admitted.status).toBe("PENDING"); expect(admitted.id).toBeTruthy(); expect(response.body).not.toContain("private-queue-secret");
  await entered.promise;
  const duplicate = await s.run(queuedInput()); expect(duplicate.statusCode, duplicate.body).toBe(202); expect(duplicate.json().data.id).toBe(admitted.id);
  expect(s.callTool).toHaveBeenCalledTimes(1);
  const state = await s.repository.snapshot(); expect(state.readJobs[admitted.id]?.inputCiphertext).toBeTruthy();
  expect(state.readJobs[admitted.id]?.inputCiphertext).not.toContain("private-queue-secret");
  const list = await s.app.inject({ method: "GET", url: "/api/executions", headers: s.headers });
  expect(list.body).not.toContain("inputCiphertext"); expect(list.body).not.toContain("private-queue-secret");
  unblock.release(); const done = await waitForTerminal(s.repository, admitted.id);
  expect(done.status).toBe("DONE"); expect(s.callTool.mock.calls).toEqual([["invoice-read", { id: "queued-invoice", role: "admin" }], ["invoice-read", { id: "queued-result", role: "admin" }]]);
  expect((await s.repository.snapshot()).readJobs[admitted.id]?.inputCiphertext).toBeUndefined();
  expect((await s.run(queuedInput())).json().data.id).toBe(admitted.id); expect(s.callTool).toHaveBeenCalledTimes(2); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("same-key concurrent admission is atomic and changed inputs conflict", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const responses = await Promise.all([s.run(queuedInput()), s.run(queuedInput())]);
  expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
  expect(new Set(responses.map((response) => response.json().data.id)).size).toBe(1);
  expect(Object.keys((await s.repository.snapshot()).readJobs)).toHaveLength(1);
  expect((await s.run(queuedInput("read-job-fixture-001", { invoiceId: "other", api_key: "private-queue-secret" }))).statusCode).toBe(409);
  expect(s.callTool).not.toHaveBeenCalled(); kick.mockRestore();
});

test("a queued cancellation is terminal before worker claim and deletes private input", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  const cancel = await s.app.inject({ method: "POST", url: `/api/executions/${admitted.id}/cancel`, headers: s.headers, payload: {} });
  expect(cancel.statusCode, cancel.body).toBe(200); expect(cancel.json().data.status).toBe("CANCELLED");
  expect((await s.repository.snapshot()).readJobs[admitted.id]).toMatchObject({ state: "FINISHED" });
  expect((await s.repository.snapshot()).readJobs[admitted.id]?.inputCiphertext).toBeUndefined();
  kick.mockRestore(); queue.kick(); await new Promise((resolve) => setImmediate(resolve)); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["disabled", "role", "assignment", "registry", "publication", "ciphertext", "endpoint", "credential", "role-map"])("queued %s change stops before SDK dispatch", async (change) => {
  const s = await setup({ roleId: "role_client" }); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  await s.repository.mutate((state) => {
    if (change === "disabled") state.users.actor!.status = "Disabled";
    if (change === "role") state.users.actor!.roleId = "role_admin";
    if (change === "assignment") state.workflows.read!.assignedUserIds = [];
    if (change === "publication") state.versions.read = [];
    if (change === "ciphertext") state.readJobs[admitted.id]!.inputCiphertext = Buffer.from("tampered-input").toString("base64");
  });
  if (change === "registry") s.drift();
  if (change === "role-map") s.services.config.erpbridgeRoleMap.Client = "changed-client";
  if (["endpoint", "credential"].includes(change)) s.services.erpbridgeSession = await createErpbridgeMcpSession({
    baseURL: change === "endpoint" ? "https://other-bridge.example.test" : "https://bridge.example.test", token: change === "credential" ? "other-fixture-token" : "fixture-only", timeoutMs: 1000, validator: s.validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: s.listTools, callTool: s.callTool },
  });
  kick.mockRestore(); queue.kick(); const item = await waitForTerminal(s.repository, admitted.id);
  expect(item).toMatchObject({ status: "FAILED", failure: { failureCategory: "READ_JOB_PREPARATION_FAILED", toolWasCalled: false } }); expect(s.callTool).not.toHaveBeenCalled();
});

test("queued worker executes pinned published source even if a different draft is edited later", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  await s.repository.mutate((state) => { state.workflows.read!.yaml = yaml.replace("Daily read", "Changed draft"); state.workflows.read!.draftVersion = 2; });
  kick.mockRestore(); queue.kick(); const item = await waitForTerminal(s.repository, admitted.id);
  expect(item.status).toBe("DONE"); expect(item.workflowSnapshot?.yaml).toBe(yaml); expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("connection role-map drift after a saved node cannot authorize a later queued read", async () => {
  const s = await setup(); await s.seed();
  s.callTool.mockImplementationOnce(async () => {
    s.services.config.erpbridgeRoleMap["Platform Admin"] = "changed-admin";
    return { content: [], structuredContent: { id: "first-saved" } };
  });
  const admitted = (await s.run(queuedInput())).json().data, item = await waitForTerminal(s.repository, admitted.id);
  expect(item.status).toBe("FAILED"); expect(item.stepOutputs?.lookup).toMatchObject({ structuredContent: { id: "first-saved" } });
  expect(item.readProgress?.attempts.details?.status).toBe("FAILED"); expect(s.callTool).toHaveBeenCalledTimes(1);
  expect((await s.repository.snapshot()).timelines[admitted.id]?.[1]).toMatchObject({ status: "FAILED", outcome: "FAILED" });
  expect((await s.repository.snapshot()).executionEvents[admitted.id]?.filter((event) => event.type === "node.dispatch_intent")).toHaveLength(1);
});

test("durable unclaimed job survives a repository/process restart with private input intact", async () => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed();
  const kick = vi.spyOn(readJobQueue(first.services), "kick").mockImplementation(() => {});
  const admitted = (await first.run(queuedInput())).json().data; expect(admitted.readProgress.persistence).toBe("durable");
  await first.app.close(); kick.mockRestore();
  const second = await setup({ persistence }); await second.app.ready();
  const item = await waitForTerminal(second.repository, admitted.id);
  expect(item.status).toBe("DONE"); expect(first.callTool).not.toHaveBeenCalled(); expect(second.callTool.mock.calls[0]?.[1]).toMatchObject({ id: "queued-invoice" });
  expect((await second.run(queuedInput())).json().data.id).toBe(admitted.id); expect(second.callTool).toHaveBeenCalledTimes(2);
});

test("shutdown fences in-flight job and restart never replays it", async () => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed(); const entered = barrier(), unblock = barrier();
  first.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "late-old-worker" } }; });
  const admitted = (await first.run(queuedInput())).json().data; await entered.promise; await first.app.close();
  const image = persistence.state(); expect(image.executions[admitted.id]?.status).toBe("RECOVERY_REQUIRED"); expect(image.readJobs[admitted.id]?.state).toBe("RECOVERY_REQUIRED");
  unblock.release(); await new Promise((resolve) => setImmediate(resolve));
  const second = await setup({ persistence }); await second.app.ready();
  const item = (await second.repository.snapshot()).executions[admitted.id]!;
  expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.stepOutputs?.lookup).toBeUndefined(); expect(second.callTool).not.toHaveBeenCalled();
});

test("unenforced durable storage and missing async key reject without admission", async () => {
  const s = await setup({ persistence: new ReadPersistence() }); await s.seed();
  const rejected = await s.run(queuedInput()); expect(rejected.statusCode).toBe(503); expect(rejected.json().meta.code).toBe("READ_QUEUE_STORAGE_UNSUPPORTED");
  expect((await s.repository.snapshot()).readJobs).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
  const memory = await setup(); await memory.seed(); expect((await memory.run({ mode: "async-read", input: {} })).statusCode).toBe(400);
  expect((await memory.repository.snapshot()).executions).toEqual({});
});

test("read job bounds reject excessive input and keys before discovery or admission", async () => {
  const s = await setup(); await s.seed();
  let nested: Record<string, unknown> = {};
  for (let index = 0; index < 18; index++) nested = { child: nested };
  const requests = [
    { ...queuedInput(), idempotencyKey: "short" },
    { ...queuedInput(), idempotencyKey: "x".repeat(129) },
    { ...queuedInput(), input: { invoiceId: "x".repeat(64001) } },
    { ...queuedInput(), input: nested },
  ];
  expect((await Promise.all(requests.map((payload) => s.run(payload)))).map((response) => response.statusCode)).toEqual([400, 400, 413, 400]);
  expect((await s.repository.snapshot()).executions).toEqual({});
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("bounded queue refuses a new job but preserves same-key lookup; queued retry is blocked", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services);
  const kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  await s.repository.mutate((state) => {
    for (let index = 1; index < 100; index++) state.readJobs[`fixture-${index}`] = { ...state.readJobs[admitted.id]!, executionId: `fixture-${index}`, idempotencyScope: `fixture-${index}` };
  });
  const rejected = await s.run(queuedInput("read-job-new-fixture"));
  expect(rejected.statusCode).toBe(429); expect(rejected.json().meta.code).toBe("READ_QUEUE_FULL");
  expect((await s.run(queuedInput())).json().data.id).toBe(admitted.id);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${admitted.id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
  // Invalid capacity-only fixture entries must never reach the worker.
  await s.repository.mutate((state) => { for (let index = 1; index < 100; index++) delete state.readJobs[`fixture-${index}`]; });
  kick.mockRestore();
});

test("same-key admission cannot silently bind a later publication", async () => {
  const s = await setup(); await s.seed(); const kick = vi.spyOn(readJobQueue(s.services), "kick").mockImplementation(() => {});
  await s.run(queuedInput());
  await s.repository.mutate((state) => { state.workflows.read!.publishedVersion = 2; state.versions.read!.push({ version: 2, artifactState: "PUBLISHED", yaml }); });
  const response = await s.run(queuedInput()); expect(response.statusCode).toBe(409); expect(response.json().meta.code).toBe("READ_JOB_KEY_CONFLICT");
  expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled(); kick.mockRestore();
});

test("an async in-flight cancellation retains the committed answer and prevents the next read", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "saved-after-cancellation" } }; });
  const admitted = (await s.run(queuedInput())).json().data; await entered.promise;
  const response = await s.app.inject({ method: "POST", url: `/api/executions/${admitted.id}/cancel`, headers: s.headers, payload: {} });
  expect(response.statusCode).toBe(202); expect(response.json().data.status).toBe("RUNNING");
  unblock.release(); const item = await waitForTerminal(s.repository, admitted.id);
  expect(item).toMatchObject({ status: "CANCELLED", stepOutputs: { lookup: { structuredContent: { id: "saved-after-cancellation" } } } });
  expect(s.callTool).toHaveBeenCalledTimes(1); expect((await s.repository.snapshot()).readJobs[admitted.id]?.inputCiphertext).toBeUndefined();
});

test("a crash image of a CLAIMED job retains confirmed nodes and never dispatches on restart", async () => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed(); const entered = barrier(), unblock = barrier();
  first.callTool.mockImplementationOnce(async () => ({ content: [], structuredContent: { id: "first-saved" } }));
  first.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "old-late" } }; });
  const admitted = (await first.run(queuedInput())).json().data; await entered.promise;
  const crashImage = new QueuePersistence(); crashImage.payload = Buffer.from(persistence.payload!);
  const second = await setup({ persistence: crashImage }); await second.app.ready();
  const state = await second.repository.snapshot();
  expect(state.readJobs[admitted.id]?.state).toBe("RECOVERY_REQUIRED");
  expect(state.executions[admitted.id]).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { attempts: { lookup: { status: "DONE" }, details: { status: "UNKNOWN" } } }, stepOutputs: { lookup: { structuredContent: { id: "first-saved" } } } });
  expect(second.callTool).not.toHaveBeenCalled();
  expect((await second.run(queuedInput())).json().data.id).toBe(admitted.id); expect(second.callTool).not.toHaveBeenCalled();
  await first.app.close(); unblock.release(); await new Promise((resolve) => setImmediate(resolve));
});

test("a ciphertext from another queued execution cannot substitute its inputs", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const first = (await s.run(queuedInput())).json().data;
  const second = (await s.run(queuedInput("another-read-job-001"))).json().data;
  await s.repository.mutate((state) => { state.readJobs[first.id]!.inputCiphertext = state.readJobs[second.id]!.inputCiphertext!; });
  await s.app.inject({ method: "POST", url: `/api/executions/${second.id}/cancel`, headers: s.headers, payload: {} });
  kick.mockRestore(); queue.kick(); const item = await waitForTerminal(s.repository, first.id);
  expect(item).toMatchObject({ status: "FAILED", failure: { toolWasCalled: false } }); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["QUEUED", "CLAIMED"])("lost %s acknowledgement fences dispatch and preserves admitted identity after reload", async (phase) => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed();
  persistence.commitBeforeFailure = true;
  persistence.failWhen = (state) => Object.values(state.readJobs).some((job) => job.state === phase);
  const response = await first.run(queuedInput());
  expect(response.statusCode).toBe(phase === "QUEUED" ? 500 : 202);
  await vi.waitFor(async () => { expect((await first.repository.persistenceStatus()).healthy).toBe(false); }, { timeout: 3000, interval: 10 });
  const admitted = Object.values(persistence.state().executions)[0]!;
  expect(first.callTool).not.toHaveBeenCalled();
  const crashImage = new QueuePersistence(); crashImage.payload = Buffer.from(persistence.payload!);
  await first.repository.recoverPersistenceState(); await first.app.close();
  const second = await setup({ persistence: crashImage }); await second.app.ready();
  const item = phase === "QUEUED" ? await waitForTerminal(second.repository, admitted.id) : (await second.repository.snapshot()).executions[admitted.id]!;
  expect(item.status).toBe(phase === "QUEUED" ? "DONE" : "RECOVERY_REQUIRED");
  expect((await second.run(queuedInput())).json().data.id).toBe(admitted.id);
  expect(second.callTool).toHaveBeenCalledTimes(phase === "QUEUED" ? 2 : 0);
  expect(Object.keys((await second.repository.snapshot()).executions)).toHaveLength(1);
});

test("dispatch intent is persisted before the SDK; completed output is persisted before the following call", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  s.callTool.mockImplementation(async () => {
    const record = Object.values(persistence.state().executions)[0]!;
    const nodeId = s.callTool.mock.calls.length === 1 ? "lookup" : "details";
    expect(record.readProgress?.attempts[nodeId]?.status).toBe("DISPATCH_INTENT");
    expect(persistence.state().executionEvents[record.id]?.at(-1)?.type).toBe("node.dispatch_intent");
    if (nodeId === "details") expect(record.stepOutputs?.lookup).toEqual({ content: [], structuredContent: { id: "first-result" } });
    return { content: [], structuredContent: { id: "first-result" } };
  });
  const response = await s.run(); expect(response.statusCode, response.body).toBe(200);
  const record = response.json().data;
  expect(record.readProgress).toMatchObject({ persistence: "durable", nextStepIndex: 2, lastSequence: 8 });
  expect(persistence.state().executionEvents[record.id]?.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("in-flight cancellation is a durable request, not a claim that the transport stopped", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "completed-in-flight" } }; });
  const running = s.run().then((response) => response); await entered.promise;
  const record = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(record.status).toBe("RUNNING"); expect(record.stepOutputs?.lookup).toBeUndefined();
  const cancel = () => s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} });
  const accepted = await cancel(); expect(accepted.statusCode, accepted.body).toBe(202);
  expect(accepted.json()).toMatchObject({ data: { status: "RUNNING" }, meta: { transportInterrupted: false } });
  expect((await cancel()).statusCode).toBe(202);
  expect((await s.repository.snapshot()).executionEvents[record.id]?.filter((event) => event.type === "run.cancel_requested")).toHaveLength(1);
  unblock.release(); const response = await running;
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ status: "CANCELLED", stepOutputs: { lookup: { structuredContent: { id: "completed-in-flight" } } } });
  expect(s.callTool).toHaveBeenCalledTimes(1);
  expect((await cancel()).statusCode).toBe(200);
});

test("cancellation during awaited policy work prevents the first dispatch and is not a failed tool call", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.services.validationGate = { validateAndIssueToken: async (action, source, actor) => {
    if (action === "ReadToolBroker") { entered.release(); await unblock.promise; }
    return s.validator.validateAndIssueToken(action, source, actor.role);
  } };
  const running = s.run().then((response) => response); await entered.promise;
  const record = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(record.readProgress?.attempts.lookup?.status).toBe("PREPARING");
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} })).statusCode).toBe(202);
  unblock.release(); const response = await running;
  expect(response.json().data.status).toBe("CANCELLED"); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).timelines[record.id]?.[0]).toMatchObject({ status: "CANCELLED", outcome: "NOT_DISPATCHED" });
});

test.each(["DISPATCH_INTENT", "DONE"])("a failed %s save stops execution and reconciles without replay", async (phase) => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  persistence.failWhen = (state) => Object.values(state.executions).some((item) => item.readProgress?.attempts.lookup?.status === phase);
  const response = await s.run(); expect(response.statusCode, response.body).toBe(503); expect(response.json().meta.code).toBe("CHECKPOINT_NOT_COMMITTED");
  expect(s.callTool).toHaveBeenCalledTimes(phase === "DONE" ? 1 : 0);
  const restored = await Repository.open(persistence); await reconcileInterruptedExecutions(restored);
  const record = Object.values((await restored.snapshot()).executions)[0]!;
  expect(record.status).toBe("RECOVERY_REQUIRED");
  expect(record.readProgress?.attempts.lookup?.status).toBe(phase === "DONE" ? "UNKNOWN" : "FAILED");
  expect(record.stepOutputs?.lookup).toBeUndefined();
  expect((await restored.snapshot()).executionEvents[record.id]?.some((event) => event.type === "node.completed")).toBe(false);
});

test("a committed checkpoint with a lost acknowledgement is reloaded, not overwritten with the rolled-back aggregate", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  persistence.commitBeforeFailure = true;
  persistence.failWhen = (state) => Object.values(state.executions).some((item) => item.readProgress?.attempts.lookup?.status === "DONE");
  const response = await s.run(); expect(response.statusCode).toBe(503); expect(s.callTool).toHaveBeenCalledTimes(1);
  const record = Object.values(persistence.state().executions)[0]!;
  expect(record).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { nextStepIndex: 1, attempts: { lookup: { status: "DONE" } } }, stepOutputs: { lookup: { structuredContent: { id: "invoice-actual" } } } });
  expect(persistence.state().executionEvents[record.id]?.filter((event) => event.type === "node.completed")).toHaveLength(1);
});

test("event replay is paginated, monotonic and account-scoped; uncertain/running runs cannot be retried", async () => {
  const s = await setup(); await s.seed(); const response = await s.run(), id = response.json().data.id;
  const read = (query = "", headers = s.headers) => s.app.inject({ method: "GET", url: `/api/executions/${id}/events${query}`, headers });
  const first = await read("?after=0&limit=2"); expect(first.statusCode).toBe(200);
  expect(first.json().data).toMatchObject({ cursor: 2, lastSequence: 8, hasMore: true });
  const rest = await read("?after=2&limit=100"); expect(rest.json().data.events.map((event: { sequence: number }) => event.sequence)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(JSON.stringify(rest.json().data.events)).not.toContain("invoice-requested");
  for (const query of ["?after=-1", "?after=9", "?limit=101", "?after=1.5", "?other=1"]) expect((await read(query)).statusCode).toBe(400);
  await s.repository.mutate((state) => { state.users.other = { ...state.users.actor!, id: "other", roleId: "role_client" }; state.executions[id]!.status = "RECOVERY_REQUIRED"; });
  const otherHeaders = { authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: "other" })}` };
  expect((await read("", otherHeaders)).statusCode).toBe(404);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${id}/cancel`, headers: otherHeaders, payload: {} })).statusCode).toBe(404);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("a draft mutation during run preflight cannot rewrite the pinned source or pass publication checks", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.services.validationGate = { validateAndIssueToken: async (action, source, actor) => {
    if (action === "RunWorkflow") { entered.release(); await unblock.promise; }
    return s.validator.validateAndIssueToken(action, source, actor.role);
  } };
  const running = s.run().then((response) => response); await entered.promise;
  await s.repository.mutate((state) => { state.workflows.read!.yaml = yaml.replace("Daily read", "Concurrent draft"); state.workflows.read!.publishedVersion = 2; state.versions.read!.push({ version: 2, artifactState: "PUBLISHED", yaml: state.workflows.read!.yaml }); });
  unblock.release(); const response = await running;
  expect(response.statusCode, response.body).toBe(409); expect(s.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test("restart reconciliation preserves completed nodes, marks unacknowledged intent UNKNOWN, and fences stale callbacks", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  const secondEntered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => ({ content: [], structuredContent: { id: "first-durable-answer" } }));
  s.callTool.mockImplementationOnce(async () => { secondEntered.release(); await unblock.promise; return { content: [], structuredContent: { id: "late-second-answer" } }; });
  const running = s.run().then((response) => response); await secondEntered.promise;
  const crashImage = new ReadPersistence(); crashImage.payload = Buffer.from(persistence.payload!);
  const reopened = await Repository.open(crashImage); await reconcileInterruptedExecutions(reopened);
  const record = Object.values((await reopened.snapshot()).executions)[0]!;
  expect(record).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { epoch: 2, nextStepIndex: 1, attempts: { lookup: { status: "DONE" }, details: { status: "UNKNOWN" } } }, stepOutputs: { lookup: { structuredContent: { id: "first-durable-answer" } } } });
  expect((await reopened.snapshot()).timelines[record.id]?.map((entry) => entry.status)).toEqual(["DONE", "UNKNOWN"]);
  const eventCount = (await reopened.snapshot()).executionEvents[record.id]!.length;
  await reconcileInterruptedExecutions(reopened);
  expect((await reopened.snapshot()).executionEvents[record.id]).toHaveLength(eventCount);
  // Same-repository generation change simulates a stale worker finishing later.
  await reconcileInterruptedExecutions(s.repository); unblock.release();
  const response = await running; expect(response.statusCode).toBe(503);
  const current = (await s.repository.snapshot()).executions[record.id]!;
  expect(current.stepOutputs?.details).toBeUndefined(); expect(current.readProgress?.epoch).toBe(2);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("failed completion of a later node does not discard an earlier saved answer", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  persistence.failWhen = (state) => Object.values(state.executions).some((item) => item.readProgress?.attempts.details?.status === "DONE");
  const response = await s.run(); expect(response.statusCode).toBe(503); expect(s.callTool).toHaveBeenCalledTimes(2);
  const record = Object.values(persistence.state().executions)[0]!;
  expect(record.stepOutputs?.lookup).toEqual({ content: [], structuredContent: { id: "invoice-actual" } });
  expect(record.stepOutputs?.details).toBeUndefined();
  expect(record.readProgress?.attempts.details?.status).toBe("UNKNOWN");
  expect(record.finalOutput).toEqual(record.stepOutputs?.lookup);
});

test("cancellation control rechecks current assignment, and terminal completion is immutable", async () => {
  const s = await setup({ roleId: "role_client" }); await s.seed();
  const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "first" } }; });
  const running = s.run().then((response) => response); await entered.promise;
  const record = Object.values((await s.repository.snapshot()).executions)[0]!;
  await s.repository.mutate((state) => { state.workflows.read!.assignedUserIds = []; });
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} })).statusCode).toBe(404);
  expect((await s.repository.snapshot()).executions[record.id]!.readProgress?.cancellation).toBeUndefined();
  unblock.release(); await running; expect(s.callTool).toHaveBeenCalledTimes(1);
  await s.repository.mutate((state) => { state.workflows.read!.assignedUserIds = ["actor"]; });
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} })).statusCode).toBe(409);
});

test("a worker cannot declare DONE when node checkpoints are incomplete", async () => {
  const s = await setup(); await s.seed(); const response = await s.run(), id = response.json().data.id;
  await s.repository.mutate((state) => { const item = state.executions[id]!; item.status = "RUNNING"; item.readProgress!.nextStepIndex = 0; item.readProgress!.attempts = {}; });
  await expect(new ReadCheckpoints(s.repository, id, 1, yaml).finish(false)).rejects.toThrow("checkpoint could not be committed");
  expect((await s.repository.snapshot()).executions[id]!.status).toBe("RUNNING");
  expect((await s.repository.snapshot()).executionEvents[id]).toHaveLength(8);
});

test("valid node IDs do not collide with inherited object members in checkpoint storage", async () => {
  const s = await setup(); await s.seed(stringify({ name: "Read", description: "Read one invoice", trigger: { type: "manual" }, steps: [{ id: "toString", action: "finance.read", parameters: { id: "invoice" } }] }));
  const response = await s.run(); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.readProgress.attempts.toString.status).toBe("DONE"); expect(s.callTool).toHaveBeenCalledTimes(1);
});

test("legacy interrupted executions are unknown, not falsely declared failed or safe to replay", async () => {
  const s = await setup(); await s.seed(); const response = await s.run(), id = response.json().data.id;
  await s.repository.mutate((state) => { const item = state.executions[id]!; item.status = "RUNNING"; delete item.readProgress; delete state.executionEvents[id]; });
  await reconcileInterruptedExecutions(s.repository);
  const state = await s.repository.snapshot();
  expect(state.executions[id]).toMatchObject({ status: "RECOVERY_REQUIRED", failure: { failureCategory: "LEGACY_OUTCOME_UNKNOWN" } });
  expect(state.executionEvents[id]).toBeUndefined();
  expect(state.auditLogs.at(-1)?.actor).toEqual({ id: "system", name: "Restart reconciliation" });
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("authority revoked during preflight prevents creating a run, before SDK dispatch", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.services.validationGate = { validateAndIssueToken: async (action, source, actor) => {
    if (action === "RunWorkflow") { entered.release(); await unblock.promise; }
    return s.validator.validateAndIssueToken(action, source, actor.role);
  } };
  const running = s.run().then((response) => response); await entered.promise;
  await s.repository.mutate((state) => { state.users.actor!.status = "Disabled"; });
  unblock.release(); const response = await running;
  expect(response.statusCode).toBe(403); expect(response.json().meta.code).toBe("EXECUTION_AUTHORITY_CHANGED");
  expect(s.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test.each([false, true])("MCP timeout after saved first answer=%s records UNKNOWN, rejects late output and never replays", async (savedFirst) => {
  const s = await setup({ mcpTimeoutMs: 80 }); await s.seed();
  const entered = barrier(), unblock = barrier();
  if (savedFirst) s.callTool.mockImplementationOnce(async () => ({ content: [], structuredContent: { id: "confirmed-first" } }));
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "unconfirmed-late" } }; });
  const admitted = (await s.run(queuedInput())).json().data; await entered.promise;
  const item = await waitForTerminal(s.repository, admitted.id), node = savedFirst ? "details" : "lookup";
  expect(item).toMatchObject({ status: "RECOVERY_REQUIRED", failure: { failureCategory: "READ_OUTCOME_UNKNOWN", failedStepId: node }, readProgress: { attempts: { [node]: { status: "UNKNOWN" } } } });
  expect(s.callTool).toHaveBeenCalledTimes(savedFirst ? 2 : 1);
  expect(s.services.erpbridgeSession!.available).toBe(false);
  if (savedFirst) expect(item.stepOutputs?.lookup).toEqual({ content: [], structuredContent: { id: "confirmed-first" } });
  else { expect(item.stepOutputs).toEqual({}); expect(item.finalOutput).toBeUndefined(); }
  const snapshot = await s.repository.snapshot();
  expect(snapshot.executionEvents[item.id]?.at(-1)?.type).toBe("run.recovery_required");
  expect((await s.run(queuedInput())).json().data.id).toBe(item.id);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${item.id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  unblock.release(); await new Promise(resolve => setImmediate(resolve));
  const after = await s.repository.snapshot();
  expect(after.executions[item.id]).toEqual(snapshot.executions[item.id]);
  expect(after.timelines[item.id]).toEqual(snapshot.timelines[item.id]);
  expect(after.executionEvents[item.id]).toEqual(snapshot.executionEvents[item.id]);
  expect(JSON.stringify(after.executions[item.id])).not.toContain("unconfirmed-late");
});

test("MCP discovery timeout fails preflight without an execution or cached readiness", async () => {
  const s = await setup({ mcpTimeoutMs: 30 }); await s.seed();
  s.listTools.mockImplementationOnce(() => new Promise(() => {}));
  const failed = await s.run(); expect(failed.statusCode).toBe(503);
  expect(failed.json().meta.code).toBe("ERPBRIDGE_DISCOVERY_FAILED");
  expect(s.services.erpbridgeSession!.available).toBe(false);
  expect((await s.run()).statusCode).toBe(503);
  expect(s.listTools).toHaveBeenCalledOnce(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).executions).toEqual({});
});
