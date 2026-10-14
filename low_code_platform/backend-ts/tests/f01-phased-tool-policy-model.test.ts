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
import { LOCAL_POLICY_V2_SYSTEM_PROMPT } from "../src/prompts/contracts.js";
import type { ApplicationResources } from "../src/entrypoints/application-runtime.js";
import type { ChatTaskCommand } from "../src/agent/chat-task-outbox.js";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";
import * as optionalPolicy from "../src/governance/optional-policy.js";

// Substitute only storage/SDK/model I/O and runtime composition. The phased
// task, read broker, optional-policy evaluator, provider and wire client are real.
const fixture = vi.hoisted(() => ({ database: null as Database | null, clients: [] as FakeClient[], construct: vi.fn() }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class {
  constructor(settings: unknown) { const client = new FakeClient(fixture.database!, settings); fixture.clients.push(client); return client; }
}, default: { v1: { FirestoreClient: class { constructor(settings: unknown) { return new FakeStopClient(fixture.database!, settings); } } } } }));
vi.mock("../src/entrypoints/application-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/entrypoints/application-runtime.js")>(), constructApplicationRuntime: fixture.construct,
}));

test.each(["allow", "deny", "invalid-json", "provider-drift", "cancel-tool-policy", "provider-400", "provider-429", "provider-500",
  "static-deny", "static-review", "dispatch-ack-policy-drift", "actor-drift", "switch-drift", "policy-intent-before", "policy-intent-after", "policy-result-close"] as const)(
  "F01 actual phased tool-policy transport honors chat B and preserves default A (%s)", async scenario => {
    fixture.database = new Database(); fixture.clients = [];
    FakeStopClient.instances = []; FakeStopClient.hold = false; FakeStopClient.onRead = undefined;
    const temporary = await mkdtemp(join(tmpdir(), "f01-per-read-policy-")), policyPath = join(temporary, "policy.json");
    const baselinePolicy = await readFile(resolve("policy/governance_fallback.json"), "utf8"), policy = JSON.parse(baselinePolicy);
    if (scenario === "static-deny") policy.globally_blocked_tools.push("demo.echo");
    if (scenario === "static-review") policy.tools_requiring_human_review.push("demo.echo");
    await writeFile(policyPath, JSON.stringify(policy));
    const residentEvaluation = vi.spyOn(optionalPolicy, "evaluateOptionalPolicy");
    const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", MCP_MODE: "mock", FIRESTORE_PROJECT_ID: "demo-f01-model",
      FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "f01_model_fixture", STORAGE_ENCRYPTION_KEY: "f".repeat(32),
      JWT_SECRET: "f01-model-synthetic-secret-at-least-32-bytes", GOVERNANCE_FALLBACK_POLICY_PATH: policyPath });
    config.toolRegistryPath = resolve("tests/fixtures/chat-read-tools.json"); config.ruleRegistryPath = resolve("tests/fixtures/rules.json");
    config.erpbridgeRoleMap = { "Platform Admin": "admin" };
    const controller = new AbortController(), sent: ChatTaskCommand[] = [], runtimes: ProviderRuntime[] = [], bridges: Array<{ close(): Promise<void> }> = [];
    const observed: Array<{ kind: "chat-policy" | "tool-policy" | "query"; model: string }> = [];
    let queryCalls = 0, drift = false, boundaryInjected = false;
    const sdkCall = vi.fn(async () => ({ content: [], structuredContent: { value: "acknowledged synthetic read only" } }));
    const composition = { config, root: process.cwd(), transport: { timeoutMs: 1000,
      enqueue: vi.fn(async (command: { taskId: string }) => ({ taskId: command.taskId, outcome: "CREATED" as const })) },
      chatTransport: { timeoutMs: 1000, enqueue: vi.fn(async (command: ChatTaskCommand) => {
        sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" as const };
      }) } };
    fixture.construct.mockImplementation(async ({ repository, registries }: ApplicationResources) => {
      if (scenario.startsWith("policy-intent-") || scenario === "dispatch-ack-policy-drift") {
        const mutate = repository.mutate.bind(repository);
        vi.spyOn(repository, "mutate").mockImplementation(async callback => {
          const result = await mutate(state => {
            const value = callback(state);
            const op = Object.values(state.chatOperations).find(op => op.status === "RUNNING");
            if (!boundaryInjected && scenario.startsWith("policy-intent-") && op?.attempts.length === 1 &&
                op.modelAttemptsSecret?.some(item => item.purpose === "POLICY_PREFLIGHT" && item.status === "DISPATCH_INTENT")) {
              boundaryInjected = true; fixture.database!.fault = scenario === "policy-intent-before" ? "before-commit" : "after-commit";
            }
            return value;
          });
          if (!boundaryInjected && scenario === "dispatch-ack-policy-drift" && await repository.read(state =>
              Object.values(state.chatOperations).some(op => op.attempts.some(item => item.status === "DISPATCH_INTENT")))) {
            boundaryInjected = true;
            // Commit succeeded, but change the file before returning the actual
            // dispatch-intent ACK. A pre-ACK async hash check cannot catch it.
            await writeFile(policyPath, JSON.stringify(policy) + "\n");
          }
          return result;
        });
      }
      if (scenario === "policy-result-close") {
        const close = repository.close.bind(repository);
        vi.spyOn(repository, "close").mockImplementation(async () => {
          const inject = !boundaryInjected && await repository.read(state => Object.values(state.chatOperations).some(op =>
            op.attempts.length === 1 && op.modelAttemptsSecret?.filter(item => item.purpose === "POLICY_PREFLIGHT" && item.status === "DONE").length === 2)).catch(() => false);
          await close();
          if (inject) { boundaryInjected = true; throw new Error("Synthetic per-read policy result close unconfirmed"); }
        });
      }
      const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
      const bridge = await createErpbridgeMcpSession({ baseURL: "https://f01-sdk.example.test", token: "synthetic-sdk-token", timeoutMs: 1000, validator,
        sdkClient: { connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
          listTools: vi.fn(async () => registries.snapshot().tools.map(tool => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema }))), callTool: sdkCall } });
      bridges.push(bridge);
      const transport: typeof fetch = async (url, init) => {
        expect(String(url)).toBe("https://f01-model.example.test/v1/chat/completions");
        const wire = JSON.parse(String(init?.body));
        if (wire.messages[0]?.content === LOCAL_POLICY_V2_SYSTEM_PROMPT) {
          const prompt = JSON.parse(wire.messages[1].content), toolPolicy = prompt.action === "demo.echo";
          expect(prompt.actor).toEqual({ id: "owner", role: "Platform Admin" }); expect(wire.max_tokens).toBe(1024);
          expect(prompt.action).toBe(toolPolicy ? "demo.echo" : "chat_request");
          observed.push({ kind: toolPolicy ? "tool-policy" : "chat-policy", model: wire.model });
          if (toolPolicy && scenario === "cancel-tool-policy") {
            controller.abort(); throw Object.assign(new Error("Synthetic policy transport cancelled"), { name: "AbortError" });
          }
          if (toolPolicy && scenario.startsWith("provider-")) {
            const status = Number(scenario.slice("provider-".length));
            if (Number.isFinite(status)) return Response.json({ error: { message: "Synthetic known HTTP failure" } }, { status });
          }
          if (toolPolicy && (scenario === "actor-drift" || scenario === "switch-drift")) {
            // Mutate the persisted authority only after the exact local request
            // entered; fresh result ownership must reject these changed bindings.
            await withFunctionResources(composition, async ({ repository: fresh }) => fresh.mutate(state => {
              if (scenario === "actor-drift") state.users.owner!.status = "Inactive";
              else state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false };
            }));
          }
          const content = toolPolicy && scenario === "invalid-json" ? '{"decision":"allow","extra":true}' : JSON.stringify({
            decision: toolPolicy && scenario === "deny" ? "deny" : "allow", reason: "Synthetic local policy decision.",
          });
          return Response.json({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 8, completion_tokens: 9 } });
        }
        observed.push({ kind: "query", model: wire.model }); queryCalls++;
        if (queryCalls === 1) {
          if (scenario === "provider-drift") drift = true;
          return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [
            { id: "synthetic-read", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } },
          ] } }] });
        }
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Confirmed synthetic read." } }] });
      };
      const providerRuntime = new ProviderRuntime(repository, executor, transport);
      providerRuntime.activate({ id: "f01-provider", name: "F01 synthetic provider", type: "openai_compatible", baseURL: "https://f01-model.example.test/v1",
        apiKey: "synthetic-model-token", model: "model-a", additionalModels: ["model-b"], temperature: drift ? 1 : 0, timeoutMs: 5000,
        egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://f01-model.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"],
          reviewedAt: "2026-10-13T00:00:00.000Z", reviewedBy: { id: "owner", name: "Owner" } } });
      runtimes.push(providerRuntime);
      return { services: { config, repository, registries, validator, executor, erpbridgeSession: bridge, providerRuntime } };
    });
    try {
      await withFunctionResources(composition, async ({ repository }) => repository.mutate(state => {
        state.settings.rbac = { enabled: false, localPolicyAgentEnabled: true };
        state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active",
          initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
      }));
      const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` };
      const sessionId = await withFunctionRuntime(composition, async ({ app }) => {
        const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} }); expect(created.statusCode).toBe(201);
        const id = created.json().data.id;
        const response = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/messages`, headers,
          payload: { content: "Show me invoices", model: "model-b", delivery: "async-chat", idempotencyKey: "f01-selected-tool-policy-0001" } });
        expect(response.statusCode, response.body).toBe(202); return id;
      });
      expect(observed).toEqual([]); expect(sdkCall).not.toHaveBeenCalled(); expect(sent).toHaveLength(1);
      const admitted = await withFunctionResources(composition, async ({ repository }) => repository.read(state => state.chatOperations[sent[0]!.operationId]!));
      expect(admitted.modelBinding?.model).toBe("model-b");
      const receipt = await executeFunctionChatTask(composition, sent[0]!, { timeoutMs: 10_000, signal: controller.signal });
      const state = await withFunctionResources(composition, async ({ repository }) => repository.snapshot());
      const operation = state.chatOperations[sent[0]!.operationId]!;
      expect(queryCalls, JSON.stringify({ observed, status: operation.status, reason: operation.reason })).toBeGreaterThan(0);
      expect(observed.filter(call => call.kind === "chat-policy").map(call => call.model)).toEqual(["model-b"]);
      expect(observed.filter(call => call.kind === "query").every(call => call.model === "model-b")).toBe(true);
      expect(runtimes.length).toBeGreaterThanOrEqual(4);
      expect(runtimes.every(runtime => runtime.configuration?.model === "model-a" && runtime.binding?.model === "model-a"), "every original fresh runtime retains admin default A").toBe(true);
      expect(state.providers).toEqual({}); expect(state.settings.llm).toEqual({}); expect(state.executions).toEqual({});
      expect(observed.filter(call => call.kind === "tool-policy").map(call => call.model),
        `actual broker/evaluateOptionalPolicy/ProviderRuntime wire model; observed=${JSON.stringify(observed)}`).toEqual(
          ["provider-drift", "static-deny", "static-review", "policy-intent-before", "policy-intent-after"].includes(scenario) ? [] : ["model-b"]);
      expect(residentEvaluation, "the exact selected policy result must be consumed once without resident reevaluation").not.toHaveBeenCalled();
      if (scenario.startsWith("policy-intent-") || scenario === "policy-result-close" || scenario === "dispatch-ack-policy-drift") expect(boundaryInjected).toBe(true);
      if (scenario === "allow") {
        expect(receipt.status).toBe("ANSWERED"); expect(sdkCall).toHaveBeenCalledOnce(); expect(operation.attempts).toMatchObject([{ status: "DONE" }]);
        expect(state.chats[sessionId]!.messages).toHaveLength(2); expect(queryCalls).toBe(2);
        const policyProvenance = Object.values(state.invocationProvenance).filter(item => item.promptTemplateVersion === "prompt/local-policy/v2");
        expect(policyProvenance).toHaveLength(2);
        expect(policyProvenance.map(item => item.configurationRevision)).toEqual([admitted.modelBinding!.configurationRevision, admitted.modelBinding!.configurationRevision]);
      } else {
        expect(sdkCall).not.toHaveBeenCalled(); expect(state.chats[sessionId]!.messages).toHaveLength(1); expect(queryCalls).toBe(1);
        const knownStop = ["deny", "invalid-json", "static-deny", "static-review", "provider-400", "provider-429", "provider-500"].includes(scenario);
        expect(receipt.status).toBe(knownStop ? "FAILED" : "RECOVERY_REQUIRED");
        if (scenario === "deny") expect(operation.reason).toBe("POLICY_DENIED");
        if (scenario === "invalid-json") expect(operation.reason).toBe("LOCAL_POLICY_RESPONSE_INVALID");
        if (scenario === "static-deny") expect(operation.reason).toBe("POLICY_DENIED");
        if (scenario === "static-review") expect(operation.reason).toBe("POLICY_REVIEW_REQUIRED");
        if (["provider-400", "provider-429", "provider-500"].includes(scenario)) {
          expect(operation.reason).toBe("LOCAL_POLICY_PROVIDER_FAILED");
          expect(operation.attempts).toMatchObject([{ status: "FAILED", output: { failureCode: "LOCAL_POLICY_PROVIDER_FAILED" } }]);
          expect(operation.modelAttemptsSecret?.at(-1)?.status).toBe("FAILED");
        }
      }
    } finally {
      await Promise.all(bridges.map(bridge => bridge.close()));
      expect(fixture.clients.every(client => client.closed)).toBe(true);
      expect(FakeStopClient.instances.every(client => client.closed)).toBe(true);
      fixture.construct.mockReset();
      residentEvaluation.mockRestore(); await rm(temporary, { recursive: true, force: true });
    }
  }, 20_000,
);
