import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import jwt from "jsonwebtoken";
import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { withFunctionResources, withFunctionRuntime } from "../src/firebase/invocation.js";
import { executeFunctionChatTask } from "../src/firebase/chat-task.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { OpenAICompatibleClient, generationRequestBody } from "../src/providers/openai-compatible.js";
import { LOCAL_POLICY_V2_SYSTEM_PROMPT } from "../src/prompts/contracts.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import type { ChatTaskCommand } from "../src/agent/chat-task-outbox.js";
import type { ApplicationResources } from "../src/entrypoints/application-runtime.js";
import { Repository, type ChatOperation } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { prepareOptionalPolicy } from "../src/governance/optional-policy.js";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";

const fixtures = vi.hoisted(() => ({ database: null as Database | null, clients: [] as FakeClient[], construct: vi.fn(), opened: vi.fn(), fileDrift: false, policyPath: "", restoreAfterDriftRead: false, driftReads: 0 }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class {
  constructor(settings: unknown) { const client = new FakeClient(fixtures.database!, settings); fixtures.clients.push(client); return client; }
}, default: { v1: { FirestoreClient: class { constructor(settings: unknown) { return new FakeStopClient(fixtures.database!, settings); } } } } }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: any[]) => {
    const raw = await (actual.readFile as any)(...args);
    // Observe a changed file through the actual read boundary; never edit the
    // release policy or substitute its parser/evaluator with a canned decision.
    if (fixtures.fileDrift && String(args[0]) === fixtures.policyPath) {
      fixtures.driftReads++;
      if (fixtures.restoreAfterDriftRead) fixtures.fileDrift = false;
      return typeof raw === "string" ? raw + "\n" : Buffer.concat([raw, Buffer.from("\n")]);
    }
    return raw;
  } };
});
vi.mock("../src/entrypoints/application-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/entrypoints/application-runtime.js")>();
  return { ...actual, openApplicationResources: async (...args: Parameters<typeof actual.openApplicationResources>) => {
    const resources = await actual.openApplicationResources(...args); fixtures.opened(resources); return resources;
  }, constructApplicationRuntime: fixtures.construct };
});
function gate() { let release!: () => void; const promise = new Promise<void>(resolveGate => { release = resolveGate; }); return { promise, release }; }
async function enteredBefore<T>(pending: Promise<T>, timeoutMs = 2_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture dispatch did not enter")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

const cases = ["allow", "deny", "review", "deny-continuation-failure", "review-continuation-failure", "deny-answer-before", "deny-answer-after", "deny-answer-close", "allow-answer-before", "allow-answer-after", "allow-answer-close", "allow-answer-guard", "allow-answer-guard-close", "disconnected-answer", "disconnected-answer-close", "invalid-json", "length", "provider-429", "provider-401", "provider-503", "malformed-envelope", "transport",
  "intent-before", "intent-after", "result-before", "result-after", "setup-close", "result-close", "mismatched-wire", "single-use",
  "actor", "role", "permissions", "settings", "provider", "egress", "connection", "contracts", "node", "policy-file", "epoch", "worker", "expiry", "unresolved",
  "cancel-headers", "cancel-body", "deadline-headers", "deadline-body", "raw-cleanup-rejected", "raw-cleanup-held", "result-deadline", "duplicate", "pre-aborted",
  "consumption-unchanged", "consumption-policy-drift", "consumption-result-unchanged", "consumption-result-drift",
  "consumption-publication-unchanged", "consumption-publication-revert"] as const;
test.each(cases)("detached local-policy phase preserves original authority, one attempt and cleanup (%s)", async scenario => {
  fixtures.database = new Database(); fixtures.clients = []; fixtures.fileDrift = false; fixtures.restoreAfterDriftRead = false; fixtures.driftReads = 0;
  FakeStopClient.instances = []; FakeStopClient.hold = false; FakeStopClient.onRead = undefined;
  const resources: ApplicationResources[] = [], bridges: Array<{ close(): Promise<void> }> = [], sent: ChatTaskCommand[] = [];
  const entered = gate(), held = gate(), bodyRead = gate(), cancelBody = gate();
  const continuationDiscovery = gate(), releaseContinuationDiscovery = gate();
  const answerEntered = gate(), releaseAnswer = gate();
  const consumptionCase = scenario.startsWith("consumption-");
  const resultWaitCase = scenario.startsWith("consumption-result-");
  const publicationCase = scenario.startsWith("consumption-publication-");
  const requestContent = scenario === "node" ? "Edit selected node" : publicationCase ? "Generate a workflow with demo.echo" : "Show me invoices";
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", MCP_MODE: "mock", FIRESTORE_PROJECT_ID: "demo-policy-phase", FIRESTORE_DATABASE_ID: "(default)",
    FIRESTORE_WORKSPACE_ID: "policy_phase_fixture", STORAGE_ENCRYPTION_KEY: "p".repeat(32), JWT_SECRET: "policy-phase-synthetic-secret-at-least-32-bytes", GOVERNANCE_FALLBACK_POLICY_PATH: resolve("policy/governance_fallback.json") });
  fixtures.policyPath = config.governanceFallbackPolicyPath;
  config.toolRegistryPath = resolve("tests/fixtures/chat-read-tools.json"); config.ruleRegistryPath = resolve("tests/fixtures/rules.json"); config.erpbridgeRoleMap = { "Platform Admin": "admin" };
  let policyCalls = 0, answerCalls = 0, closeInjected = false, drift = false, operationId = "", faultInjected = false, policyResultClosed = false, postDecisionConstructs = 0;
  let policyResultAcked = false, continuationDiscoveryCalls = 0, businessToolCalls = 0;
  let publicationBoundaryObserved = false;
  let answerGuardChanged = false, answerGuardAcked = false;
  const yaml = "name: Independent\ndescription: Synthetic\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fixture";
  fixtures.opened.mockImplementation((opened: ApplicationResources) => {
    resources.push(opened);
    if (scenario.startsWith("allow-answer-guard")) {
      const close = opened.repository.close.bind(opened.repository);
      vi.spyOn(opened.repository, "close").mockImplementation(async () => {
        const queryDone = await opened.repository.read(state => Object.values(state.chatOperations).some(operation => operation.status === "RUNNING" &&
          operation.modelAttemptsSecret?.length === 2 && operation.modelAttemptsSecret.every(attempt => attempt.status === "DONE"))).catch(() => false);
        await close();
        if (queryDone && !answerGuardChanged) {
          // The actual second model result was persisted and its owner closed.
          // A distinct owner then revokes the actor before the answer scope.
          answerGuardChanged = true;
          await withFunctionResources(composition, async ({ repository }) => repository.mutate(state => { state.users.owner!.status = "Inactive"; }));
          answerGuardAcked = true;
        } else if (queryDone && answerGuardAcked && scenario === "allow-answer-guard-close" && !closeInjected) {
          closeInjected = true; throw new Error("Synthetic close failure replaced the original prepublication guard rejection");
        }
      });
    }
    if (scenario.includes("continuation-failure") || consumptionCase) {
      const close = opened.repository.close.bind(opened.repository);
      vi.spyOn(opened.repository, "close").mockImplementation(async () => {
        const recorded = await opened.repository.read(state => Object.values(state.chatOperations).some(operation => operation.status === "RUNNING" &&
          operation.modelAttemptsSecret?.some(attempt => attempt.purpose === "POLICY_PREFLIGHT" && attempt.status === "DONE")) &&
          state.auditLogs.some(audit => audit.action === "optional_policy.evaluated" && (consumptionCase ? ["allow"] : ["deny", "review"]).includes(String((audit.after as any)?.decision)))).catch(() => false);
        await close(); if (recorded) {
          if (consumptionCase) expect(policyResultAcked, "the actual policy receipt/provenance/final-audit save must ACK before its owner closes").toBe(true);
          policyResultClosed = true;
        }
      });
    }
    if (["setup-close", "result-close", "deny-answer-close", "allow-answer-close", "disconnected-answer-close"].includes(scenario)) {
      const close = opened.repository.close.bind(opened.repository);
      vi.spyOn(opened.repository, "close").mockImplementation(async () => {
        const inject = !closeInjected && await opened.repository.read(state => Object.values(state.chatOperations).some(operation =>
          (!scenario.includes("answer-close") || operation.status === "ANSWERED") && operation.modelAttemptsSecret?.some(attempt => attempt.purpose === "POLICY_PREFLIGHT" && attempt.status === (scenario === "setup-close" ? "DISPATCH_INTENT" : "DONE")))).catch(() => false);
        await close(); if (inject) { closeInjected = true; throw new Error("synthetic owned phase cleanup unconfirmed"); }
      });
    }
  });
  fixtures.construct.mockImplementation(async ({ repository, registries }: ApplicationResources) => {
    expect(repository.persistence).toBeInstanceOf(FirestoreRecordPersistence); repository.assertAuthority();
    if (policyResultClosed && scenario.includes("continuation-failure")) { postDecisionConstructs++; throw new Error("post-decision MCP construction must not run for known policy stop"); }
    if (drift && scenario === "contracts") { const snapshot = registries.snapshot.bind(registries); vi.spyOn(registries, "snapshot").mockImplementation(() => {
      const value = structuredClone(snapshot()); value.tools[0]!.description += " changed"; return value;
    }); }
    const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
    const bridge = await createErpbridgeMcpSession({ baseURL: drift && scenario === "connection" ? "https://changed-sdk.example.test" : "https://policy-sdk.example.test", token: "synthetic-token", timeoutMs: 1000, validator,
      sdkClient: { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => {
        if (consumptionCase && policyResultClosed && continuationDiscoveryCalls++ === 0) {
          // Hold only the actual continuation discovery, after the original
          // local inference, receipt/provenance/audit ACK and owned phase close.
          await repository.readAuthoritative(state => {
            const operation = state.chatOperations[operationId]!;
            expect(operation.status).toBe("RUNNING");
            expect(operation.modelAttemptsSecret).toHaveLength(1);
            const attempt = operation.modelAttemptsSecret![0]!;
            expect(attempt).toMatchObject({ purpose: "POLICY_PREFLIGHT", status: "DONE" });
            expect(state.invocationProvenance[attempt.provenanceId]).toMatchObject({ promptTemplateVersion: "prompt/local-policy/v2", status: "SUCCEEDED" });
            expect(state.auditLogs.filter(audit => audit.action === "optional_policy.evaluated")).toMatchObject([{ after: { decision: "allow" } }]);
          });
          continuationDiscovery.release(); await releaseContinuationDiscovery.promise;
        }
        return registries.snapshot().tools.map(tool => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema }));
      }), callTool: vi.fn(async () => { businessToolCalls++; throw new Error("policy preflight cannot dispatch a business tool"); }) } }); bridges.push(bridge);
    const literalFetch: typeof fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      if (wire.messages[0]?.content !== LOCAL_POLICY_V2_SYSTEM_PROMPT) {
        answerCalls++;
        if (resultWaitCase) { answerEntered.release(); await releaseAnswer.promise; }
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: publicationCase ? yaml : "Synthetic answer." } }] });
      }
      repository.assertAuthority(); policyCalls++;
      const prompt = JSON.parse(wire.messages[1].content);
      expect(prompt.actor).toEqual({ id: "owner", role: "Platform Admin" }); expect(prompt.policy.version).toBe("1.0.0"); expect(prompt.request).toBe(requestContent);
      expect(wire.max_tokens).toBe(1024); expect(wire.model).toBe("model-a"); entered.release();
      if (["cancel-body", "deadline-body", "raw-cleanup-held", "raw-cleanup-rejected"].includes(scenario)) return { ok: true, body: { getReader: () => ({
        read: async () => { await bodyRead.promise; return { done: false, value: new TextEncoder().encode("ignored late body") }; },
        cancel: async () => { if (scenario === "raw-cleanup-held") await cancelBody.promise; if (scenario === "raw-cleanup-rejected") throw new Error("private raw cancel diagnostic"); }, releaseLock: () => {},
      }) } } as unknown as Response;
      await held.promise;
      if (scenario === "transport") throw new Error("private synthetic transport failure");
      if (scenario.startsWith("provider-")) return new Response("", { status: Number(scenario.slice("provider-".length)) });
      if (scenario === "malformed-envelope") return Response.json({ unknown: true });
      const content = scenario === "invalid-json" ? '{"decision":"allow","extra":true}' : JSON.stringify({ decision: scenario.startsWith("deny") ? "deny" : scenario.startsWith("review") ? "review" : "allow", reason: "Dynamic synthetic policy decision." });
      return Response.json({ choices: [{ finish_reason: scenario === "length" ? "length" : "stop", message: { content } }], usage: { prompt_tokens: 8, completion_tokens: 9 } });
    };
    const providerRuntime = new ProviderRuntime(repository, executor, literalFetch);
    providerRuntime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://policy-model.example.test/v1", apiKey: "synthetic-key", model: "model-a", temperature: drift && scenario === "provider" ? 1 : 0, timeoutMs: 10_000,
      egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://policy-model.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: drift && scenario === "egress" ? [] : ["restricted"],
        reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "owner", name: "Owner" } } });
    return { services: { config, repository, registries, validator, executor, ...(scenario.startsWith("disconnected-answer") ? {} : { erpbridgeSession: bridge }), providerRuntime, synthesis: new SynthesisService(providerRuntime, registries, validator) } };
  });
  const originalSave = FirestoreRecordPersistence.prototype.save;
  vi.spyOn(FirestoreRecordPersistence.prototype, "save").mockImplementation(async function (this: FirestoreRecordPersistence, payload) {
    const state = JSON.parse(Buffer.from(payload).toString()), attempts = (Object.values(state.chatOperations) as ChatOperation[]).flatMap(operation => operation.modelAttemptsSecret ?? []);
    const intent = attempts.some(attempt => attempt.purpose === "POLICY_PREFLIGHT" && attempt.status === "DISPATCH_INTENT"), result = attempts.some(attempt => attempt.purpose === "POLICY_PREFLIGHT" && attempt.status === "DONE");
    if (!faultInjected && ["deny-answer-before", "deny-answer-after", "allow-answer-before", "allow-answer-after"].includes(scenario) && Object.values(state.chatOperations).some((operation: any) => operation.status === "ANSWERED")) {
      faultInjected = true; fixtures.database!.fault = scenario.endsWith("before") ? "before-commit" : "after-commit";
    }
    if (!faultInjected && (scenario.startsWith("intent-") && intent || scenario.startsWith("result-") && result)) {
      faultInjected = true;
      if (scenario === "result-deadline") await pause(1_700);
      else fixtures.database!.fault = scenario.endsWith("before") ? "before-commit" : "after-commit";
    }
    const acknowledged = await originalSave.call(this, payload);
    if (consumptionCase && result) {
      const operation = state.chatOperations[operationId] as ChatOperation;
      const attempt = operation?.modelAttemptsSecret?.find(item => item.purpose === "POLICY_PREFLIGHT" && item.status === "DONE");
      if (operation?.status === "RUNNING" && attempt && state.invocationProvenance[attempt.provenanceId]?.status === "SUCCEEDED" &&
          state.auditLogs.some((audit: any) => audit.action === "optional_policy.evaluated" && audit.after?.decision === "allow")) policyResultAcked = true;
    }
    if (publicationCase && !publicationBoundaryObserved) {
      const operation = state.chatOperations[operationId] as ChatOperation;
      if (operation?.status === "RUNNING" && operation.stage === "GENERATING" && operation.modelAttemptsSecret?.length === 2 &&
          operation.modelAttemptsSecret.every(attempt => attempt.status === "DONE") && state.auditLogs.some((audit: any) => audit.action.startsWith("validation.gate."))) {
        // The real generated-candidate validator has persisted and ACKed its
        // audit. The next policy read is the existing beforeCommit hook inside
        // chatMutation. Its ordinary error is caught by the draft-save path.
        publicationBoundaryObserved = true;
        if (scenario === "consumption-publication-revert") { fixtures.fileDrift = true; fixtures.restoreAfterDriftRead = true; }
      }
    }
    return acknowledged;
  });
  if (["mismatched-wire", "single-use"].includes(scenario)) {
    const originalGenerate = OpenAICompatibleClient.prototype.generate;
    vi.spyOn(OpenAICompatibleClient.prototype, "generate").mockImplementation(function (this: OpenAICompatibleClient, prompt, model, signal, context) {
      if (context?.promptTemplateVersion !== "prompt/local-policy/v2") return originalGenerate.call(this, prompt, model, signal, context);
      if (scenario === "mismatched-wire") return originalGenerate.call(this, prompt + "changed", model, signal, context);
      return Promise.all([originalGenerate.call(this, prompt, model, signal, context), originalGenerate.call(this, prompt, model, signal, context)]).then(responses => responses[0]!);
    });
  }
  const composition = { config, root: process.cwd(), transport: { timeoutMs: 1000, enqueue: vi.fn(async (command: { taskId: string }) => ({ taskId: command.taskId, outcome: "CREATED" as const })) },
    chatTransport: { timeoutMs: 1000, enqueue: vi.fn(async (command: ChatTaskCommand) => { sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" as const }; }) } };
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` }, controller = new AbortController();
  let task: Promise<unknown> | undefined;
  try {
    await withFunctionResources(composition, async ({ repository }) => repository.mutate(state => {
      const timestamp = new Date().toISOString(); state.settings.rbac = { enabled: false, localPolicyAgentEnabled: true };
      state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: timestamp };
      state.workflows.independent = { id: "independent", name: "Independent", description: "Before", owner: { id: "owner", name: "Owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1,
        successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, archived: false, yaml }; state.versions.independent = [];
    }));
    operationId = await withFunctionRuntime(composition, async ({ app }) => {
      const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} }); expect(created.statusCode).toBe(201);
      const response = await app.inject({ method: "POST", url: `/api/chat/sessions/${created.json().data.id}/messages`, headers,
        payload: { content: requestContent, model: "model-a", delivery: "async-chat", idempotencyKey: "actual-policy-phase-safety-0001",
          ...(scenario === "node" ? { nodeContext: { workflowId: "independent", nodeId: "echo", baseVersion: 1, baseHash: workflowContentHash(yaml) } } : {}) } });
      expect(response.statusCode, response.body).toBe(202); return response.json().data.operation.id;
    });
    if (scenario === "pre-aborted") controller.abort();
    task = executeFunctionChatTask(composition, sent[0]!, { timeoutMs: scenario.startsWith("deadline-") || scenario === "result-deadline" ? 1_500 : 10_000, signal: controller.signal });
    const outcome = task.then(value => ({ value }), error => ({ error }));
    const noEntry = ["intent-before", "intent-after", "mismatched-wire", "pre-aborted"].includes(scenario);
    if (!noEntry) {
      await enteredBefore(entered.promise);
      // A fresh owner can mutate authority while the actual local inference is
      // pending. These checks deliberately never reuse the dispatch repository.
      if (["actor", "role", "permissions", "settings", "node", "epoch", "worker", "expiry", "unresolved"].includes(scenario)) await withFunctionResources(composition, async ({ repository }) => repository.mutate(state => {
        const operation = state.chatOperations[operationId]!;
        if (scenario === "actor") state.users.owner!.status = "Inactive";
        if (scenario === "role") state.roles.role_admin!.name = "Changed role";
        if (scenario === "permissions") state.roles.role_admin!.permissions.push("changed:permission");
        if (scenario === "settings") state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false };
        if (scenario === "node") { state.workflows.independent!.draftVersion = 2; state.workflows.independent!.yaml = yaml.replace("Synthetic", "Changed"); }
        if (scenario === "epoch") operation.epoch++;
        if (scenario === "worker") operation.workerId = "other-worker";
        if (scenario === "expiry") (operation.taskLeaseSecret as any).expiresAt = new Date(Date.now() - 1).toISOString();
        if (scenario === "unresolved") (operation.modelAttemptsSecret ??= []).push({ ...operation.modelAttemptsSecret![0]!, id: "other-unresolved", status: "UNKNOWN" });
      }));
      if (["provider", "egress", "connection", "contracts"].includes(scenario)) drift = true;
      if (scenario === "policy-file") fixtures.fileDrift = true;
      if (scenario === "duplicate") await expect(executeFunctionChatTask(composition, sent[0]!, { timeoutMs: 10_000 })).rejects.toThrow("still live");
      if (scenario.startsWith("deadline-")) await pause(1_700);
      if (scenario.startsWith("cancel-") || scenario.startsWith("raw-cleanup-")) controller.abort();
      if (scenario === "raw-cleanup-held") { bodyRead.release(); await pause(1_100); }
    }
    held.release(); bodyRead.release();
    if (consumptionCase) {
      await enteredBefore(continuationDiscovery.promise);
      expect(policyResultAcked).toBe(true); expect(policyResultClosed).toBe(true);
      expect(policyCalls).toBe(1); expect(answerCalls).toBe(0); expect(businessToolCalls).toBe(0);
      if (scenario === "consumption-policy-drift") fixtures.fileDrift = true;
      releaseContinuationDiscovery.release();
      if (resultWaitCase) {
        await enteredBefore(answerEntered.promise);
        expect(policyCalls).toBe(1); expect(answerCalls).toBe(1);
        if (scenario === "consumption-result-drift") fixtures.fileDrift = true;
        releaseAnswer.release();
      }
    }
    const result = await outcome;
    const known = ["allow", "deny", "review", "disconnected-answer", "deny-continuation-failure", "review-continuation-failure", "invalid-json", "length", "provider-429", "provider-401", "provider-503", "malformed-envelope", "duplicate", "consumption-unchanged", "consumption-result-unchanged", "consumption-publication-unchanged"].includes(scenario);
    if (scenario.includes("continuation-failure")) {
      expect(policyResultClosed, "actual policy DONE receipt and final nonallow audit were ACKed and their owned phase closed before this observation").toBe(true);
      expect.soft(postDecisionConstructs, "known nonallow policy must not construct a later MCP/runtime scope").toBe(0);
    }
    if (known) expect.soft(result).toMatchObject({ value: { id: operationId, status: "ANSWERED" } });
    if (scenario.startsWith("deny-answer-")) expect(result, "uncertain denial answer ACK/owned cleanup must propagate instead of returning a clean terminal receipt").toMatchObject({ error: expect.any(Error) });
    if (scenario.startsWith("allow-answer-") && scenario !== "allow-answer-guard" || scenario === "disconnected-answer-close") expect.soft(result, "normal/disconnected answer ACK or owned close failure must not be swallowed into a clean terminal receipt").toMatchObject({ error: expect.any(Error) });
    if (scenario === "allow-answer-guard") expect(result, "a prepublication authority rejection with confirmed cleanup remains a known failed receipt").toMatchObject({ value: { status: "FAILED" } });
    await withFunctionResources(composition, async ({ repository }) => repository.readAuthoritative(state => {
      const operation = state.chatOperations[operationId]!, attempts = (operation.modelAttemptsSecret ?? []).filter(attempt => attempt.purpose === "POLICY_PREFLIGHT"), provenance = Object.values(state.invocationProvenance).filter(invocation => invocation.promptTemplateVersion === "prompt/local-policy/v2"), audits = state.auditLogs.filter(audit => audit.action === "optional_policy.evaluated");
      expect(policyCalls).toBe(noEntry ? 0 : 1); expect(attempts.length).toBeLessThanOrEqual(2);
      if (known) {
        expect(attempts).toHaveLength(1); expect(provenance).toHaveLength(1); expect(audits).toHaveLength(1);
        const allow = ["allow", "duplicate", "consumption-unchanged", "consumption-result-unchanged", "consumption-publication-unchanged"].includes(scenario); expect(answerCalls).toBe(allow ? 1 : 0);
        expect((audits[0]!.after as any).decision).toBe(allow || scenario === "disconnected-answer" ? "allow" : scenario.startsWith("review") ? "review" : "deny");
        expect(provenance[0]!.status).toBe(scenario.startsWith("provider-") || scenario === "malformed-envelope" ? "FAILED" : "SUCCEEDED");
      } else {
        if (scenario === "consumption-policy-drift") expect.soft(answerCalls, "an observed local-policy hash change during continuation discovery must fence every subsequent model dispatch").toBe(0);
        else expect(answerCalls).toBe(scenario === "consumption-result-drift" || scenario === "consumption-publication-revert" || scenario.startsWith("allow-answer-") ? 1 : 0);
        if (!["deny-answer-after", "deny-answer-close", "allow-answer-after", "allow-answer-close", "disconnected-answer-close"].includes(scenario) && !consumptionCase) expect(operation.status).not.toBe("ANSWERED");
        expect(provenance.length).toBeLessThanOrEqual(1); expect(audits.length).toBeLessThanOrEqual(1);
      }
      if (scenario.startsWith("intent-") || scenario.startsWith("result-")) expect(faultInjected).toBe(true);
      if (["deny-answer-before", "deny-answer-after"].includes(scenario)) { expect(faultInjected).toBe(true); expect(provenance).toHaveLength(1); expect(audits).toHaveLength(1); }
      if (["allow-answer-before", "allow-answer-after"].includes(scenario)) { expect(faultInjected).toBe(true); expect(answerCalls).toBe(1); }
      if (["setup-close", "result-close", "deny-answer-close", "allow-answer-close", "disconnected-answer-close"].includes(scenario)) expect(closeInjected).toBe(true);
      if (scenario.startsWith("allow-answer-") || scenario.startsWith("disconnected-answer")) {
        expect(businessToolCalls).toBe(0); expect(operation.attempts).toHaveLength(0);
        const messages = state.chats[operation.sessionId]!.messages;
        expect(messages.filter(message => message.role === "assistant").length).toBeLessThanOrEqual(1);
        expect(policyCalls).toBe(1);
        if (scenario.includes("answer-close")) {
          expect(operation.status).toBe("ANSWERED"); expect(operation.modelAttemptsSecret!.every(attempt => attempt.status === "DONE")).toBe(true);
          expect(messages.filter(message => message.role === "assistant")).toHaveLength(1);
        }
        if (scenario === "disconnected-answer") expect(messages.at(-1)!.text).toContain("ERPBridge is not connected");
        if (scenario.startsWith("allow-answer-guard")) {
          expect(answerGuardChanged).toBe(true); expect(answerGuardAcked).toBe(true); expect(operation.assistantMessageId).toBeUndefined();
          expect(messages.filter(message => message.role === "assistant")).toHaveLength(0);
          expect(operation.status).toBe(scenario === "allow-answer-guard" ? "FAILED" : "RECOVERY_REQUIRED");
          expect(closeInjected).toBe(scenario === "allow-answer-guard-close");
        }
      }
      if (consumptionCase) {
        expect(continuationDiscoveryCalls).toBe(publicationCase ? 2 : 1); expect(businessToolCalls).toBe(0);
        expect(attempts).toHaveLength(1); expect(provenance).toHaveLength(1); expect(audits).toHaveLength(1);
        if (scenario.endsWith("-drift")) {
          expect.soft(operation.modelAttemptsSecret, "stale preflight consumption must not acknowledge another model attempt").toHaveLength(resultWaitCase ? 2 : 1);
          expect.soft(["FAILED", "RECOVERY_REQUIRED"], "the original task must retain failure/recovery without policy re-evaluation or a published answer").toContain(operation.status);
          if (resultWaitCase) {
            expect(operation.status).toBe("RECOVERY_REQUIRED");
            expect(operation.modelAttemptsSecret![1]!).toMatchObject({ status: "UNKNOWN" });
            expect(state.invocationProvenance[operation.modelAttemptsSecret![1]!.provenanceId]).toBeUndefined();
          }
        }
        if (publicationCase) {
          expect(publicationBoundaryObserved, "real generated-candidate validation audit ACK must precede publication observation").toBe(true);
          expect(operation.modelAttemptsSecret).toHaveLength(2);
          expect(operation.modelAttemptsSecret!.every(attempt => attempt.status === "DONE")).toBe(true);
          if (scenario === "consumption-publication-revert") {
            expect(fixtures.driftReads, "first publication hook observed mismatch, then the file observation was restored").toBe(1);
            expect(fixtures.fileDrift).toBe(false);
            expect(operation.status, "restoration after the swallowed save error must not restore authority for an answer").toBe("RECOVERY_REQUIRED");
            expect(operation.assistantMessageId).toBeUndefined(); expect(operation.artifactRefs ?? []).toHaveLength(0);
            expect(Object.keys(state.workflows)).toEqual(["independent"]);
          } else expect(Object.keys(state.workflows)).toHaveLength(2);
        }
      }
    }));
    if (known) { const duplicate = await executeFunctionChatTask(composition, sent[0]!, { timeoutMs: 10_000 }); expect(duplicate.status).toBe("ANSWERED"); expect(policyCalls).toBe(1); }
  } finally {
    held.release(); bodyRead.release(); cancelBody.release(); releaseContinuationDiscovery.release(); releaseAnswer.release(); fixtures.fileDrift = false; fixtures.restoreAfterDriftRead = false; FakeStopClient.onRead = undefined;
    await Promise.allSettled(task ? [task] : []); await Promise.allSettled(bridges.map(bridge => bridge.close())); await Promise.allSettled(resources.map(resource => resource.close()));
    vi.restoreAllMocks(); fixtures.construct.mockReset(); fixtures.opened.mockReset();
  }
  expect(fixtures.clients.every(client => client.closed)).toBe(true); expect(FakeStopClient.instances.every(client => client.closed)).toBe(true);
}, 20_000);

test("shared generation body preserves dynamic policy prompt and exact qualified DeepSeek fields", () => {
  const context = { promptTemplateVersion: "prompt/local-policy/v2", maxOutputTokens: 1024 };
  const body = generationRequestBody("https://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash", 0, '{"request":"dynamic user input"}', context);
  expect(body).toEqual({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "system", content: LOCAL_POLICY_V2_SYSTEM_PROMPT }, { role: "user", content: '{"request":"dynamic user input"}' }],
    temperature: 0, max_tokens: 1024, response_format: { type: "json_object" }, reasoning: { enabled: false } });
  expect(generationRequestBody("https://openrouter.ai.evil.test/api/v1", "deepseek/deepseek-v4.1-flash", 0, "dynamic", context)).not.toHaveProperty("response_format");
});

const selections = [
  { remote: false, local: false, outcome: "allow", kind: "decision", calls: 0, fallback: false, source: "skipped" },
  { remote: false, local: true, outcome: "allow", kind: "local", calls: 0, fallback: false },
  { remote: true, local: false, outcome: "allow", kind: "decision", calls: 1, fallback: false, source: "erpbridge" },
  { remote: true, local: true, outcome: "allow", kind: "decision", calls: 1, fallback: false, source: "erpbridge" },
  { remote: true, local: true, outcome: "network", kind: "local", calls: 1, fallback: true },
  { remote: true, local: true, outcome: "forbidden", kind: "decision", calls: 1, fallback: false, source: "erpbridge" },
  { remote: true, local: true, outcome: "malformed", kind: "decision", calls: 1, fallback: false, source: "erpbridge" },
  { remote: true, local: false, outcome: "network", kind: "decision", calls: 1, fallback: false, source: "erpbridge" },
  { remote: true, local: true, outcome: "missing", kind: "local", calls: 0, fallback: true },
  { remote: true, local: false, outcome: "missing", kind: "decision", calls: 0, fallback: false, source: "erpbridge" },
] as const;
test.each(selections)("detached preparation preserves switches/remote classification without starting inference (%j)", async selection => {
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", GOVERNANCE_FALLBACK_POLICY_PATH: resolve("policy/governance_fallback.json") });
  const repository = await Repository.open(null), registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const fetchModel = vi.fn<typeof fetch>(async () => { throw new Error("preparation must never dispatch inference"); });
  const runtime = new ProviderRuntime(repository, executor, fetchModel);
  runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://policy-model.example.test/v1", apiKey: "synthetic-key", model: "model-a", temperature: 0, timeoutMs: 1000 });
  await repository.mutate(state => {
    state.settings.rbac = { enabled: selection.remote, localPolicyAgentEnabled: selection.local };
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
  });
  const user = (await repository.effectiveUser("owner"))!, snapshot = registries.snapshot.bind(registries);
  if (selection.outcome !== "missing") vi.spyOn(registries, "snapshot").mockImplementation(() => ({ ...snapshot(), tools: [...snapshot().tools, toolSchema.parse({
    tool_id: "POLICY-PREPARE", name: "qa.policy", mcp_tool_name: "policy-gate-evaluate", description: "Reviewed synthetic policy checker", is_read_only: true, allowed_roles: [user.role],
    input_schema: { type: "object", properties: { actor: { type: "object" }, prompt: { type: "string" }, context: { type: "object" } }, required: ["actor", "prompt"], additionalProperties: false },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "b".repeat(64), remote_roles: [] },
  })] }));
  const remote = vi.fn(async () => {
    if (selection.outcome === "network") throw new Error("fetch failed");
    if (selection.outcome === "forbidden") throw new Error("403 forbidden");
    return selection.outcome === "malformed" ? {} : { content: [], structuredContent: { allowed: true } };
  });
  const bridge = await createErpbridgeMcpSession({ baseURL: "https://policy-sdk.example.test", token: "synthetic-token", timeoutMs: 1000, validator,
    sdkClient: { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => []), callTool: remote } });
  try {
    const prepared = await prepareOptionalPolicy({ config, repository, registries, validator, executor, providerRuntime: runtime, erpbridgeSession: bridge }, user,
      { prompt: "Dynamic question", action: "chat_request", context: { intent: "QUERY" }, traceId: "trace-policy-selection", sessionId: "session-policy-selection" });
    expect(prepared.kind).toBe(selection.kind); expect(prepared.fallbackUsed).toBe(selection.fallback); expect(remote).toHaveBeenCalledTimes(selection.calls); expect(fetchModel).not.toHaveBeenCalled();
    if (prepared.kind === "local") expect(JSON.parse(prepared.plan.prompt)).toMatchObject({ request: "Dynamic question", actor: { id: user.id, role: user.role }, context: { intent: "QUERY" }, policy: { version: "1.0.0" } });
    else expect(prepared.decision.source).toBe("source" in selection ? selection.source : undefined);
  } finally { await bridge.close(); await repository.close(); vi.restoreAllMocks(); }
});

test.each(["static-deny", "static-review", "no-provider", "invalid-configuration"])("detached %s selection has no local model attempt", async scenario => {
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", GOVERNANCE_FALLBACK_POLICY_PATH: resolve("policy/governance_fallback.json") });
  if (scenario === "invalid-configuration") config.governanceFallbackPolicyPath = resolve("tests/fixtures/nonexistent-policy-selection.json");
  const repository = await Repository.open(null), registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator), fetchModel = vi.fn<typeof fetch>(async () => { throw new Error("static decision cannot call a model"); });
  const runtime = new ProviderRuntime(repository, executor, fetchModel);
  if (scenario !== "no-provider") runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://policy-model.example.test/v1", apiKey: "synthetic-key", model: "model-a", temperature: 0, timeoutMs: 1000 });
  await repository.mutate(state => { state.settings.rbac = { enabled: false, localPolicyAgentEnabled: true };
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  try {
    const actual = (await repository.effectiveUser("owner"))!, user = scenario === "static-deny" ? { ...actual, role: "Unknown role" } : actual;
    const prepared = await prepareOptionalPolicy({ config, repository, registries, validator, executor, providerRuntime: runtime }, user,
      { prompt: "Dynamic static check", action: scenario === "static-review" ? "delete_customer" : "chat_request" });
    expect(prepared.kind).toBe("decision"); expect(fetchModel).not.toHaveBeenCalled();
    if (prepared.kind === "decision") expect(prepared.decision.decision).toBe(scenario === "static-review" ? "review" : scenario === "no-provider" ? "unavailable" : "deny");
  } finally { await repository.close(); }
});
