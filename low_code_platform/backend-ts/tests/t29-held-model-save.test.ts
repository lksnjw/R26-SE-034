import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import jwt from "jsonwebtoken";
import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { withFunctionResources, withFunctionRuntime } from "../src/firebase/invocation.js";
import { executeFunctionChatTask } from "../src/firebase/chat-task.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreWriterOwnership } from "../src/storage/firestore-writer-ownership.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { chatJobQueue } from "../src/agent/chat-jobs.js";
import type { ChatTaskCommand } from "../src/agent/chat-task-outbox.js";
import type { ApplicationResources } from "../src/entrypoints/application-runtime.js";
import type { ChatOperation } from "../src/repository/store.js";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";
import { FirestoreChatCancellation, openFirestoreChatCancellation } from "../src/storage/firestore-chat-cancellation.js";
import { publicChatOperation } from "../src/agent/chat-progress.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import * as optionalPolicy from "../src/governance/optional-policy.js";
import * as readBroker from "../src/tools/read-tool-broker.js";

const fixtures = vi.hoisted(() => ({ database: null as Database | null, clients: [] as FakeClient[], construct: vi.fn(), opened: vi.fn() }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class {
  constructor(settings: unknown) {
    const client = new FakeClient(fixtures.database!, settings); fixtures.clients.push(client); return client;
  }
}, default: { v1: { FirestoreClient: class { constructor(settings: unknown) { return new FakeStopClient(fixtures.database!, settings); } } } } }));
// Keep the real resource opener, authority protocol, Functions lifecycle, HTTP,
// provider and chat queue. Replace service composition solely to inject a
// synthetic SDK and a controllable model transport: no listeners or network.
vi.mock("../src/entrypoints/application-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/entrypoints/application-runtime.js")>();
  return { ...actual, openApplicationResources: async (...args: Parameters<typeof actual.openApplicationResources>) => {
    const resources = await actual.openApplicationResources(...args); fixtures.opened(resources); return resources;
  }, constructApplicationRuntime: fixtures.construct };
});

test.each(["save", "generate", "generate-malformed-fallback", "generate-transport-no-fallback", "node", "final-close-preanswer", "final-close-postanswer", "duplicate", "tool", "tool-close", "revocation", "policy-switch", "cancel", "intent-before-commit", "intent-after-commit", "result-before-commit", "result-after-commit", "stuck-headers", "stuck-body",
  "read-policy-deny", "read-policy-review", "read-policy-invalid", "read-policy-unavailable", "read-policy-config", "read-policy-provider", "read-policy-cancelled-code",
  "read-policy-counterfeit", "read-policy-stale", "read-policy-ack-before", "read-policy-ack-after", "read-policy-runtime-acquire", "read-policy-runtime-close", "read-policy-control-close",
  "read-policy-terminal-ack-before", "read-policy-terminal-ack-after", "read-policy-terminal-close", "read-policy-unresolved-tool", "read-policy-unresolved-model",
  "read-policy-deadline", "read-policy-revocation", "read-policy-config-drift", "read-policy-contract-drift", "read-policy-receipt-drift", "read-policy-journal-drift", "read-policy-late-revocation", "read-policy-late-config-drift", "read-policy-late-unresolved-tool", "read-policy-late-unresolved-model", "read-policy-late-deadline", "read-policy-late-abort", "read-policy-external-abort", "read-policy-stop",
  "read-policy-watch-clean", "read-policy-watch-stop", "read-policy-watch-uncertain", "read-policy-watch-deadline", "read-policy-watch-external",
  "watch-concurrent-stop-failed", "watch-concurrent-stop-normal"])("T29: held model preserves unrelated save/readback and exact phase fencing (%s)", async scenario => {
  fixtures.database = new Database(); fixtures.clients = [];
  FakeStopClient.instances = []; FakeStopClient.hold = false; FakeStopClient.onRead = undefined;
  const concurrentStop = scenario.startsWith("watch-concurrent-stop-"), heldWatcher = scenario.startsWith("read-policy-watch-") || concurrentStop;
  let watcherStream: ReturnType<FakeStopClient["batchGetDocuments"]> | undefined, watcherName = "", policyRuntimeClosed = false, concurrentStopObserved = false;
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", MCP_MODE: "mock",
    FIRESTORE_PROJECT_ID: "demo-t29-causal", FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "t29_causal_fixture",
    STORAGE_ENCRYPTION_KEY: "k".repeat(32), JWT_SECRET: "t29-synthetic-jwt-secret-at-least-32-bytes",
    TOOL_REGISTRY_PATH: resolve("tests/fixtures/chat-read-tools.json"), RULE_REGISTRY_PATH: resolve("tests/fixtures/rules.json") });
  config.toolRegistryPath = resolve("tests/fixtures/chat-read-tools.json"); config.ruleRegistryPath = resolve("tests/fixtures/rules.json");
  config.erpbridgeRoleMap = { "Platform Admin": "admin" };
  const sent: ChatTaskCommand[] = [], repositories: ApplicationResources["repository"][] = [], bridges: Array<{ close(): Promise<void> }> = [];
  const observedClaims = new Map<string, ChatOperation>(), unobserve: Array<() => void> = [];
  let toolCloseInjected = false, finalCloseInjected = false, finalRuntimeSeen = false;
  fixtures.opened.mockImplementation(({ repository }: ApplicationResources) => {
    repositories.push(repository);
    const close = repository.close.bind(repository);
    if (heldWatcher || ["read-policy-late-deadline", "read-policy-late-abort"].includes(scenario)) vi.spyOn(repository, "close").mockImplementation(async () => {
      const policyStopped = await repository.read(state => Object.values(state.chatOperations).some(op => op.status === "RUNNING" && op.attempts.some(attempt => attempt.status === "FAILED" && attempt.output?.source === "local_model"))).catch(() => false);
      await close(); if (policyStopped) policyRuntimeClosed = true;
    });
    if (scenario.startsWith("final-close-")) vi.spyOn(repository, "close").mockImplementation(async () => {
      const inject = await repository.read(state => {
        const op = Object.values(state.chatOperations).find(operation => operation.modelAttemptsSecret?.some(attempt => attempt.status === "DONE"));
        return finalRuntimeSeen && !finalCloseInjected && (scenario === "final-close-postanswer" ? op?.status === "ANSWERED" : op?.status === "RUNNING");
      }).catch(() => false);
      await close();
      if (inject && !finalCloseInjected) { finalCloseInjected = true; throw new Error("Synthetic final phase disposal acknowledgement lost"); }
    });
    if (scenario === "tool-close") vi.spyOn(repository, "close").mockImplementation(async () => {
      const toolDone = await repository.read(state => Object.values(state.chatOperations).some(op => op.attempts.some(attempt => attempt.status === "DONE"))).catch(() => false);
      const inject = toolDone && !toolCloseInjected; if (inject) toolCloseInjected = true;
      await close(); if (inject) throw new Error("Synthetic phase disposal acknowledgement lost");
    });
    if (["read-policy-runtime-close", "read-policy-terminal-close"].includes(scenario)) vi.spyOn(repository, "close").mockImplementation(async () => {
      const inject = !toolCloseInjected && await repository.read(state => Object.values(state.chatOperations).some(op =>
        op.attempts.some(attempt => attempt.status === "FAILED" && attempt.output?.source === "local_model") && op.status === (scenario === "read-policy-terminal-close" ? "FAILED" : "RUNNING"))).catch(() => false);
      if (inject) toolCloseInjected = true;
      await close(); if (inject) throw new Error("Synthetic policy phase disposal acknowledgement lost");
    });
    if (["read-policy-receipt-drift", "read-policy-journal-drift", "read-policy-late-revocation", "read-policy-late-config-drift", "read-policy-late-unresolved-tool", "read-policy-late-unresolved-model"].includes(scenario)) vi.spyOn(repository, "close").mockImplementation(async () => {
      const inject = !toolCloseInjected && await repository.read(state => Object.values(state.chatOperations).some(op => op.status === "RUNNING" && op.attempts.some(attempt => attempt.status === "FAILED" && attempt.output?.source === "local_model"))).catch(() => false);
      if (inject) toolCloseInjected = true;
      await close();
      if (inject) await withFunctionResources(input, async ({ repository: fresh }) => fresh.mutate(state => {
        const op = Object.values(state.chatOperations).find(operation => operation.status === "RUNNING")!;
        if (scenario === "read-policy-receipt-drift") op.attempts[0]!.output = { decision: "review", source: "local_model" };
        if (scenario === "read-policy-journal-drift") state.chatOperationEvents[op.id]!.find(entry => entry.type === "tool.failed")!.type = "tool.dispatch_intent";
        if (scenario === "read-policy-late-revocation") state.users.owner!.status = "Inactive";
        if (scenario === "read-policy-late-config-drift") state.settings.rbac = { localPolicyEnabled: true };
        if (scenario === "read-policy-late-unresolved-tool") op.attempts.push({ id: "synthetic-unresolved", toolName: "demo.echo", argumentHash: "synthetic", status: "PREPARING", startedAt: new Date().toISOString() });
        if (scenario === "read-policy-late-unresolved-model") op.modelAttemptsSecret!.push({ ...op.modelAttemptsSecret![0]!, id: "synthetic-unresolved", status: "DISPATCH_INTENT" });
      }));
    });
    unobserve.push(repository.observeCommits({ committed: state => {
      for (const operation of Object.values(state.chatOperations)) if (operation.status === "RUNNING" && operation.taskLeaseSecret)
        observedClaims.set(operation.id, structuredClone(operation));
    }, unavailable: () => {} }));
  });
  const input = { config, root: process.cwd(), transport: { timeoutMs: 1000, enqueue: vi.fn(async (command: { taskId: string }) => ({ taskId: command.taskId, outcome: "CREATED" as const })) },
    chatTransport: { timeoutMs: 1000, enqueue: vi.fn(async (command: ChatTaskCommand) => { sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" as const }; }) } };
  let releaseModel!: () => void, dispatched!: () => void, modelReleased = false;
  const held = new Promise<void>(resolveHeld => { releaseModel = () => { modelReleased = true; resolveHeld(); }; });
  const entered = new Promise<void>(resolveEntered => { dispatched = resolveEntered; });
  const independentYaml = "name: Unrelated draft\ndescription: Synthetic\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fixture";
  const model = vi.fn<typeof fetch>(async (_url, init) => {
    repositories.at(-1)!.assertAuthority();
    dispatched(); await held;
    const requestModel = JSON.parse(String(init?.body)).model;
    if (scenario === "generate-transport-no-fallback") throw new Error("Synthetic uncertain transport failure");
    if (scenario === "generate-malformed-fallback" && requestModel === "model-a")
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "not: [valid yaml" } }] });
    if (scenario === "generate-malformed-fallback" && requestModel === "model-b")
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "name: Fallback fixture\ndescription: Generated by fallback\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fallback" } }] });
    if ((["tool", "tool-close"].includes(scenario) || scenario.startsWith("read-policy-")) && model.mock.calls.length === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "original-read", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }] } }] });
    if (scenario === "generate" || scenario.startsWith("final-close-")) return Response.json({ choices: [{ finish_reason: "stop", message: { content: "name: Generated fixture\ndescription: Generated while isolated\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fixture" } }], usage: { prompt_tokens: 8, completion_tokens: 13 } });
    if (scenario === "node") return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"description":"Proposed while isolated"}' } }], usage: { prompt_tokens: 8, completion_tokens: 13 } });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Please provide the invoice identifier." } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  const sdkCall = vi.fn(async () => ({ content: [], structuredContent: { value: "synthetic-only" } }));
  if (heldWatcher) FakeStopClient.onRead = (request, stream) => {
    if (concurrentStop && modelReleased && watcherStream) stream.once("end", () => { concurrentStopObserved = true; });
    if (watcherStream || modelReleased || model.mock.calls.length !== 1) return false;
    watcherStream = stream; watcherName = request.documents[0];
    if (scenario === "read-policy-watch-uncertain") stream.cancel = () => {};
    return true;
  };
  fixtures.construct.mockImplementation(async (resources: ApplicationResources) => {
    const { repository, registries } = resources;
    if (scenario === "read-policy-runtime-acquire" && modelReleased) throw new Error("Synthetic read runtime acquisition failure");
    if (scenario.startsWith("final-close-") && modelReleased) finalRuntimeSeen = true;
    expect(repository.persistence).toBeInstanceOf(FirestoreRecordPersistence); repository.assertAuthority();
    // Observe the acknowledged preparation commit while its owner is alive.
    // The assertion after dispatch consumes only this detached snapshot: the
    // correct phased implementation may already have closed that repository.
    const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
    if (scenario === "final-close-preanswer") {
      const originalHash = registries.hash.bind(registries);
      vi.spyOn(registries, "hash").mockImplementation(() => modelReleased ? (() => { throw new Error("Synthetic final-phase registry read failure"); })() : originalHash());
    }
    const bridge = await createErpbridgeMcpSession({ baseURL: "https://t29-sdk.example.test", token: "synthetic-stable-token", timeoutMs: 1000, validator,
      sdkClient: { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => registries.snapshot().tools.map(tool => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema }))), callTool: sdkCall } });
    bridges.push(bridge);
    const providerRuntime = new ProviderRuntime(repository, executor, model);
    providerRuntime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://t29-model.example.test/v1", apiKey: "synthetic-fixture-key",
      model: "model-a", ...(scenario === "generate-malformed-fallback" || scenario === "generate-transport-no-fallback" ? { fallbackModel: "model-b" } : {}), temperature: 0, timeoutMs: 10_000,
      egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://t29-model.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"],
        reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "owner", name: "Owner" } } });
    return { services: { config, repository, registries, validator, executor, erpbridgeSession: bridge, providerRuntime,
      synthesis: new SynthesisService(providerRuntime, registries, validator) } };
  });
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` };
  const policyOutcome = { decision: scenario === "read-policy-review" ? "review" as const : scenario === "read-policy-unavailable" ? "unavailable" as const : "deny" as const, source: "local_model" as const,
    ...(scenario === "read-policy-invalid" ? { failureCode: "LOCAL_POLICY_RESPONSE_INVALID" as const } : scenario === "read-policy-config" ? { failureCode: "LOCAL_POLICY_CONFIG_INVALID" as const } :
      scenario === "read-policy-provider" ? { failureCode: "LOCAL_POLICY_PROVIDER_FAILED" as const } : scenario === "read-policy-cancelled-code" ? { failureCode: "POLICY_CHECK_CANCELLED" as const } : {}) };
  const externalAbort = new AbortController();
  const policyReceipt = scenario.startsWith("read-policy-") ? vi.spyOn(optionalPolicy, "evaluateOptionalPolicy").mockImplementation(async (services, user, request) => {
    if (request.action === "chat_request") return { decision: "allow", source: "local_model", reason: "Synthetic chat preflight" };
    if (scenario === "read-policy-deadline") await pause(1100);
    if (scenario === "read-policy-external-abort") externalAbort.abort();
    if (["read-policy-unresolved-tool", "read-policy-unresolved-model", "read-policy-revocation", "read-policy-config-drift", "read-policy-contract-drift"].includes(scenario)) await services.repository.mutate(state => {
      const op = Object.values(state.chatOperations).find(operation => operation.status === "RUNNING")!;
      if (scenario === "read-policy-unresolved-tool") op.attempts.push({ id: "synthetic-unresolved", toolName: "demo.echo", argumentHash: "synthetic", status: "PREPARING", startedAt: new Date().toISOString() });
      if (scenario === "read-policy-unresolved-model") op.modelAttemptsSecret!.push({ ...op.modelAttemptsSecret![0]!, id: "synthetic-unresolved", status: "DISPATCH_INTENT" });
      if (scenario === "read-policy-revocation") state.users.owner!.status = "Inactive";
      if (scenario === "read-policy-config-drift") state.settings.rbac = { localPolicyEnabled: true };
      if (scenario === "read-policy-contract-drift") op.contractFingerprint = "synthetic-drift";
    });
    if (scenario === "read-policy-stop") {
      const cancellation = openFirestoreChatCancellation(config);
      try { const state = await cancellation.snapshot(); const op = Object.values(state.chatOperations).find(operation => operation.status === "RUNNING")!; await cancellation.request(state, user, op.id); }
      finally { await cancellation.close(); }
    }
    return { ...policyOutcome, reason: "RAW_SECRET_SENTINEL", model: "RAW_SECRET_SENTINEL" };
  }) : undefined;
  const originalControlClose = FirestoreChatCancellation.prototype.close;
  const controlClosing = scenario === "read-policy-control-close" ? vi.spyOn(FirestoreChatCancellation.prototype, "close").mockImplementation(async function (this: FirestoreChatCancellation) {
    await originalControlClose.call(this);
    if (this.ownsRecords && modelReleased && !toolCloseInjected) { toolCloseInjected = true; throw new Error("Synthetic stop-control disposal acknowledgement lost"); }
  }) : undefined;
  const originalRequested = FirestoreChatCancellation.prototype.requested;
  const controlRequested = ["read-policy-late-deadline", "read-policy-late-abort"].includes(scenario) ? vi.spyOn(FirestoreChatCancellation.prototype, "requested").mockImplementation(async function (this: FirestoreChatCancellation, operation, signal) {
    if (this.ownsRecords && policyRuntimeClosed) {
      if (scenario === "read-policy-late-deadline") await pause(1100);
      else externalAbort.abort();
    }
    return originalRequested.call(this, operation, signal);
  }) : undefined;
  let brokerOverride: ReturnType<typeof vi.spyOn> | undefined;
  let task: Promise<unknown> | undefined, independent: Promise<unknown> | undefined;
  const acquisition = vi.spyOn(FirestoreWriterOwnership.prototype, "acquire");
  const originalSave = FirestoreRecordPersistence.prototype.save;
  let faultInjected = false;
  const saving = vi.spyOn(FirestoreRecordPersistence.prototype, "save").mockImplementation(function (this: FirestoreRecordPersistence, payload) {
    const operations = Object.values(JSON.parse(Buffer.from(payload).toString()).chatOperations) as ChatOperation[];
    const status = scenario.startsWith("intent-") ? "DISPATCH_INTENT" : scenario.startsWith("result-") ? "DONE" : undefined;
    if (!faultInjected && status && operations.some(op => op.modelAttemptsSecret?.some(attempt => attempt.status === status))) {
      faultInjected = true; fixtures.database!.fault = scenario.endsWith("before-commit") ? "before-commit" : "after-commit";
    }
    if (!faultInjected && scenario.startsWith("read-policy-ack-") && operations.some(op => op.attempts.some(attempt => attempt.status === "FAILED" && attempt.output?.source === "local_model"))) {
      faultInjected = true; fixtures.database!.fault = scenario.endsWith("before") ? "before-commit" : "after-commit";
    }
    if (!faultInjected && scenario.startsWith("read-policy-terminal-ack-") && operations.some(op => op.status === "FAILED" && op.reason === "POLICY_DENIED")) {
      faultInjected = true; fixtures.database!.fault = scenario.endsWith("before") ? "before-commit" : "after-commit";
    }
    return originalSave.call(this, payload);
  });
  try {
    await withFunctionResources(input, async ({ repository }) => {
      const timestamp = new Date().toISOString();
      await repository.mutate(state => {
        state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: timestamp };
        state.workflows.independent = { id: "independent", name: "Unrelated draft", description: "Before held model", owner: { id: "owner", name: "Owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1,
          successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, archived: false,
          yaml: independentYaml };
        state.versions.independent = [];
      });
    });
    const admitted = await withFunctionRuntime(input, async ({ app }) => {
      const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} });
      expect(created.statusCode, created.body).toBe(201);
      const body: Record<string, unknown> = { content: ["generate", "generate-malformed-fallback", "generate-transport-no-fallback"].includes(scenario) || scenario.startsWith("final-close-") ? "Create a workflow to list invoices" : scenario === "node" ? "Edit selected node" : "Show me invoices",
        model: "model-a", delivery: "async-chat", idempotencyKey: "t29-held-model-original-task-0001" };
      if (scenario === "node") body.nodeContext = { workflowId: "independent", nodeId: "echo", baseVersion: 1, baseHash: workflowContentHash(independentYaml) };
      const response = await app.inject({ method: "POST", url: `/api/chat/sessions/${created.json().data.id}/messages`, headers, payload: body });
      expect(response.statusCode, response.body).toBe(202); return response.json().data.operation;
    });
    expect(sent).toHaveLength(1); expect(model).not.toHaveBeenCalled();
    if (scenario === "read-policy-stale") {
      let stale: unknown;
      await withFunctionRuntime(input, async ({ services }) => { try { await readBroker.dispatchReadTool(services, "owner", "demo.echo", { value: "fixture" }); } catch (error) { stale = error; } });
      expect(stale).toBeInstanceOf(Error);
      brokerOverride = vi.spyOn(readBroker, "dispatchReadTool").mockRejectedValue(stale);
    }
    if (scenario === "read-policy-counterfeit") {
      const originalDispatch = readBroker.dispatchReadTool;
      brokerOverride = vi.spyOn(readBroker, "dispatchReadTool").mockImplementation(async (...args) => {
        try { return await originalDispatch(...args); }
        catch (error) { throw Object.assign(new Error((error as Error).message), policyOutcome); }
      });
    }
    if (scenario === "stuck-body") model.mockImplementation(async () => {
      repositories.at(-1)!.assertAuthority(); dispatched();
      return { ok: true, json: async () => { await held; return { choices: [{ finish_reason: "stop", message: { content: "late ignored response" } }] }; } } as Response;
    });
    task = executeFunctionChatTask(input, sent[0]!, { timeoutMs: scenario.startsWith("stuck-") ? 600 : ["read-policy-deadline", "read-policy-late-deadline"].includes(scenario) ? 1000 : scenario === "read-policy-watch-deadline" ? 2000 : 10_000, signal: externalAbort.signal });
    // Attach rejection handlers immediately, including failures during cleanup.
    const taskOutcome = task.then(value => ({ value }), error => ({ error }));
    if (scenario.startsWith("intent-")) {
      expect(await taskOutcome).toMatchObject({ value: { id: admitted.id, status: "RECOVERY_REQUIRED" } });
      expect(faultInjected).toBe(true); expect(model).not.toHaveBeenCalled();
      const duplicate = await executeFunctionChatTask(input, sent[0]!, { timeoutMs: 10_000 }); expect(duplicate.status).toBe("RECOVERY_REQUIRED");
      expect(model).not.toHaveBeenCalled();
      expect(fixtures.clients.every(client => client.closed)).toBe(true); return;
    }
    await Promise.race([entered, pause(2000).then(() => { throw new Error("Original task never entered the controllable model transport"); })]);
    expect(model).toHaveBeenCalledOnce(); expect(modelReleased).toBe(false);
    const taskRepository = repositories.at(-1)!;
    const claims = observedClaims.get(admitted.id);
    expect(claims).toMatchObject({ status: "RUNNING", taskDispatchSecret: { taskId: sent[0]!.taskId }, taskLeaseSecret: { profile: "chat-task-lease/v1", workerId: claims!.workerId, epoch: claims!.epoch } });
    if (scenario === "duplicate") {
      await expect(executeFunctionChatTask(input, sent[0]!, { timeoutMs: 10_000 })).rejects.toThrow("still live");
      expect(model).toHaveBeenCalledOnce();
    }
    const opensBeforeSave = acquisition.mock.calls.length;
    let saved = false, visible = false, saveOwner: ApplicationResources["repository"] | undefined, readOwner: ApplicationResources["repository"] | undefined;
    independent = (async () => {
      await withFunctionRuntime(input, async ({ services, app }) => {
        saveOwner = services.repository;
        const response = await app.inject({ method: "PATCH", url: "/api/workflows/independent", headers, payload: { description: "Committed during held model" } });
        expect(response.statusCode, response.body).toBe(200); saved = true;
      });
      await withFunctionResources(input, async ({ repository }) => {
        readOwner = repository;
        visible = await repository.readAuthoritative(state => state.workflows.independent!.description === "Committed during held model");
      });
    })();
    const saveOutcome = independent.then(() => ({ done: true }), error => ({ error }));
    // This local budget is a finite causal observation, not a production SLO.
    // Cleanup releases the latch only after taking the pre-release observation.
    await Promise.race([saveOutcome, pause(1000)]);
    const beforeRelease = { modelReleased, saved, visible, acquisitionAttempts: acquisition.mock.calls.length - opensBeforeSave };
    expect(beforeRelease.acquisitionAttempts).toBeGreaterThan(0);
    if (scenario === "revocation" || scenario === "policy-switch") await withFunctionResources(input, async ({ repository }) => repository.mutate(state => {
      if (scenario === "revocation") state.users.owner!.status = "Inactive";
      else state.settings.rbac = { localPolicyEnabled: true };
    }));
    if (scenario === "cancel" || concurrentStop) {
      if (concurrentStop) await vi.waitFor(() => expect(watcherStream).toBeDefined(), { timeout: 1_500 });
      const cancellation = openFirestoreChatCancellation(config);
      try { const state = await cancellation.snapshot(); await cancellation.request(state, { ...state.users.owner!, role: "Platform Admin", permissions: state.roles.role_admin!.permissions }, admitted.id); }
      finally { await cancellation.close(); }
    }
    let disposalUnconfirmed: unknown;
    if (scenario.startsWith("stuck-")) {
      disposalUnconfirmed = await taskOutcome;
      expect(disposalUnconfirmed).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("disposal was not confirmed") }) });
    }
    if (heldWatcher) await vi.waitFor(() => expect(watcherStream).toBeDefined(), { timeout: 1_500 });
    releaseModel();
    if (heldWatcher) {
      await vi.waitFor(() => expect(concurrentStop ? concurrentStopObserved : policyRuntimeClosed).toBe(true), { timeout: 1_500 });
      // The entered observation stays held through the catch boundary.
      // Shutdown must await it, not poison its shared reader via abort.
      await pause(0);
      expect(FakeStopClient.instances.reduce((count, client) => count + client.cancels, 0)).toBe(0);
      if (scenario === "watch-concurrent-stop-failed") {
        watcherStream!.emit("data", { missing: watcherName + "-foreign" });
        watcherStream!.emit("status", { code: 0 }); watcherStream!.emit("end");
      }
      else if (scenario === "read-policy-watch-external") externalAbort.abort();
      else if (scenario !== "read-policy-watch-deadline") {
        if (scenario === "read-policy-watch-uncertain") watcherStream!.emit("error", new Error("Synthetic observer terminal status missing"));
        else {
          if (scenario === "read-policy-watch-stop") {
            const cancellation = openFirestoreChatCancellation(config);
            try { const state = await cancellation.snapshot(); await cancellation.request(state, { ...state.users.owner!, role: "Platform Admin", permissions: state.roles.role_admin!.permissions }, admitted.id); }
            finally { await cancellation.close(); }
            const packet = fixtures.database!.documents.get(watcherName.split("/documents/")[1]!);
            watcherStream!.emit("data", { found: { name: watcherName, fields: { profile: { stringValue: packet.profile }, payload: { bytesValue: packet.payload } } } });
          } else watcherStream!.emit("data", { missing: watcherName });
          watcherStream!.emit("status", { code: 0 }); watcherStream!.emit("end");
        }
      }
    }
    const cleanPolicy = ["read-policy-deny", "read-policy-review", "read-policy-invalid", "read-policy-unavailable", "read-policy-config", "read-policy-provider", "read-policy-watch-clean"].includes(scenario);
    const cancelled = scenario === "cancel" || scenario === "read-policy-watch-stop" || scenario === "watch-concurrent-stop-normal", fenced = ["revocation", "policy-switch", "tool-close", "final-close-preanswer", "generate-transport-no-fallback", "watch-concurrent-stop-failed"].includes(scenario) || scenario.startsWith("result-") || scenario.startsWith("stuck-") || scenario.startsWith("read-policy-");
    const expectedStatus = cancelled ? "CANCELLED" : cleanPolicy ? "FAILED" : fenced ? "RECOVERY_REQUIRED" : "ANSWERED";
    if (scenario.startsWith("final-close-") || scenario.startsWith("read-policy-terminal-") || scenario === "read-policy-contract-drift" || scenario === "read-policy-watch-uncertain") expect(await taskOutcome).toMatchObject({ error: expect.any(Error) });
    else if (!scenario.startsWith("stuck-")) expect(await taskOutcome).toMatchObject({ value: { id: admitted.id, status: expectedStatus } });
    if (scenario.startsWith("result-")) expect(faultInjected).toBe(true);
    expect(await saveOutcome).toEqual({ done: true });
    expect(saveOwner).not.toBe(taskRepository); expect(readOwner).not.toBe(saveOwner);
    await withFunctionResources(input, async ({ repository }) => {
      const state = await repository.snapshot();
      expect(state.workflows.independent!.description).toBe("Committed during held model");
       expect(state.chatOperations[admitted.id]!.status).toBe(expectedStatus);
      const answers = state.chats[admitted.sessionId]!.messages.filter(message => message.role === "assistant");
       expect(answers).toHaveLength(fenced || cancelled ? 0 : 1);
       if (!fenced && !cancelled) {
        expect(answers[0]).toMatchObject({ role: "assistant", operationId: admitted.id });
         if (!["tool", "generate", "generate-malformed-fallback", "node"].includes(scenario) && !scenario.startsWith("final-close-")) expect(answers[0]!.text).toContain("No confirmed ERP data was retrieved");
      }
       const attempts = state.chatOperations[admitted.id]!.modelAttemptsSecret ?? [];
      if (concurrentStop) {
        const op = state.chatOperations[admitted.id]!;
        expect(op.cancellationRequested).toBe(true); expect(op.attempts).toHaveLength(0);
        expect(op.reason).toBe(cancelled ? "PROCESSING_STOPPED" : "CHAT_PHASE_OUTCOME_UNCONFIRMED");
        expect(model).toHaveBeenCalledOnce(); expect(sdkCall).not.toHaveBeenCalled();
      }
      if (scenario.startsWith("read-policy-")) {
        const operation = state.chatOperations[admitted.id]!;
        if (scenario === "read-policy-watch-stop") expect(operation.cancellationRequested).toBe(true);
        expect(operation.reason).toBe(cancelled ? "PROCESSING_STOPPED" : cleanPolicy ? "failureCode" in policyOutcome ? policyOutcome.failureCode : scenario === "read-policy-review" ? "POLICY_REVIEW_REQUIRED" : scenario === "read-policy-unavailable" ? "POLICY_UNAVAILABLE" : "POLICY_DENIED" : "CHAT_PHASE_OUTCOME_UNCONFIRMED");
        expect(operation.attempts).toHaveLength(scenario === "read-policy-runtime-acquire" ? 0 : ["read-policy-unresolved-tool", "read-policy-late-unresolved-tool"].includes(scenario) ? 2 : 1);
        if (scenario !== "read-policy-runtime-acquire") {
          expect(operation.attempts[0]!.status).toBe("FAILED");
          if (["read-policy-ack-before", "read-policy-counterfeit", "read-policy-stale"].includes(scenario)) expect(operation.attempts[0]!.output).toBeUndefined();
          else expect(operation.attempts[0]!.output).toEqual(scenario === "read-policy-receipt-drift" ? { decision: "review", source: "local_model" } : policyOutcome);
        }
        expect(JSON.stringify(publicChatOperation(operation))).not.toContain("RAW_SECRET_SENTINEL");
        expect(state.chatOperationEvents[admitted.id]!.some(event => event.type === "tool.dispatch_intent")).toBe(scenario === "read-policy-journal-drift");
        expect(model).toHaveBeenCalledOnce(); expect(sdkCall).not.toHaveBeenCalled();
        if (scenario.startsWith("read-policy-ack-") || scenario.startsWith("read-policy-terminal-ack-")) expect(faultInjected).toBe(true);
        if (["read-policy-runtime-close", "read-policy-terminal-close", "read-policy-control-close"].includes(scenario)) expect(toolCloseInjected).toBe(true);
      }
      expect(JSON.stringify(publicChatOperation(state.chatOperations[admitted.id]!))).not.toMatch(/modelAttemptsSecret|resultCiphertext|provenanceId|configurationFingerprint/);
      for (const attempt of attempts.filter(attempt => attempt.status === "DONE")) {
        expect(state.invocationProvenance[attempt.provenanceId]).toMatchObject({ status: "SUCCEEDED", model: attempt.model });
        expect(attempt.resultCiphertext).toBeTypeOf("string");
      }
       if (cancelled && !heldWatcher) {
         expect(state.chatOperations[admitted.id]!.cancellationRequested).toBe(true);
         expect(attempts).toHaveLength(1);
         expect(attempts[0]).toMatchObject({ status: "UNKNOWN", completedAt: expect.any(String) });
         expect(attempts[0]!.resultCiphertext).toBeUndefined();
       }
       if (scenario === "generate-malformed-fallback") {
         expect(attempts.map(attempt => [attempt.model, attempt.status])).toEqual([["model-a", "FAILED"], ["model-b", "DONE"]]);
         expect(new Set(attempts.map(attempt => attempt.id)).size).toBe(2);
         expect(state.invocationProvenance[attempts[0]!.provenanceId]).toMatchObject({ model: "model-a", status: "FAILED", fallbackUsed: false });
         expect(answers[0]!.modelBinding).toMatchObject({ model: "model-b", requestedModel: "model-a", fallbackUsed: true });
         expect(state.invocationProvenance[attempts[1]!.provenanceId]).toMatchObject({ model: "model-b", fallbackUsed: true });
       }
       if (scenario === "generate-transport-no-fallback") expect(attempts.map(attempt => [attempt.model, attempt.status])).toEqual([["model-a", "UNKNOWN"]]);
    });
    if (scenario === "tool") { expect(sdkCall).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledTimes(2); }
    else if (scenario === "tool-close") { expect(sdkCall).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledOnce(); }
    else expect(sdkCall).not.toHaveBeenCalled();
    if (scenario.startsWith("final-close-")) expect(finalCloseInjected).toBe(true);
    if (scenario === "generate-malformed-fallback") expect(model).toHaveBeenCalledTimes(2);
    if (scenario === "generate-transport-no-fallback") expect(model).toHaveBeenCalledOnce();
    const previousCalls = model.mock.calls.length;
    if (scenario === "read-policy-contract-drift") await expect(executeFunctionChatTask(input, sent[0]!, { timeoutMs: 10_000 })).rejects.toThrow("Chat task identity or dispatch history changed");
    else await executeFunctionChatTask(input, sent[0]!, { timeoutMs: 10_000 });
    expect(model).toHaveBeenCalledTimes(previousCalls);
    expect(fixtures.clients.every(client => client.closed)).toBe(true);
    if (heldWatcher && scenario !== "read-policy-watch-uncertain") expect(FakeStopClient.instances.every(client => client.closed)).toBe(true);
    expect(beforeRelease, `T29 causal failure: ${JSON.stringify(beforeRelease)}; actual save and fresh-owner readback must finish within 1000ms BEFORE model release`).toMatchObject({ modelReleased: false, saved: true, visible: true });
  } finally {
    releaseModel();
    FakeStopClient.onRead = undefined;
    if (watcherStream) { watcherStream.emit("status", { code: 1 }); watcherStream.emit("close"); }
    await Promise.allSettled([...(task ? [task] : []), ...(independent ? [independent] : [])]);
    await Promise.allSettled(bridges.map(bridge => bridge.close()));
    for (const unsubscribe of unobserve) unsubscribe();
    saving.mockRestore(); acquisition.mockRestore(); policyReceipt?.mockRestore(); brokerOverride?.mockRestore(); controlClosing?.mockRestore(); controlRequested?.mockRestore(); fixtures.construct.mockReset(); fixtures.opened.mockReset();
  }
}, 15_000);
