import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import jwt from "jsonwebtoken";
import { parseProtectedFixtures, simulateProtectedWorkflow } from "../src/workflows/protected-simulation.js";
import { compileProtectedFixtureWorkflow, compileOperationWorkflow } from "../src/workflows/compiled-read.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { selectedProtectedFixtureEvidenceYAML, selectedReadEvidenceYAML } from "../src/workflows/read-completion-evidence.js";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import type { RegistryService } from "../src/registry/service.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { buildApp } from "../src/http/app.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";
import { protectedSimulationSource as source, protectedSimulationRead as read, protectedSimulationRole as role, fixtureAction as action,
  fixtureSequence as seq, fixtureRef as ref, fixtureOutput as output } from "./fixtures/protected-simulation.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { toolSchema } from "../src/registry/schemas.js";

const fault = { kind: "business-read-error", code: "ERP_RESOURCE_NOT_FOUND" };
const supplied = () => ({ lookup: output("Lookup test"), body_next: output("Body test"), fallback: output("Fallback test"), after: output("Final test") });
const fixtures = (yaml: string, outputs: Record<string, unknown> = supplied(), failures: Record<string, unknown> = {}) => parseProtectedFixtures({ profile: "protected-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs, failures });

test.each([false, true])("protected fixtures evaluate exactly the success/handled path, handled=%s", async handled => {
  const yaml = stringify(source()), outputs = supplied(); if (handled) delete (outputs as any).lookup;
  const data = fixtures(yaml, outputs, handled ? { lookup: fault } : {}), before = structuredClone(data), check = vi.fn(() => true);
  const result = await simulateProtectedWorkflow(yaml, {}, data, [read], role, check);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: "Final test", valueOutputs: { guard: { value: handled ? "Fallback test" : "Body test" } } });
  expect(result.trace.find(entry => entry.nodeId === "after")?.arguments).toEqual({ id: handled ? "Fallback test" : "Body test" });
  expect(result.trace.some(entry => entry.outcome === (handled ? "SIMULATED_HANDLED_ERROR" : "SIMULATED_GROUP_SUCCEEDED"))).toBe(true);
  expect(result.stepOutputs.lookup === undefined).toBe(handled); expect(result.stepOutputs.fallback === undefined).toBe(!handled);
  expect(result.trace.find(entry => entry.nodeId === (handled ? "body_next" : "fallback"))).toMatchObject({ outcome: "NOT_EVALUATED", reason: handled ? "BODY_ABORTED" : "BODY_SUCCEEDED" });
  expect(data).toEqual(before); expect(check).toHaveBeenCalledTimes(3);
  expect(result.trace.every(entry => entry.invocationId === entry.nodeId && entry.iterations.length === 0)).toBe(true);
});

test("protected projection has no publication, provider or capability admission authority", () => {
  const yaml = stringify(source()), plan = compileProtectedFixtureWorkflow(yaml, [read], role);
  expect(plan.profile).toBe("protected-fixture-plan/v1"); expect(JSON.stringify(plan)).not.toMatch(/admission|providerBinding|operation-compiler|workflow-operation-ir/);
  expect(() => compileOperationWorkflow(yaml, [read], role, new Map())).toThrow();
  const bp = parseWorkflowYAMLStrict(yaml), visit = { invocationId: "lookup", iterations: [] };
  expect(() => selectedReadEvidenceYAML(bp, "lookup", { id: "fixture" }, visit, [])).toThrow(/Protected/);
  expect(parseWorkflowYAMLStrict(selectedProtectedFixtureEvidenceYAML(bp, "lookup", { id: "fixture" }, visit, [])).metadata?.controlFlow).toBeUndefined();
});

test.each(["approval", "onError", "body", "handler", "provider", "runtimePlan"])("fixture request rejects extra authority field %s", key => {
  const data: any = fixtures(stringify(source())); data[key] = true; expect(() => parseProtectedFixtures(data)).toThrow();
});
test.each([{ kind: "business-read-error", code: "PERMISSION_DENIED" }, { ...fault, retryable: true }, { ...fault, approval: true }])("fault %j cannot simulate a safeguard catch", failure => {
  expect(() => fixtures(stringify(source()), {}, { lookup: failure })).toThrow();
});
test("conflicting output/fault and wrong iteration identities are rejected", async () => {
  const yaml = stringify(source()); expect(() => fixtures(yaml, supplied(), { lookup: fault })).toThrow();
  await expect(simulateProtectedWorkflow(yaml, {}, fixtures(yaml, { "each/0/lookup": output("x") }), [read], role)).rejects.toThrow(/scope/);
});
test.each(["missing", "generic-error", "forged-remote-error", "wrong-schema", "rule-denial"])("%s stops without selecting a handler", async damage => {
  const yaml = stringify(source()), outputs: Record<string, unknown> = supplied();
  if (damage === "missing") delete outputs.lookup;
  if (damage === "generic-error") outputs.lookup = { content: [], isError: true };
  if (damage === "forged-remote-error") outputs.lookup = { content: [], isError: true, _meta: { "com.erpbridge/error": { type: "not_found", retryable: false } } };
  if (damage === "wrong-schema") outputs.lookup = { content: [], structuredContent: { text: 7 } };
  const result = await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, outputs), [read], role, () => damage !== "rule-denial");
  expect(result.outcome).toBe("SIMULATED_STOPPED"); expect(result.stepOutputs.fallback).toBeUndefined(); expect(result.valueOutputs.guard).toBeUndefined();
  expect(result.trace.some(entry => entry.outcome === "SIMULATED_HANDLER_SELECTED")).toBe(false);
});
test("a handler failure stays visible and never fabricates a group or final answer", async () => {
  const yaml = stringify(source()), result = await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, {}, { lookup: fault, fallback: fault }), [read], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "UNHANDLED_FIXTURE_BUSINESS_ERROR" });
  expect(result.trace.some(entry => entry.outcome === "SIMULATED_HANDLER_FAILED")).toBe(true); expect(result.valueOutputs.guard).toBeUndefined(); expect(result.finalOutput).toBeUndefined();
});
test.each([false, null, 0])("body Return preserves %j and bypasses group output and handler", async value => {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0];
  group.body.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: value === null ? "null" : typeof value }, value: { kind: "literal", value } } });
  const yaml = stringify(src), result = await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, {}), [read], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: value, usedFixtureIds: [] }); expect(result.valueOutputs.guard).toBeUndefined();
  expect(result.trace.some(entry => entry.outcome === "SIMULATED_GROUP_RETURNED")).toBe(true);
});
test("a draft with absent business-error mapping stays blocked, even with a plausible success fixture", async () => {
  const yaml = stringify(source()), tool = { ...read, read_error_contract: undefined };
  expect(await simulateProtectedWorkflow(yaml, {}, fixtures(yaml), [tool], role)).toMatchObject({ outcome: "PLAN_BLOCKED", usedFixtureIds: [] });
});
test("failed-body values cannot become handler sources", async () => {
  const src = source(); src.steps[2].parameters.id = "{{lookup.structuredContent.text}}"; const yaml = stringify(src);
  expect(await simulateProtectedWorkflow(yaml, {}, fixtures(yaml), [read], role)).toMatchObject({ outcome: "PLAN_BLOCKED" });
});
test("nested handler failure propagates only into an authored outer body", async () => {
  const src = source(), inner = src.metadata.controlFlow.root.nodes[0];
  src.steps.splice(3, 0, { id: "outer_fallback", action: read.name, parameters: { id: "{{outer.error.failedNodeId}}" } }); src.steps.at(-1).parameters.id = "{{outer.value}}";
  src.metadata.controlFlow.root.nodes[0] = { kind: "protect", id: "outer", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: seq(inner), handler: seq(action("outer_fallback")),
    output: { schema: { type: "string" }, success: ref("guard", "value"), handled: ref("outer_fallback", "structuredContent", "text") } };
  const yaml = stringify(src), result = await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, { outer_fallback: output("Outer fallback"), after: output("Final") }, { lookup: fault, fallback: fault }), [read], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", valueOutputs: { outer: { value: "Outer fallback" } } }); expect(result.valueOutputs.guard).toBeUndefined();
  expect(result.trace.find(entry => entry.nodeId === "outer_fallback")?.arguments).toEqual({ id: "fallback" });
});

test.each([false, true])("a selected decision exports only its typed protected branch value, selected=%s", async selected => {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0];
  src.trigger.config = { inputSchema: { type: "object", properties: { selected: { type: "boolean" } }, required: ["selected"], additionalProperties: false } };
  src.metadata.controlFlow.root.nodes[0] = { kind: "if", id: "choice", predicate: { kind: "ref", source: "workflowInput", path: ["selected"] },
    then: seq(group), else: seq(), merge: { schema: { type: "string" }, then: ref("guard", "value"), else: { kind: "literal", value: "Body not selected" } } };
  src.steps[3].parameters.id = "{{choice.value}}";
  const yaml = stringify(src), outputs = selected ? supplied() : { after: output("Final test") };
  const result = await simulateProtectedWorkflow(yaml, { selected }, fixtures(yaml, outputs), [read], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: "Final test", valueOutputs: { choice: { value: selected ? "Body test" : "Body not selected" } } });
  expect(result.trace.find(entry => entry.nodeId === "after")?.arguments).toEqual({ id: selected ? "Body test" : "Body not selected" });
  expect(result.usedFixtureIds.includes("lookup")).toBe(selected);
  expect(result.trace.filter(entry => ["choice", "guard", "answer"].includes(entry.nodeId)).every(entry => Number.isInteger(entry.sourceIndex))).toBe(true);
});
function loopSource(): any {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0]; src.steps.pop(); src.steps[0].parameters.id = "{{each.item}}";
  src.trigger.config = { inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false } };
  src.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 2, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(group), collect: { schema: { type: "string" }, value: ref("guard", "value") } }, { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("each", "value") } });
  return src;
}
test("protected collections require exact per-item fixtures and keep mixed path outputs separate", async () => {
  const yaml = stringify(loopSource()), data = fixtures(yaml, { "each/0/fallback": output("First handled"), "each/1/lookup": output("Second lookup"), "each/1/body_next": output("Second body") }, { "each/0/lookup": fault });
  const result = await simulateProtectedWorkflow(yaml, { items: ["A", "B"] }, data, [read], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: ["First handled", "Second body"], valueOutputs: { "each/0/guard": { value: "First handled" }, "each/1/guard": { value: "Second body" } } });
  expect(result.trace.find(entry => entry.invocationId === "each/1/lookup")?.arguments).toEqual({ id: "B" });
  await expect(simulateProtectedWorkflow(yaml, { items: ["A"] }, fixtures(yaml, { lookup: output("reuse forbidden") }), [read], role)).rejects.toThrow(/scope/);
});
test.each([[[]], [["A", "B", "C"]]])("empty/oversized collection %j never fabricates item work", async items => {
  const yaml = stringify(loopSource()), result = await simulateProtectedWorkflow(yaml, { items }, fixtures(yaml, {}), [read], role);
  expect(result.usedFixtureIds).toEqual([]); expect(result.outcome).toBe(items.length ? "SIMULATED_STOPPED" : "SIMULATED_COMPLETE");
  if (!items.length) expect(result.finalOutput).toEqual([]); else expect(result.reason).toBe("COLLECTION_LIMIT_EXCEEDED");
});

test("authoring advertises an exact test-only profile and only safe mapped read faults", () => {
  const bp = parseWorkflowYAMLStrict(stringify(source()));
  const guide = readAuthoringContract(bp, [read], role, "test-registry");
  expect(guide.protectedSimulationProfile).toBe("protected-fixtures/v1");
  expect(guide.nodes.every(node => "simulatedBusinessReadErrorCodes" in node && node.simulatedBusinessReadErrorCodes.includes("ERP_RESOURCE_NOT_FOUND"))).toBe(true);
  const unmapped = readAuthoringContract(bp, [{ ...read, read_error_contract: undefined }], role, "test-registry");
  expect(unmapped.nodes.every(node => "simulatedBusinessReadErrorCodes" in node && node.simulatedBusinessReadErrorCodes.length === 0)).toBe(true);
});

test.each(["analysis", "agent"])("protected %s answers are supplied typed data with completion/input checks, never dynamic tool use", async kind => {
  const src = source(); src.steps[3] = { id: "after", kind, instruction: "Summarize supplied group value", input: { value: "{{guard.value}}" }, data_class: "internal",
    max_input_chars: 100, output_schema: { type: "object", properties: { text: { type: "string" }, complete: { type: "boolean" } }, required: ["text", "complete"], additionalProperties: false },
    ...(kind === "agent" ? { allowed_actions: [read.name], completion_predicate: { path: ["complete"], equals: true } } : {}) };
  const yaml = stringify(src), outputs = { ...supplied(), after: { structuredContent: { text: "Supplied summary", complete: true } } };
  const result = await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, outputs), [read], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: "Supplied summary" });
  expect(result.trace.find(entry => entry.nodeId === "after")).toMatchObject({ kind, outcome: "SUPPLIED_MODEL_OUTPUT", arguments: { value: "Body test" } });
  const invalid = { ...outputs, after: { structuredContent: { text: 42, complete: true } } };
  expect(await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, invalid), [read], role)).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "FIXTURE_OUTPUT_INVALID" });
  if (kind === "agent") expect(await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, { ...outputs, after: { structuredContent: { text: "Not complete", complete: false } } }), [read], role)).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "FIXTURE_AGENT_INCOMPLETE" });
  outputs.body_next = output("A".repeat(150));
  expect(await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, outputs), [read], role)).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "MODEL_INPUT_LIMIT_EXCEEDED" });
});

test("supplied effect outputs never grant approval and cannot be business-fault sources", async () => {
  const effect = toolSchema.parse({ ...read, tool_id: "fixture-effect", name: "fixture.effect", mcp_tool_name: "fixture.effect", is_read_only: false,
    risk_level: "medium", side_effects: ["Synthetic effect"], read_error_contract: undefined,
    operation_contract: { profile: "operation-result/v1", effect_class: "write", retry_policy: "never", confirmation: { path: ["text"], expected: "Final test", meaning: "operation-confirmed" } } });
  const src = source(); src.steps[3].action = effect.name; const yaml = stringify(src);
  const result = await simulateProtectedWorkflow(yaml, {}, fixtures(yaml), [read, effect], role);
  expect(result.outcome).toBe("SIMULATED_COMPLETE"); expect(result.trace.find(entry => entry.nodeId === "after")?.outcome).toBe("SUPPLIED_EFFECT_OUTPUT_NOT_APPROVED");
  const values: Record<string, unknown> = supplied(); delete values.after;
  await expect(simulateProtectedWorkflow(yaml, {}, fixtures(yaml, values, { after: fault }), [read, effect], role)).rejects.toThrow(/mapped/);
});

test("redacted required output fields cannot be used as successful protected values", async () => {
  const outputSchema = { type: "object", properties: { text: { type: "string" }, api_token: { type: "string" } }, required: ["text", "api_token"], additionalProperties: false };
  const tool = { ...read, bridge_contract: { ...read.bridge_contract!, output_schema: outputSchema } }, src = source();
  src.steps[1].parameters.id = "{{lookup.structuredContent.api_token}}"; const yaml = stringify(src);
  const outputs = { lookup: { content: [], structuredContent: { text: "Test", api_token: "never-display-this-secret" } } };
  const result = await simulateProtectedWorkflow(yaml, {}, fixtures(yaml, outputs), [tool], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "BINDING_UNAVAILABLE_OR_LIMITED" });
  expect(JSON.stringify(result)).not.toContain("never-display-this-secret"); expect(result.valueOutputs.guard).toBeUndefined();
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function httpFixture() {
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "protected-simulation-test-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const repository = await Repository.open(null), yaml = stringify(source());
  const registries = { snapshot: () => ({ tools: [read], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => "registry-v1", findTool: () => read, enabledRules: () => [] } as unknown as RegistryService;
  const validator = new RegistryValidator(registries, repository), query = vi.fn(() => { throw new Error("No inference in fixture simulation"); });
  await repository.mutate(state => {
    state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", status: "Active", permissionOverrides: [], initials: "A", departmentId: null, lastLoginAt: null, createdAt: "now" };
    state.workflows.sim = { id: "sim", name: "Fixture", description: "Fixture", owner: { id: "actor", name: "Actor" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 4,
      successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: "now", updatedAt: "now", yaml, archived: false };
  });
  const executor = new Executor(new ToolRegistry(), validator), execute = vi.spyOn(executor, "run");
  const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime: { configured: true, queryWithTools: query } as unknown as ProviderRuntime }); apps.push(app);
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: "actor", expiresIn: 3600 })}` };
  const payload = { dryRun: true, simulation: fixtures(yaml, { fallback: output("Handled"), after: output("Final") }, { lookup: fault }) };
  return { repository, query, execute, payload, run: (body: any = payload, auth = true) => app.inject({ method: "POST", url: "/api/workflows/sim/run", ...(auth ? { headers } : {}), payload: body }) };
}
test("normal HTTP protected simulation returns explicit test boundaries and never saves a run or dispatches", async () => {
  const s = await httpFixture(), before = await s.repository.snapshot(), response = await s.run(); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ simulation: "fixture-protected/v1", outcome: "SIMULATED_COMPLETE", erp_calls: 0, model_calls: 0, persisted_run: false, can_execute: false,
    approval: "not_granted", handler_selection: "supplied_test_fault_only", erp_absence: "not_established", effect_behavior: "not_tested" });
  expect(s.query).not.toHaveBeenCalled(); expect(s.execute).not.toHaveBeenCalled(); const after = await s.repository.snapshot();
  for (const field of ["workflows", "versions", "executions", "timelines", "readJobs", "executionEvents", "invocationProvenance"] as const) expect(after[field]).toEqual(before[field]);
});
test.each(["stale", "not-dry", "unauthenticated", "async-read", "idempotency"])("HTTP protected simulation rejects %s", async scenario => {
  const s = await httpFixture(), payload: any = structuredClone(s.payload);
  if (scenario === "stale") payload.simulation.baseVersion = 2;
  if (scenario === "not-dry") payload.dryRun = false;
  if (scenario === "async-read") payload.mode = "async-read";
  if (scenario === "idempotency") payload.idempotencyKey = "not-a-real-admission-0001";
  expect((await s.run(payload, scenario !== "unauthenticated")).statusCode).toBeGreaterThanOrEqual(400);
  expect(s.query).not.toHaveBeenCalled(); expect(s.execute).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});
