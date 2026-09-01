import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Executor } from "../src/runner/executor.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";

async function setup(options: { write?: boolean; schema?: Record<string, unknown>; roles?: string[]; result?: unknown } = {}) {
  const tool = toolSchema.parse({ tool_id: "READ-1", name: "finance.read", mcp_tool_name: "finance.read", allowed_roles: options.roles ?? ["Workflow Builder"],
    is_read_only: !options.write, input_schema: options.schema ?? { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
  const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => "sha256:test",
    findTool: (name: string) => name === tool.name ? tool : undefined, findRule: () => undefined, enabledRules: () => [] } as unknown as RegistryService;
  const repository = new Repository(null);
  await repository.mutate((state) => { state.users.builder = { id: "builder", name: "Builder", email: "builder@example.test", roleId: "role_builder", permissionOverrides: [],
    status: "Active", initials: "B", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  const validator = new RegistryValidator(registries, repository);
  const callTool = vi.fn(async () => options.result ?? { content: [], structuredContent: { id: "invoice-1" } });
  const erpbridgeSession = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "test-token", timeoutMs: 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => [{ name: tool.mcp_tool_name, inputSchema: tool.input_schema }], callTool } });
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "test-broker-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }),
    erpbridgeRoleMap: { "Workflow Builder": "workflow_builder" } };
  return { services: { config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), erpbridgeSession }, callTool };
}

test("approved read consumes real capability and injects only backend-mapped role", async () => {
  const s = await setup();
  const args = { id: "invoice-1" };
  await expect(dispatchReadTool(s.services, "builder", "finance.read", args)).resolves.toMatchObject({ structuredContent: { id: "invoice-1" } });
  expect(s.callTool).toHaveBeenCalledExactlyOnceWith("finance.read", { id: "invoice-1", role: "workflow_builder" });
  expect(args).toEqual({ id: "invoice-1" });
});

test.each(["unknown", "role", "missing", "wrong-type", "extra", "write", "ungranted", "disabled", "no-bridge", "unsupported-schema", "nested"])("%s blocks before SDK dispatch", async (scenario) => {
  const s = await setup({ write: scenario === "write", ...(scenario === "ungranted" ? { roles: ["Platform Admin"] } : {}),
    ...(scenario === "unsupported-schema" ? { schema: { type: "object", allOf: [{ type: "object" }] } } : {}),
    ...(scenario === "nested" ? { schema: { type: "object", properties: { payload: { type: "object", properties: { amount: { type: "number" } } } } } } : {}) });
  const args: Record<string, unknown> = scenario === "missing" ? {} : scenario === "wrong-type" ? { id: 2 } : scenario === "extra" ? { id: "x", extra: true }
    : scenario === "role" ? { id: "x", role: "admin" } : scenario === "nested" ? { payload: { amount: "bad" } } : { id: "x" };
  if (scenario === "disabled") await s.services.repository.mutate((state) => { state.users.builder!.status = "Disabled"; });
  const { erpbridgeSession, ...withoutBridge } = s.services;
  await expect(dispatchReadTool(scenario === "no-bridge" ? withoutBridge : s.services, "builder", scenario === "unknown" ? "unknown" : "finance.read", args)).rejects.toThrow();
  expect(s.callTool).not.toHaveBeenCalled();
});

test("revocation during deterministic verification invalidates dispatch", async () => {
  const s = await setup();
  const original = s.services.validator.evaluateResolvedStep.bind(s.services.validator);
  vi.spyOn(s.services.validator, "evaluateResolvedStep").mockImplementation(async (...args) => {
    const result = await original(...args);
    await s.services.repository.mutate((state) => { state.users.builder!.status = "Disabled"; });
    return result;
  });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" })).rejects.toThrow("authority changed");
  expect(s.callTool).not.toHaveBeenCalled();
});

test("MCP error envelope fails rather than becoming a successful read", async () => {
  const s = await setup({ result: { content: [{ type: "text", text: "denied" }], isError: true } });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" })).rejects.toThrow();
  expect(s.callTool).toHaveBeenCalledTimes(1);
});

test("credential fields are removed from structured and JSON-text results before exposure", async () => {
  const s = await setup({ result: { content: [{ type: "text", text: JSON.stringify({ records: [{ id: "x", api_key: "private" }] }) }], structuredContent: { id: "x", nested: { token: "private" } } } });
  const result = await dispatchReadTool(s.services, "builder", "finance.read", { id: "x" });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.structuredContent).toEqual({ id: "x", nested: {} });
});
