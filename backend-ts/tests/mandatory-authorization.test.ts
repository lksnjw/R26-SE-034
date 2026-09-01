import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Workflow } from "../src/models/schemas.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup(enabled: boolean, providerRuntime?: ProviderRuntime) {
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "mandatory-auth-test-secret-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const repository = new Repository(null);
  await repository.mutate((state) => {
    state.settings.rbac = { enabled };
    for (const [id, roleId] of [["client", "role_client"], ["admin", "role_admin"]]) {
      state.users[id!] = { id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, permissionOverrides: [], status: "Active", initials: "T", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
    }
    state.workflows.other = workflow("other", "admin");
  });
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository);
  const listTools = vi.fn(async () => []);
  const callToolDirect = vi.fn(async () => ({}));
  const app = await buildApp({ config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), ...(providerRuntime ? { providerRuntime } : {}), erpbridgeSession: { listTools, callToolDirect, close: async () => {}, clientFor: () => { throw new Error("No dispatch expected"); } } });
  apps.push(app);
  const headers = (id: string) => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  return { app, repository, registries, validator, headers, listTools, callToolDirect };
}

function workflow(id: string, ownerId: string, yaml = "name: Test\ndescription: A test workflow\ntrigger:\n  type: manual\nsteps:\n - id: bad\n   action: nonexistent.tool\n"): Workflow {
  const now = new Date().toISOString();
  return { id, name: "Test", description: "Test workflow", owner: { id: ownerId, name: ownerId }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: now, updatedAt: now, yaml, archived: false };
}

describe.each([false, true])("mandatory authorization with advisory policy enabled=%s", (enabled) => {
  test("client cannot access administration, credentials or workflow writes", async () => {
    const s = await setup(enabled);
    for (const [method, url] of [["GET", "/api/users"], ["GET", "/api/settings"], ["GET", "/api/profile/api-keys"], ["GET", "/api/providers"], ["POST", "/api/workflows"], ["POST", "/api/import/commit"]] as const) {
      const response = await s.app.inject({ method, url, headers: s.headers("client"), ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(s.listTools).not.toHaveBeenCalled();
    expect(s.callToolDirect).not.toHaveBeenCalled();
  });
  test("unassigned run is denied before validation, discovery or dispatch", async () => {
    const s = await setup(enabled);
    const validation = vi.spyOn(s.validator, "validateAndIssueToken");
    const response = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("client"), payload: {} });
    expect(response.statusCode).toBe(403);
    expect(validation).not.toHaveBeenCalled();
    expect(s.listTools).not.toHaveBeenCalled();
    expect(s.callToolDirect).not.toHaveBeenCalled();
    expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(0);
  });
  test("admin access and client self-service still work", async () => {
    const s = await setup(enabled);
    expect((await s.app.inject({ method: "GET", url: "/api/settings", headers: s.headers("admin") })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: s.headers("client") })).statusCode).toBe(200);
  });
});

test("malformed or unknown-tool run is rejected before provider or ERP discovery", async () => {
  const s = await setup(false);
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("admin"), payload: {} });
  expect(response.statusCode).toBe(422);
  expect(response.json().message).toBe("Workflow validation failed");
  expect(s.listTools).not.toHaveBeenCalled();
  expect(s.callToolDirect).not.toHaveBeenCalled();
});

test("generation acceptance preserves exact YAML, version and runtime checkpoints", async () => {
  const s = await setup(false);
  const yaml = "name: Approval\ndescription: Require a person to approve each run\ntrigger:\n  type: manual\nsteps:\n - id: approve\n   kind: approval\n   description: Manager approves this transaction\n";
  await s.repository.mutate((state) => { state.workflows.approval = { ...workflow("approval", "admin", yaml), pendingGenerationApproval: { steps: [{ stepId: "approve", description: "Manager approves this transaction" }], requestedAt: new Date().toISOString() } }; });
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/approval/approve-generation", headers: s.headers("admin"), payload: {} });
  expect(response.statusCode, response.body).toBe(200);
  const saved = (await s.repository.snapshot()).workflows.approval!;
  expect(saved.yaml).toBe(yaml);
  expect(saved.draftVersion).toBe(1);
  expect(saved.pendingGenerationApproval).toBeNull();
  expect(saved.generationApprovals).toHaveLength(1);
  const run = await s.app.inject({ method: "POST", url: "/api/workflows/approval/run", headers: s.headers("admin"), payload: {} });
  expect(run.statusCode).toBe(409);
  expect(run.json().meta.code).toBe("RUNTIME_APPROVAL_EXECUTOR_REQUIRED");
  expect(s.listTools).not.toHaveBeenCalled();
  expect(s.callToolDirect).not.toHaveBeenCalled();
});

test("legacy approval resume cannot grant approval or dispatch through a model prompt", async () => {
  const s = await setup(false);
  await s.repository.mutate((state) => { state.executions.legacy = { id: "legacy", workflowId: "other", workflowName: "Legacy", status: "AWAITING_APPROVAL",
    startedAt: new Date().toISOString(), completedAt: null, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0,
    startedBy: { id: "admin", name: "Admin" }, pendingApproval: { stepId: "approve", description: "Approve payment", requestedAt: new Date().toISOString() } }; });
  const before = structuredClone((await s.repository.snapshot()).executions.legacy);
  const response = await s.app.inject({ method: "POST", url: "/api/executions/legacy/approve", headers: s.headers("admin"), payload: { note: "Approved" } });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().meta.code).toBe("RUNTIME_APPROVAL_EXECUTOR_REQUIRED");
  expect((await s.repository.snapshot()).executions.legacy).toEqual(before);
  expect(s.listTools).not.toHaveBeenCalled();
  expect(s.callToolDirect).not.toHaveBeenCalled();
});

const readYaml = "name: Read\ndescription: Read echo\ntrigger:\n  type: manual\nsteps:\n - id: read\n   action: demo.echo\n   parameters:\n     value: test\n";
test("accepting a valid candidate creates a draft, not an executable publication", async () => {
  const s = await setup(false);
  const response = await s.app.inject({ method: "POST", url: "/api/workflows", headers: s.headers("admin"), payload: { candidate: { yaml: readYaml } } });
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json().data.id;
  const snapshot = await s.repository.snapshot();
  expect(snapshot.workflows[id]).toMatchObject({ yaml: readYaml, publishedVersion: 0, draftVersion: 1, canRun: false });
  expect(snapshot.versions[id]?.[0]?.artifactState).toBe("DRAFT");
  const run = await s.app.inject({ method: "POST", url: `/api/workflows/${id}/run`, headers: s.headers("admin"), payload: {} });
  expect(run.statusCode, run.body).toBe(409);
  expect(run.json().meta.code).toBe("WORKFLOW_NOT_PUBLISHED");
  expect(s.listTools).not.toHaveBeenCalled();
});

test.each(["no-actions", "callback-error", "policy-denial"])("normal run stores FAILED for %s even if the model claims success", async (scenario) => {
  const queryWithTools = vi.fn(async () => ({ text: "Completed successfully", toolCalls: scenario === "no-actions" ? [] : [{ id: "call1", name: "demo.echo", arguments: { value: "test" } }],
    stopReason: scenario === "no-actions" ? "stop" : "tool_calls", inputTokens: 2, outputTokens: 3 }));
  const s = await setup(false, { configured: true, queryWithTools } as unknown as ProviderRuntime);
  const tool = { ...s.registries.snapshot().tools[0]!, allowed_roles: ["Platform Admin"], is_read_only: scenario !== "policy-denial" };
  const snapshot = s.registries.snapshot();
  vi.spyOn(s.registries, "snapshot").mockReturnValue({ ...snapshot, tools: [tool] });
  vi.spyOn(s.registries, "findTool").mockImplementation((name) => name === tool.name ? tool : undefined);
  s.listTools.mockResolvedValue([{ name: "demo.echo", inputSchema: tool.input_schema }] as never);
  await s.repository.mutate((state) => {
    state.workflows.other = { ...workflow("other", "admin", readYaml), publishedVersion: 1 };
    state.versions.other = [{ version: 1, artifactState: "PUBLISHED", yaml: readYaml }];
  });
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("admin"), payload: {} });
  expect(response.statusCode, response.body).toBe(422);
  const state = await s.repository.snapshot();
  const execution = Object.values(state.executions)[0]!;
  expect(execution.status).toBe("FAILED");
  expect(execution.agentSummary).not.toBe("Completed successfully");
  expect(execution.stepOutputs).toEqual({});
  if (scenario !== "no-actions") expect(state.timelines[execution.id]?.[0]?.status).toBe("FAILED");
  expect(queryWithTools).toHaveBeenCalledTimes(1);
});

test("editing a published draft invalidates the runnable snapshot before discovery", async () => {
  const s = await setup(false);
  await s.repository.mutate((state) => {
    state.workflows.other = { ...workflow("other", "admin", readYaml), publishedVersion: 1 };
    state.versions.other = [{ version: 1, artifactState: "PUBLISHED", yaml: readYaml.replace("value: test", "value: old") }];
  });
  const run = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("admin"), payload: {} });
  expect(run.statusCode, run.body).toBe(409);
  expect(run.json().meta.code).toBe("PUBLISHED_SNAPSHOT_REQUIRED");
  expect(s.listTools).not.toHaveBeenCalled();
});
