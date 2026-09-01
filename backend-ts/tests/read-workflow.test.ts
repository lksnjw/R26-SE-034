import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
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

async function setup(options: { noBridge?: boolean; roleId?: string; provider?: boolean; write?: boolean } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "read-workflow-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }),
    erpbridgeRoleMap: { "Platform Admin": "admin", Client: "client" } };
  const repository = new Repository(null);
  const tool = toolSchema.parse({ tool_id: "READ-1", name: "finance.read", mcp_tool_name: "invoice-read", allowed_roles: ["Platform Admin", "Client"],
    is_read_only: !options.write, input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
  let hash = "sha256:registry-v1";
  const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => hash,
    findTool: (name: string) => [tool.name, tool.mcp_tool_name].includes(name) ? tool : undefined, findRule: () => undefined, enabledRules: () => [] } as unknown as RegistryService;
  const validator = new RegistryValidator(registries, repository);
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<unknown> => ({ content: [], structuredContent: { id: "invoice-actual" } }));
  const listTools = vi.fn(async () => [{ name: tool.mcp_tool_name, inputSchema: tool.input_schema }]);
  const erpbridgeSession = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture-only", timeoutMs: 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools, callTool } });
  const queryWithTools = vi.fn(async () => { throw new Error("Published reads must never invoke the model"); });
  const services = { config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator),
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
  expect(execution.status).toBe("FAILED");
  expect(execution.failure?.failedStepId).toBe(scenario === "missing-output" ? "details" : "lookup");
  expect(s.callTool).toHaveBeenCalledTimes(["missing-input", "invalid-input"].includes(scenario) ? 0 : 1);
  expect(JSON.stringify(state.executions)).not.toContain("private-remote-error");
  expect(state.timelines[execution.id]?.at(-1)?.status).toBe("FAILED");
  if (scenario === "missing-output") expect(execution.finalOutput).toEqual({ content: [], structuredContent: {} });
  else expect(execution.finalOutput).toBeUndefined();
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
