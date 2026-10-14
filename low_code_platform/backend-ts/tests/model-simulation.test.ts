import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import jwt from "jsonwebtoken";
import { toolSchema } from "../src/registry/schemas.js";
import { parseModelFixtures, simulateModelWorkflow } from "../src/workflows/model-simulation.js";
import { compileModelFixtureWorkflow, compileOperationWorkflow } from "../src/workflows/compiled-read.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { RegistryService } from "../src/registry/service.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { buildApp } from "../src/http/app.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";

const role = "Platform Admin", tool = toolSchema.parse({ tool_id: "fixture-read", name: "read", mcp_tool_name: "read", allowed_roles: [role], is_read_only: true,
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { rows: { type: "array", items: { type: "number" } } }, required: ["rows"], additionalProperties: false } } });
const action = (nodeId: string) => ({ kind: "action", nodeId }), sequence = (...nodes: any[]) => ({ kind: "sequence", nodes });
function source(kind = "analysis", branched = false): any {
  const value: any = { name: "Supplied model test", description: "Not execution evidence", trigger: { type: "manual" }, steps: [
    { id: "first", action: "read", parameters: { id: "first" } }, { id: "second", action: "read", parameters: { id: "second" } },
    { id: "answer", kind, instruction: "Compare supplied report values", input: { a: "{{first.structuredContent.rows}}", b: "{{second.structuredContent.rows}}" }, data_class: "internal",
      output_schema: { type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false },
      ...(kind === "agent" ? { allowed_actions: ["read"], completion_predicate: { path: ["complete"], equals: true } } : {}) },
    { id: "after", action: "read", parameters: { id: "{{answer.structuredContent.summary}}" } },
  ] };
  if (branched) {
    value.trigger.config = { inputSchema: { type: "object", properties: { include: { type: "boolean" } } } };
    value.metadata = { controlFlow: { schemaVersion: "read-control-flow/v1", root: sequence(action("first"), action("second"), {
      kind: "if", id: "include", predicate: { kind: "ref", source: "workflowInput", path: ["include"] }, then: sequence(action("answer"), action("after")), else: sequence(),
    }) } };
  }
  return value;
}
const outputs = () => ({ first: { content: [], structuredContent: { rows: [1, 2] } }, second: { content: [], structuredContent: { rows: [3] } },
  answer: { structuredContent: { summary: "Test comparison", complete: true } }, after: { content: [], structuredContent: { rows: [4] } } });
const fixture = (yaml: string, values = outputs()) => parseModelFixtures({ profile: "model-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: values });

test.each(["analysis", "agent"])("%s fixture projection contains no admission/publication/provider authority", async kind => {
  const yaml = stringify(source(kind)), plan = compileModelFixtureWorkflow(yaml, [tool], role);
  expect(plan.profile).toBe("model-fixture-plan/v1");
  expect(JSON.stringify(plan)).not.toMatch(/admission|allowedCapabilities|provider|operation-compiler|workflow-operation-ir/);
  expect(() => compileOperationWorkflow(yaml, [tool], role, new Map())).toThrow(/pin/);
  const data = fixture(yaml), original = structuredClone(data), result = await simulateModelWorkflow(yaml, {}, data, [tool], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", usedFixtureIds: ["first", "second", "answer", "after"] });
  expect(result.trace[2]).toMatchObject({ kind, outcome: "SUPPLIED_MODEL_OUTPUT", arguments: { a: [1, 2], b: [3] } });
  expect(result.trace[3]!.arguments).toEqual({ id: "Test comparison" }); expect(data).toEqual(original);
});
test.each(["analysis", "agent"])("%s branches evaluate only selected fixtures without invented model answers", async kind => {
  const yaml = stringify(source(kind, true));
  for (const include of [true, false]) {
    const result = await simulateModelWorkflow(yaml, { include }, fixture(yaml), [tool], role);
    expect(result.outcome).toBe("SIMULATED_COMPLETE");
    expect(result.trace.find(entry => entry.nodeId === "include")!.selectedBranch).toBe(include ? "then" : "else");
    expect(result.stepOutputs.answer !== undefined).toBe(include);
    expect(result.trace.find(entry => entry.nodeId === "answer")!.outcome).toBe(include ? "SUPPLIED_MODEL_OUTPUT" : "NOT_SELECTED");
    expect(result.unusedFixtureIds).toEqual(include ? [] : ["answer", "after"]);
  }
});
test.each(["analysis", "agent"])("%s simulation checks shared item and character bounds before accepting an answer", async kind => {
  for (const bounds of [{ max_input_items: 2 }, { max_input_chars: 5 }]) {
    const value = source(kind); Object.assign(value.steps[2], bounds); const yaml = stringify(value);
    const result = await simulateModelWorkflow(yaml, {}, fixture(yaml), [tool], role);
    expect(result).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "MODEL_INPUT_LIMIT_EXCEEDED", failedNodeId: "answer", usedFixtureIds: ["first", "second"] });
    expect(result.stepOutputs.answer).toBeUndefined(); expect(result.stepOutputs.after).toBeUndefined();
  }
});
test.each([undefined, { summary: 4, complete: true }, { summary: "ok", complete: true, api_key: "private" }, { summary: "ok" }])("invalid model answer %j retains prior test answers, not a fabricated completion", async answer => {
  const yaml = stringify(source()), values: any = outputs(); values.answer = { structuredContent: answer };
  if (answer === undefined) delete values.answer;
  const result = await simulateModelWorkflow(yaml, {}, fixture(yaml, values), [tool], role);
  expect(result.outcome).toBe("SIMULATED_STOPPED"); expect(result.stepOutputs.answer).toBeUndefined(); expect(result.stepOutputs.after).toBeUndefined();
  expect(result.stepOutputs.first).toBeDefined(); expect(JSON.stringify(result)).not.toContain("private");
});
test.each([{ content: [], structuredContent: { summary: "ok", complete: true } }, { structuredContent: { summary: "ok", complete: true }, tool_calls: [] }, { structuredContent: { summary: "ok", complete: true }, approved: true }])("model envelope cannot smuggle tool/approval evidence %j", async answer => {
  const yaml = stringify(source()), values = { ...outputs(), answer } as any;
  expect(await simulateModelWorkflow(yaml, {}, fixture(yaml, values), [tool], role)).toMatchObject({ reason: "FIXTURE_OUTPUT_INVALID" });
});
test("non-complete agent answer stops rather than simulating dynamic work or accepting completion", async () => {
  const yaml = stringify(source("agent")), values = outputs(); values.answer.structuredContent.complete = false;
  expect(await simulateModelWorkflow(yaml, {}, fixture(yaml, values), [tool], role)).toMatchObject({ reason: "FIXTURE_AGENT_INCOMPLETE", usedFixtureIds: ["first", "second", "answer"] });
});
test("redaction-invalidated model answer fails closed", async () => {
  const value = source(); value.steps[2].output_schema = { type: "object", properties: { api_key: { type: "string" } }, required: ["api_key"], additionalProperties: false };
  const yaml = stringify(value), values: any = outputs(); values.answer = { structuredContent: { api_key: "never expose" } };
  const result = await simulateModelWorkflow(yaml, {}, fixture(yaml, values), [tool], role);
  expect(result).toMatchObject({ reason: "FIXTURE_OUTPUT_INVALID" }); expect(JSON.stringify(result)).not.toContain("never expose");
});
test.each(["effect", "sibling", "model-read-input", "bad-agent-action"])("unsupported/unauthorized %s cannot become simulated success", async scenario => {
  const value = source(scenario === "bad-agent-action" ? "agent" : "analysis", scenario === "sibling"); let tools = [tool];
  if (scenario === "effect") tools = [toolSchema.parse({ ...tool, is_read_only: false })];
  if (scenario === "sibling") value.metadata.controlFlow.root.nodes = [{ kind: "if", id: "include", predicate: { kind: "literal", value: true }, then: sequence(action("first"), action("second")), else: sequence(action("answer"), action("after")) }];
  if (scenario === "model-read-input") value.steps[2].input = "{{input.report}}";
  if (scenario === "bad-agent-action") value.steps[2].allowed_actions = ["not registered"];
  const yaml = stringify(value); expect(await simulateModelWorkflow(yaml, {}, fixture(yaml), tools, role)).toMatchObject({ outcome: "PLAN_BLOCKED", trace: [] });
});
test("strict fixture identity/envelope/bounds reject privilege claims and unknown outputs", async () => {
  const yaml = stringify(source()), data = fixture(yaml);
  expect(() => parseModelFixtures({ ...data, approved: true })).toThrow();
  expect(() => parseModelFixtures({ ...data, outputs: { constructor: {} } })).toThrow();
  expect(() => parseModelFixtures({ ...data, outputs: { answer: "x".repeat(512001) } })).toThrow();
  await expect(simulateModelWorkflow(yaml, {}, { ...data, outputs: { bogus: {} } }, [tool], role)).rejects.toThrow(/declared/);
});
test("selected read arguments from a supplied model still undergo the denial-only local rule check", async () => {
  const yaml = stringify(source()), check = vi.fn((nodeId: string) => nodeId !== "after");
  expect(await simulateModelWorkflow(yaml, {}, fixture(yaml), [tool], role, check)).toMatchObject({ reason: "SELECTED_PATH_RULE_BLOCKED", failedNodeId: "after" });
  expect(check.mock.calls.map(call => call[0])).toEqual(["first", "second", "after"]);
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function httpFixture() {
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "model-simulation-test-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const repository = await Repository.open(null), yaml = stringify(source("agent", true));
  const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => "registry-v1", findTool: (name: string) => name === "read" ? tool : undefined, enabledRules: () => [] } as unknown as RegistryService;
  const validator = new RegistryValidator(registries, repository), query = vi.fn(() => { throw new Error("No model entry in simulation"); });
  await repository.mutate(state => {
    state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", status: "Active", permissionOverrides: [], initials: "A", departmentId: null, lastLoginAt: null, createdAt: "now" };
    state.workflows.sim = { id: "sim", name: "Fixture", description: "Fixture", owner: { id: "actor", name: "Actor" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 4,
      successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: "now", updatedAt: "now", yaml, archived: false };
  });
  const app = await buildApp({ config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), providerRuntime: { configured: true, queryWithTools: query } as unknown as ProviderRuntime }); apps.push(app);
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: "actor", expiresIn: 3600 })}` };
  const payload = { dryRun: true, input: { include: true }, simulation: fixture(yaml) };
  return { repository, query, payload, run: (body: any = payload, auth = true) => app.inject({ method: "POST", url: "/api/workflows/sim/run", ...(auth ? { headers } : {}), payload: body }) };
}
test("normal HTTP model simulation has zero model/ERP/approval/run records and no readiness claim", async () => {
  const s = await httpFixture(), before = await s.repository.snapshot(), response = await s.run();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ simulation: "fixture-model/v1", outcome: "SIMULATED_COMPLETE", erp_calls: 0, model_calls: 0, persisted_run: false, can_execute: false,
    approval: "not_granted", model_behavior: "not_tested", model_usage: "not_measured", agent_tool_calls: "not_simulated", live_readiness: "not_checked", capability_admission: "not_checked" });
  expect(response.json().data.id).toBeUndefined(); expect(s.query).not.toHaveBeenCalled();
  const after = await s.repository.snapshot();
  for (const field of ["workflows", "versions", "executions", "timelines", "readJobs", "executionEvents", "invocationProvenance"] as const) expect(after[field]).toEqual(before[field]);
});
test.each(["stale", "not-dry", "unauthenticated", "async-read", "idempotency"])("HTTP simulation rejects %s without inference or a run", async scenario => {
  const s = await httpFixture(), payload: any = structuredClone(s.payload);
  if (scenario === "stale") payload.simulation.baseVersion = 2;
  if (scenario === "not-dry") payload.dryRun = false;
  if (scenario === "async-read") payload.mode = "async-read";
  if (scenario === "idempotency") payload.idempotencyKey = "not-an-admission-0001";
  const response = await s.run(payload, scenario !== "unauthenticated");
  expect(response.statusCode).toBe(scenario === "stale" ? 409 : scenario === "unauthenticated" ? 401 : scenario === "not-dry" ? 400 : 422);
  expect(s.query).not.toHaveBeenCalled(); expect(Object.keys((await s.repository.snapshot()).executions)).toEqual([]);
});
test("published operation metadata cannot intercept model fixtures or turn them into admission", async () => {
  const s = await httpFixture();
  await s.repository.mutate(state => { state.workflows.sim!.publishedVersion = 1; state.versions.sim = [{ version: 1, artifactState: "PUBLISHED", compiledOperation: { schemaVersion: "workflow-operation-ir/v5" } }]; });
  const response = await s.run({ ...s.payload, mode: "async-operation" });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ simulation: "fixture-model/v1", can_execute: false, persisted_run: false });
  expect(s.query).not.toHaveBeenCalled(); expect(Object.keys((await s.repository.snapshot()).executions)).toEqual([]);
});
