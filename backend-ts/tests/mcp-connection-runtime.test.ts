import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import jwt from "jsonwebtoken";
import { Repository, type PersistenceBackend } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { loadConfig } from "../src/config/config.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { McpConnectionRuntime } from "../src/tools/mcp-connection-runtime.js";
import type { McpNotificationState } from "../src/tools/mcp-notification-stream.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { capabilityContractHash, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { buildApp } from "../src/http/app.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";

const runtimes: { stop(): Promise<unknown> }[] = [], apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); await Promise.all(runtimes.splice(0).map(runtime => runtime.stop())); vi.restoreAllMocks(); });
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null; loseAck = false;
  async load() { return this.payload; }
  async save(value: Uint8Array) { this.payload = Buffer.from(value); if (this.loseAck) { this.loseAck = false; throw new Error("Lost commit acknowledgement"); } }
  async close() {} async probe() {}
}
function config() { return loadConfig({ APP_ENV: "test", JWT_SECRET: "mcp-runtime-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
  ERPBRIDGE_BASE_URL: "https://fixture.example.test", ERPBRIDGE_MCP_TOKEN: "fixture-private-credential", ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"fixture_reader"}', MCP_TIMEOUT_MS: "1000" }); }
async function setup(persistence: PersistenceBackend | null = null) {
  const repository = await Repository.open(persistence), timestamp = new Date().toISOString();
  await repository.mutate(state => { for (const [id, roleId] of [["admin", "role_admin"], ["builder", "role_builder"]]) state.users[id!] = { id: id!, roleId: roleId!, name: id!, email: `${id}@example.test`, status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: timestamp, permissionOverrides: [] }; });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const original = registries.snapshot(), tool = toolSchema.parse({ ...original.tools[0], bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [] } });
  vi.spyOn(registries, "snapshot").mockReturnValue({ ...original, tools: [tool] }); vi.spyOn(registries, "hash").mockReturnValue(capabilityContractHash(tool));
  vi.spyOn(registries, "findTool").mockImplementation(name => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name) ? tool : undefined);
  const validator = new RegistryValidator(registries, repository), sdkClients: ReturnType<typeof sdk>[] = [];
  function sdk() { return { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    listTools: vi.fn(async () => [{ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), _meta: { "toolplane.resourceDigest": "a".repeat(64), "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } }]),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "Confirmed fixture result" }] })) }; }
  const factory = vi.fn<typeof createErpbridgeMcpSession>(async options => { const client = sdk(); sdkClients.push(client); return createErpbridgeMcpSession({ ...options, sdkClient: client }); });
  const options = { repository, registries, validator, config: config(), factory };
  const runtime = await McpConnectionRuntime.open(options); runtimes.push(runtime);
  const admin = (await repository.effectiveUser("admin"))!, builder = (await repository.effectiveUser("builder"))!;
  const services = { ...options, executor: new Executor(new ToolRegistry(), validator), mcpConnectionRuntime: runtime, get erpbridgeSession() { return runtime.session; } };
  const command = (action: "connect" | "disconnect" | "test", baseRevision: number, requestId = `fixture_${action}_request_0001`) => runtime.command(action, admin, { baseRevision, requestId });
  const connect = () => command("connect", 1);
  const review = async () => { const observation = (await observeCapabilities({ repository, registries, session: runtime.session, user: admin })).observations[0]!;
    return reviewCapability({ repository, registries, session: runtime.session, user: admin, capabilityId: observation.capabilityId,
      body: { observationId: observation.id, contractHash: observation.contractHash, decisionKey: "fixture_review_decision_0001", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Fixture exact read reviewed" } }); };
  return { repository, registries, validator, options, runtime, admin, builder, services, factory, sdkClients, sdk, tool, command, connect, review };
}

test("real runtime connect initializes/discovers without a business call or granting authority; explicit review enables the actual broker", async () => {
  const s = await setup(); expect(s.runtime.session).toBeUndefined(); expect((await s.runtime.status(s.admin)).connections[0]).toMatchObject({ state: "DISCONNECTED", revision: 1, desiredEnabled: false });
  const result = await s.connect(); expect(result.operation).toMatchObject({ state: "DONE", discoveryCount: 1 }); expect(result.connection).toMatchObject({ state: "CONNECTED", revision: 2, initialized: true });
  expect(s.factory).toHaveBeenCalledOnce(); expect(s.sdkClients[0]!.callTool).not.toHaveBeenCalled(); expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0);
  await expect(dispatchReadTool(s.services, "admin", s.tool.name, { value: "fixture" })).rejects.toThrow(/admitted/);
  await s.review(); expect((await dispatchReadTool(s.services, "admin", s.tool.name, { value: "fixture" })).content).toEqual([{ type: "text", text: "Confirmed fixture result" }]); expect(s.sdkClients[0]!.callTool).toHaveBeenCalledOnce();
});

test("disconnect fences captured old clients and a reconnect has a new admission identity without automatic re-review", async () => {
  const s = await setup(); await s.connect(); await s.review(); const old = s.runtime.session!, binding = old.admissionBinding;
  const disconnected = await s.command("disconnect", 2); expect(disconnected.connection).toMatchObject({ state: "DISCONNECTED", revision: 3, initialized: false, desiredEnabled: false });
  expect(s.runtime.session).toBeUndefined(); await expect(old.assertAdmission!(s.tool)).rejects.toThrow(); expect(old.available).toBe(false);
  await s.command("connect", 3, "fixture_connect_request_0002"); expect(s.runtime.session!.admissionBinding).not.toBe(binding);
  await expect(s.runtime.session!.assertAdmission!(s.tool)).rejects.toThrow(/binding changed/); expect(s.sdkClients.every(client => client.callTool.mock.calls.length === 0)).toBe(true);
});

test("fatal notification status reaches administration and fences captured admission/discovery without any business call", async () => {
  const s = await setup(), client = { ...s.sdk(), available: true, notificationState: { state: "ACTIVE", recoveryAttempts: 0 } as McpNotificationState };
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  await s.connect(); await s.review(); const captured = s.runtime.session!;
  expect((await s.runtime.status(s.admin)).connections[0]?.notificationStream).toEqual(client.notificationState);
  client.available = false; client.notificationState = { state: "FAILED", reason: "SESSION_EXPIRED", recoveryAttempts: 1 };
  expect(s.runtime.session).toBeUndefined(); expect(captured.available).toBe(false);
  await expect(captured.assertAdmission!(s.tool)).rejects.toThrow(/unavailable/); await expect(captured.listTools()).rejects.toThrow(/unavailable/);
  const status = await s.runtime.status(s.admin); expect(status.connections[0]).toMatchObject({ state: "DEGRADED", initialized: false, discoveryAvailable: false, notificationStream: client.notificationState });
  expect(JSON.stringify(status)).not.toContain("fixture-private-credential"); expect(client.callTool).not.toHaveBeenCalled();
});

test("exact connect retries after disconnect return history/current state without reconnecting; request conflicts and stale commands have no side effect", async () => {
  const s = await setup(); await s.connect(); await s.command("disconnect", 2);
  const repeated = await s.connect(); expect(repeated.duplicate).toBe(true); expect(repeated.operation.state).toBe("DONE"); expect(repeated.connection.state).toBe("DISCONNECTED"); expect(s.factory).toHaveBeenCalledOnce();
  await expect(s.command("connect", 3)).rejects.toMatchObject({ status: 409 });
  await expect(s.command("connect", 1, "different_request_key_0001")).rejects.toMatchObject({ status: 409 });
  expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("DISCONNECTED");
});

test("testing a connection uses a disposable session and does not replace/disable or grant the agent's active connection", async () => {
  const s = await setup(); await s.connect(); const old = s.runtime.session!, binding = old.admissionBinding;
  const tested = await s.command("test", 2); expect(tested.operation).toMatchObject({ state: "DONE", discoveryCount: 1 }); expect(tested.connection.revision).toBe(2);
  expect(s.runtime.session).toBe(old); expect(old.admissionBinding).toBe(binding); expect(old.available).toBe(true); expect(s.sdkClients[1]!.close).toHaveBeenCalled();
  expect(s.sdkClients.every(client => client.callTool.mock.calls.length === 0)).toBe(true);
});

test("disconnect interrupts a hanging connect immediately; late ignored SDK completion cannot publish a session", async () => {
  const s = await setup(); let release: (() => void) | undefined; const client = s.sdk();
  client.connect.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  const connecting = s.connect(); const rejected = expect(connecting).rejects.toMatchObject({ meta: { code: "MCP_OPERATION_INTERRUPTED" } });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("CONNECTING");
  await s.command("disconnect", 2); await rejected; release!(); await vi.waitFor(() => expect(client.close).toHaveBeenCalled());
  expect(s.runtime.session).toBeUndefined(); expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("DISCONNECTED"); expect(client.callTool).not.toHaveBeenCalled();
});

test("revoked administrator during SDK initialization cannot publish readiness and does not expose upstream secrets", async () => {
  const s = await setup(); const client = s.sdk();
  client.listTools.mockImplementation(async () => { await s.repository.mutate(state => { state.users.admin!.status = "Inactive"; }); return []; });
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  await expect(s.connect()).rejects.toMatchObject({ status: 403, meta: { code: "MCP_ACTOR_REVOKED" } }); expect(s.runtime.session).toBeUndefined(); expect(client.close).toHaveBeenCalled();
});

test("bounded failed connect records only safe failure and its exact retry never replays initialization", async () => {
  const s = await setup(); s.factory.mockRejectedValueOnce(new Error("Authorization: Bearer fixture-private-credential upstream-body"));
  try { await s.connect(); throw new Error("Unexpected success"); } catch (error) { expect(String(error)).not.toMatch(/private-credential|upstream-body/); }
  const status = await s.runtime.status(s.admin); expect(status.connections[0]!.state).toBe("DEGRADED"); expect(status.recentOperations[0]).toMatchObject({ state: "FAILED", reason: "MCP_OPERATION_FAILED" });
  expect(status.connections[0]!.desiredEnabled).toBe(false);
  expect(JSON.stringify(status)).not.toMatch(/configurationHash|scope|requestHash|private-credential|upstream-body/);
  expect((await s.connect()).duplicate).toBe(true); expect(s.factory).toHaveBeenCalledOnce();
  const restarted = await McpConnectionRuntime.open(s.options); runtimes.push(restarted); expect(restarted.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledOnce();
});

test("initialization wait is bounded even when an injected dependency ignores cancellation", async () => {
  const s = await setup(); const runtime = await McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, mcpTimeoutMs: 30 }, factory: vi.fn(async () => new Promise<never>(() => {})) }); runtimes.push(runtime);
  await expect(runtime.command("connect", s.admin, { baseRevision: 1, requestId: "fixture_timeout_request_0001" })).rejects.toMatchObject({ meta: { code: "MCP_WAIT_TIMEOUT" } });
  expect((await runtime.status(s.admin)).connections[0]!.state).toBe("DEGRADED");
});

test("lost claim acknowledgement fences the old session until recovery and duplicate pending operation never starts the SDK", async () => {
  const persistence = new Persistence(), s = await setup(persistence); await s.connect(); const old = s.runtime.session!;
  persistence.loseAck = true; await expect(s.command("disconnect", 2)).rejects.toThrow(/acknowledgement/);
  expect(s.runtime.session).toBeUndefined(); await expect(old.assertAdmission!(s.tool)).rejects.toThrow(); await expect(s.runtime.status(s.admin)).rejects.toThrow(/Authoritative/);
  await s.repository.recoverPersistenceState(); const repeated = await s.command("disconnect", 2); expect(repeated.duplicate).toBe(true); expect(repeated.operation.state).toBe("RUNNING"); expect(s.runtime.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledOnce();
  const restarted = await McpConnectionRuntime.open(s.options); runtimes.push(restarted); expect((await restarted.status(s.admin)).recentOperations[0]!.state).toBe("INTERRUPTED"); expect(restarted.session).toBeUndefined();
});

test("lost final acknowledgement closes the candidate and cannot expose a connected old local image", async () => {
  const persistence = new Persistence(), s = await setup(persistence), client = s.sdk();
  client.listTools.mockImplementation(async () => { persistence.loseAck = true; return []; }); s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  await expect(s.connect()).rejects.toThrow(); expect(s.runtime.session).toBeUndefined(); expect(client.close).toHaveBeenCalled(); await s.repository.recoverPersistenceState();
  const repeated = await s.connect(); expect(repeated.operation.state).toBe("DONE"); expect(repeated.connection.initialized).toBe(false); expect(s.factory).toHaveBeenCalledOnce();
});

test("a successful restore candidate is disposed when the final authoritative record check fails", async () => {
  const s = await setup(); await s.connect(); await s.runtime.stop(); const client = s.sdk(), inventory = client.listTools.getMockImplementation()!;
  client.listTools.mockImplementation(async () => { const tools = await inventory(); vi.spyOn(s.repository, "readAuthoritative").mockRejectedValueOnce(new Error("Uncertain repository")); return tools; });
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  const restored = await McpConnectionRuntime.open(s.options); runtimes.push(restored); expect(restored.session).toBeUndefined(); expect(client.close).toHaveBeenCalled();
  expect((await restored.status(s.admin)).connections[0]!.state).toBe("DEGRADED");
});

test("same enabled configuration can restore initialize-only after restart; disabled intent and configuration rotation never auto-connect", async () => {
  const persistence = new Persistence(), s = await setup(persistence); await s.connect(); await s.runtime.stop();
  const restored = await McpConnectionRuntime.open(s.options); runtimes.push(restored); expect(restored.session).toBeDefined(); expect(s.factory).toHaveBeenCalledTimes(2);
  await restored.command("disconnect", s.admin, { baseRevision: 2, requestId: "fixture_restart_disconnect_0001" }); await restored.stop();
  const disabled = await McpConnectionRuntime.open(s.options); runtimes.push(disabled); expect(disabled.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledTimes(2);
  const rotated = await McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, erpbridgeMcpToken: "rotated-private-credential" } }); runtimes.push(rotated);
  expect((await rotated.status(s.admin)).connections[0]).toMatchObject({ state: "DISCONNECTED", desiredEnabled: false, revision: 4 }); expect(s.factory).toHaveBeenCalledTimes(2);
});

test("interrupted disposable test history does not change the separately approved active connection revision on restart", async () => {
  const s = await setup(); await s.connect(); await s.runtime.stop();
  await s.repository.mutate(state => {
    const { completedAt: _completed, ...original } = Object.values(state.mcpConnectionOperations)[0]!;
    state.mcpConnectionOperations.mcpop_interrupted_probe = { ...original, id: "mcpop_interrupted_probe", action: "test", requestId: "fixture_interrupted_test_0001", scope: `sha256:${"b".repeat(64)}`, state: "RUNNING" };
  });
  const restored = await McpConnectionRuntime.open(s.options); runtimes.push(restored);
  const view = await restored.status(s.admin); expect(view.connections[0]).toMatchObject({ revision: 2, state: "CONNECTED", desiredEnabled: true });
  expect(view.recentOperations[0]).toMatchObject({ action: "test", state: "INTERRUPTED" }); expect(s.factory).toHaveBeenCalledTimes(2); expect(s.sdkClients.every(client => client.callTool.mock.calls.length === 0)).toBe(true);
});

test("bad storage/corrupt records need explicit repair and unsupported transport/config never tries a network fallback", async () => {
  const persistence = new Persistence(); Object.defineProperty(persistence, "readQueueDurability", { value: undefined }); const s = await setup(persistence);
  expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("STORAGE_UNSUPPORTED"); await expect(s.connect()).rejects.toMatchObject({ status: 503 }); expect(s.factory).not.toHaveBeenCalled();
  await expect(McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, erpbridgeBaseURL: "https://user:pass@fixture.example.test/path" } })).rejects.toThrow(/not supported/);
  const simple = await setup(); await simple.repository.mutate(state => { state.mcpConnections["erpbridge-default"] = { revision: "wrong" }; });
  await expect(McpConnectionRuntime.open(simple.options)).rejects.toThrow();
});

test("commands reject actor changes, arbitrary endpoint/token input and absent configuration before any initialization", async () => {
  const s = await setup(); await expect(s.runtime.command("connect", s.builder, { baseRevision: 1, requestId: "fixture_builder_request_0001" })).rejects.toMatchObject({ status: 403 });
  await expect(s.runtime.command("connect", s.admin, { baseRevision: 1, requestId: "fixture_injected_request_0001", baseURL: "http://169.254.169.254/", token: "injected" })).rejects.toMatchObject({ status: 400 }); expect(s.factory).not.toHaveBeenCalled();
  const runtime = await McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, mcpTransport: "bridge-v1", erpbridgeBaseURL: "", erpbridgeMcpToken: "" } }); runtimes.push(runtime);
  expect((await runtime.status(s.admin)).connections[0]!.state).toBe("UNCONFIGURED");
  await expect(runtime.command("connect", s.admin, { baseRevision: 2, requestId: "fixture_unconfigured_request_0001" })).rejects.toMatchObject({ status: 503 }); expect(s.factory).not.toHaveBeenCalled();
});

test("HTTP lifecycle uses actual services, stays permission-scoped and legacy generic URL connect cannot probe or fabricate readiness", async () => {
  const s = await setup(), app = await buildApp(s.services); apps.push(app);
  const headers = (actor = "admin") => ({ authorization: `Bearer ${jwt.sign({}, s.options.config.jwtSecret, { subject: actor, expiresIn: 3600 })}` });
  expect((await app.inject({ method: "GET", url: "/api/settings/mcp-connections", headers: headers("builder") })).statusCode).toBe(403);
  const connected = await app.inject({ method: "POST", url: "/api/settings/mcp-connections/erpbridge-default/connect", headers: headers(), payload: { baseRevision: 1, requestId: "fixture_http_connect_request_0001" } });
  expect(connected.statusCode, connected.body).toBe(200); expect(connected.json().data.connection.initialized).toBe(true); expect(s.services.erpbridgeSession).toBeDefined();
  const get = await app.inject({ method: "GET", url: "/api/settings/mcp-connections", headers: headers() }); expect(get.body).not.toMatch(/private-credential|configurationHash|scope|requestHash/);
  const probe = vi.spyOn(globalThis, "fetch"); await s.repository.mutate(state => { state.integrations.unsafe = { id: "unsafe", name: "Metadata", type: "URL", config: { url: "http://169.254.169.254/latest/meta-data/" }, status: "Disconnected" }; });
  const generic = await app.inject({ method: "POST", url: "/api/integrations/unsafe/connect", headers: headers(), payload: {} }); expect(generic.statusCode, generic.body).toBe(501); expect(generic.json().meta.code).toBe("INTEGRATION_ADAPTER_REQUIRED"); expect(probe).not.toHaveBeenCalled();
  expect(s.sdkClients[0]!.callTool).not.toHaveBeenCalled();
});
