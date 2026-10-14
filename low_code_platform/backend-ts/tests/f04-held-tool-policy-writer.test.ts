import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { withFunctionResources, withFunctionRuntime } from "../src/firebase/invocation.js";
import { executeFunctionChatTask } from "../src/firebase/chat-task.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreOwnershipFailure, FirestoreWriterOwnership } from "../src/storage/firestore-writer-ownership.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { LOCAL_POLICY_V2_SYSTEM_PROMPT } from "../src/prompts/contracts.js";
import type { ChatTaskCommand } from "../src/agent/chat-task-outbox.js";
import type { ApplicationResources } from "../src/entrypoints/application-runtime.js";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";

// Only Firestore SDK I/O, provider transport, ERPBridge SDK I/O and service
// composition are synthetic. The task, broker, policy and HTTP routes are real.
const fixture = vi.hoisted(() => ({ database: null as Database | null, clients: [] as FakeClient[], construct: vi.fn(), opened: vi.fn() }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class {
  constructor(settings: unknown) { const client = new FakeClient(fixture.database!, settings); fixture.clients.push(client); return client; }
}, default: { v1: { FirestoreClient: class { constructor(settings: unknown) { return new FakeStopClient(fixture.database!, settings); } } } } }));
vi.mock("../src/entrypoints/application-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/entrypoints/application-runtime.js")>();
  return { ...actual, openApplicationResources: async (...args: Parameters<typeof actual.openApplicationResources>) => {
    const resources = await actual.openApplicationResources(...args); fixture.opened(resources); return resources;
  }, constructApplicationRuntime: fixture.construct };
});

function gate() { let release!: () => void; const promise = new Promise<void>(resolveGate => { release = resolveGate; }); return { promise, release }; }
async function boundedObservation<T>(pending: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<undefined>(resolveWait => { timer = setTimeout(() => resolveWait(undefined), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const sourcePaths = ["src/firebase/chat-task.ts", "src/firebase/invocation.ts", "src/entrypoints/application-runtime.ts",
  "src/governance/optional-policy.ts", "src/tools/read-tool-broker.ts", "src/providers/runtime.ts",
  "src/storage/firestore-records.ts", "src/storage/firestore-writer-ownership.ts"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));

test.each([false, true])("F04 causal: held per-read local policy must permit unrelated authenticated PATCH and distinct-owner readback before release (remote=%s)", async remote => {
  const beforeHashes = await sourceHashes();
  fixture.database = new Database(); fixture.clients = []; FakeStopClient.instances = []; FakeStopClient.hold = false; FakeStopClient.onRead = undefined;
  const resources: ApplicationResources[] = [], bridges: Array<{ close(): Promise<void> }> = [], sent: ChatTaskCommand[] = [];
  fixture.opened.mockImplementation((opened: ApplicationResources) => { resources.push(opened); });
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", MCP_MODE: "mock",
    FIRESTORE_PROJECT_ID: "demo-f04-tool-policy", FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "f04_tool_policy_writer",
    STORAGE_ENCRYPTION_KEY: "q".repeat(32), JWT_SECRET: "f04-tool-policy-synthetic-jwt-secret-32-bytes",
    GOVERNANCE_FALLBACK_POLICY_PATH: resolve("policy/governance_fallback.json") });
  config.toolRegistryPath = resolve("tests/fixtures/chat-read-tools.json"); config.ruleRegistryPath = resolve("tests/fixtures/rules.json");
  config.erpbridgeRoleMap = { "Platform Admin": "admin" }; config.functionsWriterAdmissionTimeoutMs = 5_000;
  const composition = { config, root: process.cwd(), transport: { timeoutMs: 1000, enqueue: vi.fn(async (command: { taskId: string }) => ({ taskId: command.taskId, outcome: "CREATED" as const })) },
    chatTransport: { timeoutMs: 1000, enqueue: vi.fn(async (command: ChatTaskCommand) => { sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" as const }; }) } };
  const entered = gate(), held = gate(); let policyReleased = false, chatPolicyCalls = 0, toolPolicyCalls = 0, queryCalls = 0;
  let policyOwner: ApplicationResources["repository"] | undefined;
  const sdkCall = vi.fn(async () => ({ content: [], structuredContent: { value: "acknowledged synthetic read only" } }));
  fixture.construct.mockImplementation(async ({ repository, registries }: ApplicationResources) => {
    expect(repository.persistence).toBeInstanceOf(FirestoreRecordPersistence); repository.assertAuthority();
    const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
    const bridge = await createErpbridgeMcpSession({ baseURL: "https://f04-sdk.example.test", token: "synthetic-sdk-token", timeoutMs: 1000, validator,
      sdkClient: { connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
        listTools: vi.fn(async () => registries.snapshot().tools.map(tool => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema }))), callTool: sdkCall } });
    bridges.push(bridge);
    const literalFetch: typeof fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      if (wire.messages[0]?.content === LOCAL_POLICY_V2_SYSTEM_PROMPT) {
        const prompt = JSON.parse(wire.messages[1].content);
        expect(prompt.actor).toEqual({ id: "owner", role: "Platform Admin" });
        if (prompt.action === "chat_request") { chatPolicyCalls++; expect(prompt.context.intent).toBe("QUERY"); }
        else {
          expect(prompt.action).toBe("demo.echo"); toolPolicyCalls++; policyOwner = repository; repository.assertAuthority();
          entered.release(); await held.promise;
        }
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"decision":"allow","reason":"Synthetic local policy permits this read."}' } }], usage: { prompt_tokens: 8, completion_tokens: 9 } });
      }
      queryCalls++;
      if (queryCalls === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [
        { id: "f04-synthetic-read", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } },
      ] } }] });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Confirmed synthetic read." } }] });
    };
    const providerRuntime = new ProviderRuntime(repository, executor, literalFetch);
    providerRuntime.activate({ id: "f04-provider", name: "F04 synthetic provider", type: "openai_compatible",
      baseURL: "https://f04-model.example.test/v1", apiKey: "synthetic-model-token", model: "model-a", additionalModels: ["model-b"],
      temperature: 0, timeoutMs: 10_000,
      egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://f04-model.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"],
        reviewedAt: "2026-10-13T00:00:00.000Z", reviewedBy: { id: "owner", name: "Owner" } } });
    return { services: { config, repository, registries, validator, executor, erpbridgeSession: bridge, providerRuntime } };
  });
  const originalAcquire = FirestoreWriterOwnership.prototype.acquire, busyReasons: string[] = [];
  const acquisition = vi.spyOn(FirestoreWriterOwnership.prototype, "acquire").mockImplementation(async function (this: FirestoreWriterOwnership) {
    try { await originalAcquire.call(this); }
    catch (error) { if (policyOwner && !policyReleased && error instanceof FirestoreOwnershipFailure) busyReasons.push(error.reason); throw error; }
  });
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` };
  let task: Promise<unknown> | undefined, independent: Promise<unknown> | undefined;
  let beforeRelease: Record<string, unknown> | undefined;
  let operationId = "", saved = false, visible = false;
  let saveOwner: ApplicationResources["repository"] | undefined, readOwner: ApplicationResources["repository"] | undefined;
  try {
    await withFunctionResources(composition, async ({ repository }) => repository.mutate(state => {
      const timestamp = new Date().toISOString(); state.settings.rbac = { enabled: remote, localPolicyAgentEnabled: true };
      state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active",
        initials: "O", departmentId: null, lastLoginAt: null, createdAt: timestamp };
      state.workflows.independent = { id: "independent", name: "Unrelated draft", description: "Before held tool policy", owner: { id: "owner", name: "Owner" },
        assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0,
        draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, archived: false,
        yaml: "name: Unrelated draft\ndescription: Synthetic\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fixture" };
      state.versions.independent = [];
    }));
    operationId = await withFunctionRuntime(composition, async ({ app }) => {
      const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} }); expect(created.statusCode, created.body).toBe(201);
      const response = await app.inject({ method: "POST", url: `/api/chat/sessions/${created.json().data.id}/messages`, headers,
        payload: { content: "Show me invoices", model: "model-b", delivery: "async-chat", idempotencyKey: "f04-held-tool-policy-0001" } });
      expect(response.statusCode, response.body).toBe(202); return response.json().data.operation.id;
    });
    expect(sent).toHaveLength(1); expect(chatPolicyCalls).toBe(0); expect(toolPolicyCalls).toBe(0);
    task = executeFunctionChatTask(composition, sent[0]!, { timeoutMs: 25_000 });
    const taskOutcome = task.then(value => ({ value }), error => ({ error }));
    expect(await boundedObservation(entered.promise.then(() => true), 8_000), `actual per-read local policy fetch must enter; ${JSON.stringify({ chatPolicyCalls, toolPolicyCalls, queryCalls, task: await boundedObservation(taskOutcome, 0) })}`).toBe(true);
    expect(chatPolicyCalls).toBe(1); expect(toolPolicyCalls).toBe(1); expect(queryCalls).toBe(1); expect(sdkCall).not.toHaveBeenCalled();
    const opensBeforeSave = acquisition.mock.calls.length;
    independent = (async () => {
      await withFunctionRuntime(composition, async ({ services, app }) => {
        saveOwner = services.repository;
        const response = await app.inject({ method: "PATCH", url: "/api/workflows/independent", headers,
          payload: { description: "Committed during held tool policy" } });
        expect(response.statusCode, response.body).toBe(200); saved = true;
      });
      await withFunctionResources(composition, async ({ repository }) => {
        readOwner = repository; visible = await repository.readAuthoritative(state => state.workflows.independent!.description === "Committed during held tool policy");
      });
    })();
    const saveOutcome = independent.then(() => ({ done: true }), error => ({ error }));
    await boundedObservation(saveOutcome, 1_000);
    let policyOwnerStillAuthoritative = true;
    try { policyOwner!.assertAuthority(); } catch { policyOwnerStillAuthoritative = false; }
    beforeRelease = { policyReleased, chatPolicyCalls, toolPolicyCalls, queryCalls, sdkCalls: sdkCall.mock.calls.length, saved, visible,
      acquisitionAttempts: acquisition.mock.calls.length - opensBeforeSave,
      competingWriterHeldFailures: busyReasons.filter(reason => reason === "WRITER_HELD").length, policyOwnerStillAuthoritative };
    expect(beforeRelease.acquisitionAttempts).toBeGreaterThan(0);
    policyReleased = true; held.release();
    expect(await taskOutcome).toMatchObject({ value: { id: operationId, status: "ANSWERED" } });
    expect(await saveOutcome).toEqual({ done: true }); expect(saved).toBe(true); expect(visible).toBe(true);
    expect(saveOwner).not.toBe(policyOwner); expect(readOwner).not.toBe(policyOwner); expect(readOwner).not.toBe(saveOwner);
    await withFunctionResources(composition, async ({ repository }) => repository.readAuthoritative(state => {
      expect(state.workflows.independent!.description).toBe("Committed during held tool policy");
      expect(state.chatOperations[operationId]!.status).toBe("ANSWERED");
      expect(Object.values(state.invocationProvenance).filter(inv => inv.promptTemplateVersion === "prompt/local-policy/v2")).toHaveLength(2);
      expect(Object.values(state.invocationProvenance).filter(inv => inv.promptTemplateVersion === "prompt/local-policy/v2").map(inv => inv.fallbackUsed)).toEqual([remote, remote]);
      expect(state.auditLogs.some(audit => audit.action === "optional_policy.evaluated" && (audit.after as any)?.decision === "allow" && (audit.after as any)?.source === "local_model")).toBe(true);
    }));
    expect(chatPolicyCalls).toBe(1); expect(toolPolicyCalls).toBe(1); expect(queryCalls).toBe(2); expect(sdkCall).toHaveBeenCalledOnce();
  } finally {
    policyReleased = true; held.release(); FakeStopClient.onRead = undefined;
    await Promise.allSettled([...(task ? [task] : []), ...(independent ? [independent] : [])]);
    await Promise.allSettled(bridges.map(bridge => bridge.close())); await Promise.allSettled(resources.map(opened => opened.close()));
    acquisition.mockRestore(); fixture.construct.mockReset(); fixture.opened.mockReset();
  }
  expect(fixture.clients.every(client => client.closed)).toBe(true); expect(FakeStopClient.instances.every(client => client.closed)).toBe(true);
  expect(await sourceHashes()).toEqual(beforeHashes);
  expect(beforeRelease, `F04 per-read policy causal observation: ${JSON.stringify(beforeRelease)}; authenticated PATCH and distinct-owner persisted readback must complete BEFORE release (1000ms observation, not a production SLO)`)
    .toMatchObject({ policyReleased: false, saved: true, visible: true });
}, 35_000);
