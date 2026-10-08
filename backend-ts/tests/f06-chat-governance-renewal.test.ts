import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { withFunctionResources, withFunctionRuntime } from "../src/firebase/invocation.js";
import { executeFunctionChatTask } from "../src/firebase/chat-task.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { GovernanceAdapter } from "../src/governance/adapter.js";
import { GovernanceService } from "../src/governance/service.js";
import { GovernedValidationGate } from "../src/governance/gate.js";
import type { ApplicationResources } from "../src/entrypoints/application-runtime.js";
import type { ChatTaskCommand } from "../src/agent/chat-task-outbox.js";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";

const fixture = vi.hoisted(() => ({ database: null as Database | null, clients: [] as FakeClient[], construct: vi.fn() }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class {
  constructor(settings: unknown) { const client = new FakeClient(fixture.database!, settings); fixture.clients.push(client); return client; }
}, default: { v1: { FirestoreClient: class { constructor(settings: unknown) { return new FakeStopClient(fixture.database!, settings); } } } } }));
vi.mock("../src/entrypoints/application-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/entrypoints/application-runtime.js")>(), constructApplicationRuntime: fixture.construct,
}));

test.each(["same-policy", "same-policy-ttl-zero", "policy-version-changed", "evidence-changed"] as const)(
  "F06 governed read binds semantic policy and fences real changes (%s)", async scenario => {
  fixture.database = new Database(); fixture.clients = [];
  FakeStopClient.instances = []; FakeStopClient.hold = false; FakeStopClient.onRead = undefined;
  const temporary = await mkdtemp(join(tmpdir(), "f06-governance-renewal-")), policyPath = join(temporary, "policy.json");
  await writeFile(policyPath, await readFile(resolve("policy/governance_fallback.json"), "utf8"));
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", MCP_MODE: "mock", FIRESTORE_PROJECT_ID: "demo-f06-governance",
    FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "f06_governance_fixture", STORAGE_ENCRYPTION_KEY: "f".repeat(32),
    JWT_SECRET: "f06-governance-synthetic-secret-32-bytes", GOVERNANCE_FALLBACK_POLICY_PATH: policyPath });
  config.toolRegistryPath = resolve("tests/fixtures/chat-read-tools.json"); config.ruleRegistryPath = resolve("tests/fixtures/rules.json");
  config.erpbridgeRoleMap = { "Platform Admin": "admin" };
  const sent: ChatTaskCommand[] = [], bridges: Array<{ close(): Promise<void> }> = [];
  const modelTurns: string[] = [];
  const sdkCall = vi.fn(async () => ({ content: [], structuredContent: { value: "eight synthetic rows" } }));
  let policyFetches = 0;
  const governanceFetch = vi.fn<typeof fetch>(async () => {
    const renewed = ++policyFetches === 2;
    return Response.json({ policyVersion: renewed && scenario === "policy-version-changed" ? "changed-reviewed-policy" : "same-reviewed-policy",
      rules: [], evidenceIds: renewed && scenario === "evidence-changed" ? ["changed-evidence"] : ["same-evidence"] });
  });
  const ttl = scenario === "same-policy-ttl-zero" ? 0 : 60_000;
  const composition = { config, root: process.cwd(), transport: { timeoutMs: 1000,
    enqueue: vi.fn(async (command: { taskId: string }) => ({ taskId: command.taskId, outcome: "CREATED" as const })) },
    chatTransport: { timeoutMs: 1000, enqueue: vi.fn(async (command: ChatTaskCommand) => {
      sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" as const };
    }) } };
  const adapter = () => new GovernanceAdapter({ url: "https://f06-policy.example.test/evaluate", apiKey: "synthetic-governance-key",
    timeoutMs: 1000, source: "primary", fetchImplementation: governanceFetch });
  fixture.construct.mockImplementation(async ({ repository, registries }: ApplicationResources) => {
    const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
    const governance = new GovernanceService(adapter(), null, ttl, registries, repository);
    await governance.initialize();
    const validationGate = new GovernedValidationGate(governance, validator, registries, repository);
    const bridge = await createErpbridgeMcpSession({ baseURL: "https://f06-sdk.example.test", token: "synthetic-sdk-token", timeoutMs: 1000, validator,
      sdkClient: { connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
        listTools: vi.fn(async () => registries.snapshot().tools.map(tool => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema }))), callTool: sdkCall } });
    bridges.push(bridge);
    const transport: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://f06-model.example.test/v1/chat/completions");
      const wire = JSON.parse(String(init?.body)); modelTurns.push(wire.model);
      if (modelTurns.length === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [
        { id: "synthetic-read", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } },
      ] } }] });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Eight synthetic rows confirmed." } }] });
    };
    const providerRuntime = new ProviderRuntime(repository, executor, transport);
    providerRuntime.activate({ id: "f06-provider", name: "F06 synthetic provider", type: "openai_compatible", baseURL: "https://f06-model.example.test/v1",
      apiKey: "synthetic-model-token", model: "model-a", additionalModels: ["model-b"], temperature: 0, timeoutMs: 5000,
      egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://f06-model.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"],
        reviewedAt: "2026-10-13T00:00:00.000Z", reviewedBy: { id: "owner", name: "Owner" } } });
    return { services: { config, repository, registries, validator, validationGate, executor, erpbridgeSession: bridge, providerRuntime } };
  });
  try {
    await withFunctionResources(composition, async ({ repository, registries }) => {
      await repository.mutate(state => {
        state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false };
        state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active",
          initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
      });
      const seed = new GovernanceService(adapter(), null, ttl, registries, repository);
      await seed.initialize();
      const original = await seed.govern({ requestId: "seed", user: { id: "owner", role: "Platform Admin", department: null },
        intent: "read", proposedActions: ["demo.echo"], caseContext: {} }, true, async () => true);
      expect(original.allowed).toBe(true);
      await repository.mutate(state => {
        const snapshot = state.governancePolicy!.snapshot as { fetchedAt: number; expiresAt: number };
        snapshot.fetchedAt -= 1000; snapshot.expiresAt -= 1000;
      });
    });
    const baseline = await withFunctionResources(composition, async ({ repository }) => repository.read(state => structuredClone(state.governancePolicy)));
    const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` };
    const sessionId = await withFunctionRuntime(composition, async ({ app }) => {
      const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} }); expect(created.statusCode).toBe(201);
      const id = created.json().data.id;
      const response = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/messages`, headers,
        payload: { content: "Show me invoices", model: "model-b", delivery: "async-chat", idempotencyKey: "f06-governance-renewal-0001" } });
      expect(response.statusCode, response.body).toBe(202); return id;
    });
    expect(sent).toHaveLength(1); expect(sdkCall).not.toHaveBeenCalled();
    const receipt = await executeFunctionChatTask(composition, sent[0]!, { timeoutMs: 10_000 });
    const state = await withFunctionResources(composition, async ({ repository }) => repository.snapshot());
    const renewed = state.governancePolicy as typeof baseline;
    expect(governanceFetch).toHaveBeenCalledTimes(2);
    expect(renewed?.snapshot).toMatchObject({ policyVersion: scenario === "policy-version-changed" ? "changed-reviewed-policy" : "same-reviewed-policy",
      rules: [], evidenceIds: scenario === "evidence-changed" ? ["changed-evidence"] : ["same-evidence"], source: "primary" });
    expect((renewed?.snapshot as { fetchedAt: number }).fetchedAt).toBeGreaterThan((baseline?.snapshot as { fetchedAt: number }).fetchedAt);
    expect(sdkCall).toHaveBeenCalledOnce();
    const changed = scenario === "policy-version-changed" || scenario === "evidence-changed";
    expect(modelTurns, JSON.stringify({ receipt, status: state.chatOperations[sent[0]!.operationId]!.status,
      reason: state.chatOperations[sent[0]!.operationId]!.reason, sdkCalls: sdkCall.mock.calls.length })).toEqual(changed ? ["model-b"] : ["model-b", "model-b"]);
    expect(receipt.status).toBe(changed ? "RECOVERY_REQUIRED" : "ANSWERED");
    expect(state.chatOperations[sent[0]!.operationId]!.status).toBe(changed ? "RECOVERY_REQUIRED" : "ANSWERED");
    expect(state.chats[sessionId]!.messages).toHaveLength(changed ? 1 : 2);
  } finally {
    await Promise.all(bridges.map(bridge => bridge.close()));
    expect(fixture.clients.every(client => client.closed)).toBe(true);
    expect(FakeStopClient.instances.every(client => client.closed)).toBe(true);
    fixture.construct.mockReset(); await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
