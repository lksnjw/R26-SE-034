import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository, type PersistenceBackend, type RepositoryState } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { chatJobQueue } from "../src/agent/chat-jobs.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { stringify } from "yaml";
import type { Workflow } from "../src/models/schemas.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const yaml = 'name: Report\ndescription: Read\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fixture';
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null;
  failWhen: ((state: RepositoryState) => boolean) | undefined; commitBeforeFailure = false;
  async load() { return this.payload; }
  async save(payload: Uint8Array) { const state = JSON.parse(Buffer.from(payload).toString("utf8")) as RepositoryState;
    if (this.failWhen?.(state)) { this.failWhen = undefined; if (this.commitBeforeFailure) this.payload = Buffer.from(payload); throw new Error("Fixture acknowledgement lost"); }
    this.payload = Buffer.from(payload);
  }
  async close() {} async probe() {}
}
async function setup(options: { persistence?: PersistenceBackend; timeoutMs?: number; noBridge?: boolean } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "chat-job-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), storageEncryptionKey: "x".repeat(32), erpbridgeRoleMap: { "Platform Admin": "admin" } };
  const repository = await Repository.open(options.persistence ?? null);
  await repository.mutate(state => { for (const id of ["owner", "other"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "U", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    if (input.messages[0].content.includes("ONE SELECTED NODE PATCH")) return Response.json({ choices: [{ message: { content: '{"description":"Proposed label"}' } }] });
    if (input.messages[0].content.includes("WORKFLOW DRAFT SYNTHESIS")) return Response.json({ choices: [{ message: { content: yaml } }] });
    if (input.messages[0].content.includes("WORKFLOW MODIFICATION PROPOSAL")) return Response.json({ choices: [{ message: { content: yaml.replace("Report", "Updated") } }] });
    const hasRead = input.messages.some((m: { role: string }) => m.role === "tool");
    return Response.json({ choices: [{ finish_reason: hasRead ? "stop" : "tool_calls", message: hasRead ? { content: "Confirmed fixture read." } : {
      content: "", tool_calls: [{ id: "read-one", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }],
    } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  const runtime = new ProviderRuntime(repository, executor, fetchImplementation);
  runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://old.example.test/v1", apiKey: "private-fixture-key", model: "model-a", additionalModels: ["model-b"], temperature: 0, timeoutMs: 1000 });
  const callTool = vi.fn(async (): Promise<unknown> => ({ content: [], structuredContent: { value: "confirmed receipt", token: "private-remote-secret" } }));
  const bridge = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture-credential", timeoutMs: options.timeoutMs ?? 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => registries.snapshot().tools.map(t => ({ name: t.mcp_tool_name, inputSchema: t.input_schema })), callTool } });
  const services = { config, repository, registries, validator, executor, providerRuntime: runtime, synthesis: new SynthesisService(runtime, registries, validator), ...(options.noBridge ? {} : { erpbridgeSession: bridge }) };
  const app = await buildApp(services); apps.push(app);
  const headers = (id = "owner") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers: headers(), payload: {} }); const sessionId = created.json().data.id;
  const send = (content = "Show me invoices", extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/chat/sessions/${sessionId}/messages`, headers: headers(), payload: { content, delivery: "async-chat", idempotencyKey: "chat-job-fixture-00001", ...extra } });
  const get = (id: string, actor = "owner", after = 0) => app.inject({ method: "GET", url: `/api/chat/operations/${id}?after=${after}`, headers: headers(actor) });
  async function terminal(id: string) { await vi.waitFor(async () => expect((await repository.snapshot()).chatOperations[id]?.status).not.toMatch(/^(QUEUED|RUNNING)$/), { timeout: 3500, interval: 10 }); return (await repository.snapshot()).chatOperations[id]!; }
  return { services, repository, runtime, callTool, fetchImplementation, app, headers, sessionId, send, get, terminal };
}

async function nodeSetup(options: Parameters<typeof setup>[0] = {}) {
  const s = await setup(options), timestamp = new Date().toISOString();
  await s.repository.mutate(state => {
    state.workflows.report = { id: "report", name: "Report", description: "Read", owner: { id: "owner", name: "owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null,
      publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false } satisfies Workflow;
    state.versions.report = [{ version: 1, artifactState: "PUBLISHED", yaml }];
  });
  const nodeContext = { workflowId: "report", nodeId: "echo", baseVersion: 1, baseHash: workflowContentHash(yaml) };
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ message: { content: '{"description":"Proposed label"}' } }] }));
  return { ...s, nodeContext };
}

test("node scope overrides action prose, saves a reviewable proposal atomically and never dispatches ERP or edits a draft", async () => {
  const s = await nodeSetup(), content = "Get invoices and send an email to manager@example.test";
  const receipt = (await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data;
  expect(receipt.operation.nodeContext).toEqual(s.nodeContext);
  const op = await s.terminal(receipt.operation.id);
  expect(op).toMatchObject({ status: "ANSWERED", attempts: [], artifactRefs: [{ type: "node-proposal" }] });
  const state = await s.repository.snapshot(), messages = state.chats[s.sessionId]!.messages;
  expect(messages).toHaveLength(2); expect(messages[0]).toMatchObject({ operationId: op.id, artifacts: { intent: "NODE_EDIT_REQUEST", nodeId: "echo" } });
  expect(messages[1]).toMatchObject({ operationId: op.id, artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal: { ...s.nodeContext, status: "PROPOSED", command: { type: "updateNode", nodeId: "echo", patch: { description: "Proposed label" } } } } });
  expect(state.workflows.report).toMatchObject({ yaml, draftVersion: 1, publishedVersion: 1 });
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
  expect(JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)).model).toBe("model-b");
  // Repeating the original identity after a later revision or lost default still retrieves it.
  await s.repository.mutate(state => { state.workflows.report!.draftVersion++; }); vi.spyOn(s.runtime, "configured", "get").mockReturnValue(false);
  expect((await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data.operation.id).toBe(op.id);
  expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

async function conditionalNodeSetup(output: unknown = { predicate: { kind: "literal", value: false } }) {
  const s = await nodeSetup();
  const source = stringify({ name: "Conditional chat report", trigger: { type: "manual" }, steps: [{ id: "echo", action: "demo.echo", parameters: { value: "fixture" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "echo" }] }, else: { kind: "sequence", nodes: [] } }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  return { ...s, source, nodeContext: { ...s.nodeContext, nodeId: "gate", baseHash: workflowContentHash(source) } };
}
test("saved condition chat job returns an owned predicate-only proposal with selected model and zero ERP dispatch", async () => {
  const s = await conditionalNodeSetup(), id = (await s.send("Change this condition and send an email", { nodeContext: s.nodeContext, model: "model-b" })).json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), proposal = (state.chats[s.sessionId]!.messages[1]!.artifacts as any).proposal;
  expect(proposal.command).toEqual({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } });
  expect(state.workflows.report!.yaml).toBe(s.source); expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)); expect(body.model).toBe("model-b"); expect(body.messages[0].content).toContain("ONE SELECTED CONDITION PATCH");
});
test.each([{ parameters: {} }, { predicate: { kind: "literal", value: true }, else: { kind: "sequence", nodes: [] } }, { predicate: { kind: "literal", value: 0 } }])("saved condition chat rejects scope-escaping model output %j without applying or dispatching", async output => {
  const s = await conditionalNodeSetup(output), id = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("FAILED");
  const state = await s.repository.snapshot(); expect(state.workflows.report!.yaml).toBe(s.source); expect(state.chats[s.sessionId]!.messages).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
});
test.each(["edit", "cancel"])("late conditional proposal generation is fenced after %s", async kind => {
  const s = await conditionalNodeSetup(), entered = barrier(), unblock = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return Response.json({ choices: [{ message: { content: '{"predicate":{"kind":"literal","value":false}}' } }] }); });
  const id = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data.operation.id; await entered.promise;
  if (kind === "edit") await s.repository.mutate(state => { state.workflows.report!.draftVersion++; });
  else await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  unblock.release(); expect((await s.terminal(id)).status).toBe(kind === "edit" ? "FAILED" : "CANCELLED");
  expect((await s.repository.snapshot()).chats[s.sessionId]!.messages).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["invalid", "stale", "missing-node", "unconfigured"])("node admission rejects %s before saving a message or invoking a provider", async kind => {
  const s = await nodeSetup(); const context = { ...s.nodeContext };
  if (kind === "stale") context.baseVersion++;
  if (kind === "missing-node") context.nodeId = "absent";
  if (kind === "unconfigured") vi.spyOn(s.runtime, "configured", "get").mockReturnValue(false);
  const result = await s.send("Edit", { nodeContext: kind === "invalid" ? { ...context, hidden: true } : context });
  expect(result.statusCode).toBe(kind === "invalid" ? 400 : kind === "stale" ? 409 : kind === "missing-node" ? 422 : 503);
  expect((await s.repository.snapshot()).chats[s.sessionId]!.messages).toHaveLength(0);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["edit", "revoke", "cancel"])("late node generation cannot save a proposal after %s", async kind => {
  const s = await nodeSetup(), entered = barrier(), unblock = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return Response.json({ choices: [{ message: { content: '{"description":"Late"}' } }] }); });
  const id = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data.operation.id; await entered.promise;
  if (kind === "edit") await s.repository.mutate(state => { state.workflows.report!.draftVersion++; });
  if (kind === "revoke") await s.repository.mutate(state => { state.users.owner!.status = "Inactive"; });
  if (kind === "cancel") await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  unblock.release(); expect((await s.terminal(id)).status).toBe(kind === "cancel" ? "CANCELLED" : "FAILED");
  if (kind === "edit") expect((await s.repository.snapshot()).chatOperations[id]!.reason).toBe("DRAFT_REVISION_CONFLICT");
  const state = await s.repository.snapshot(); expect(state.chats[s.sessionId]!.messages).toHaveLength(1); expect(state.chatOperations[id]!.artifactRefs).toBeUndefined();
  expect(s.callTool).not.toHaveBeenCalled();
});

test("a committed node answer with lost storage acknowledgement is restored without another model call", async () => {
  const persistence = new Persistence(), s = await nodeSetup({ persistence });
  persistence.commitBeforeFailure = true; persistence.failWhen = state => Object.values(state.chatOperations).some(op => op.status === "ANSWERED");
  const receipt = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data;
  await vi.waitFor(() => expect(JSON.parse(Buffer.from(persistence.payload!).toString()).chatOperations[receipt.operation.id].status).toBe("ANSWERED"));
  await s.app.close(); apps.splice(apps.indexOf(s.app), 1);
  const next = await setup({ persistence });
  const saved = (await next.get(receipt.operation.id)).json().data.operation;
  expect(saved).toMatchObject({ status: "ANSWERED", artifactRefs: [{ type: "node-proposal" }] });
  expect((await next.repository.snapshot()).chats[s.sessionId]!.messages).toHaveLength(2);
  expect(next.fetchImplementation).not.toHaveBeenCalled(); expect(next.callTool).not.toHaveBeenCalled();
});

test("capabilities identify admission support without external discovery, and node context cannot fall back to synchronous chat", async () => {
  const s = await nodeSetup();
  const capability = await s.app.inject({ method: "GET", url: "/api/chat/capabilities", headers: s.headers() });
  expect(capability.statusCode).toBe(200); expect(capability.json().data).toEqual({ profile: "chat-admission-v1", asyncChat: true, nodeProposals: true, localDraftEdits: true });
  const response = await s.send("Send an email", { delivery: undefined, nodeContext: s.nodeContext });
  expect(response.statusCode).toBe(400); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("queued node proposal survives restart with its original model and revision binding", async () => {
  const persistence = new Persistence(), first = await nodeSetup({ persistence });
  const queue = chatJobQueue(first.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const op = (await first.send("Edit", { nodeContext: first.nodeContext, model: "model-b" })).json().data.operation;
  await first.app.close(); apps.splice(apps.indexOf(first.app), 1); kick.mockRestore();
  const second = await setup({ persistence });
  expect((await second.terminal(op.id)).status).toBe("ANSWERED");
  expect(second.fetchImplementation).toHaveBeenCalledOnce(); expect(first.fetchImplementation).not.toHaveBeenCalled(); expect(second.callTool).not.toHaveBeenCalled();
  expect(JSON.parse(String(second.fetchImplementation.mock.calls[0]![1]?.body)).model).toBe("model-b");
  expect((await second.repository.snapshot()).chats[first.sessionId]!.messages.at(-1)).toMatchObject({ artifacts: { proposal: { ...first.nodeContext, after: { description: "Proposed label" } } } });
});

test("unsupported storage capability is explicit and a legacy node endpoint cannot bypass an active chat operation", async () => {
  const unsupported = new Persistence(); Object.defineProperty(unsupported, "readQueueDurability", { value: undefined });
  const first = await setup({ persistence: unsupported });
  expect((await first.app.inject({ method: "GET", url: "/api/chat/capabilities", headers: first.headers() })).json().data).toMatchObject({ asyncChat: false, nodeProposals: false });
  const s = await nodeSetup(), queue = chatJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  await s.send("Edit", { nodeContext: s.nodeContext });
  const result = await s.app.inject({ method: "POST", url: "/api/workflows/report/node-proposals", headers: s.headers(), payload: { ...s.nodeContext, workflowId: undefined, prompt: "Edit again", sessionId: s.sessionId } });
  expect(result.statusCode).toBe(409); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled(); kick.mockRestore();
});

test("admission returns before held ERP completion, duplicates never re-execute, and saved receipts precede narration", async () => {
  const s = await setup(), entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { value: "confirmed", token: "private-secret" } }; });
  const response = await s.send(); expect(response.statusCode, response.body).toBe(202); const receipt = response.json().data, id = receipt.operation.id;
  expect(receipt.operation.status).toBe("QUEUED"); expect(receipt.userMessage.operationId).toBe(id);
  await entered.promise;
  const running = (await s.get(id)).json().data;
  expect(running.operation).toMatchObject({ status: "RUNNING", stage: "READING", attempts: [{ status: "DISPATCH_INTENT" }] });
  expect((await s.send()).json().data.operation.id).toBe(id); expect(s.callTool).toHaveBeenCalledOnce();
  const mismatch = await s.send("Show me other data"); expect(mismatch.statusCode).toBe(409);
  unblock.release(); expect((await s.terminal(id)).status).toBe("ANSWERED");
  const final = (await s.get(id)).json().data;
  expect(final.operation.attempts[0]).toMatchObject({ status: "DONE", output: { structuredContent: { value: "confirmed" } } });
  expect(final.operation.attempts[0].output.structuredContent.token).toBeUndefined();
  expect(final.events.map((e: { sequence: number }) => e.sequence)).toEqual(final.events.map((_e: unknown, i: number) => i + 1));
  expect(final.events.findIndex((e: { type: string }) => e.type === "tool.completed")).toBeLessThan(final.events.findIndex((e: { type: string }) => e.type === "answer.saved"));
  expect(JSON.stringify(final)).not.toMatch(/private-secret|private-fixture-key|inputCiphertext|requestFingerprint|idempotencyScope/);
  const state = await s.repository.snapshot(); expect(state.chatOperations[id]?.inputCiphertext).toBeUndefined();
  expect(state.chats[s.sessionId]?.messages).toHaveLength(2);
  expect(state.chats[s.sessionId]?.messages[1]?.operationId).toBe(id);
  expect((await s.send()).json().data.operation.id).toBe(id); expect(s.callTool).toHaveBeenCalledOnce();
});

test.each(["Get invoice details and email them to manager@example.test", "Create a workflow to read invoices", "Modify the workflow name", "What can you do?"])("queued path preserves request intent: %s", async content => {
  const s = await setup(); const response = await s.send(content, { model: "model-b", workflowContext: { yaml, name: "Report" } });
  expect(response.statusCode, response.body).toBe(202); const id = response.json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), message = state.chats[s.sessionId]?.messages.at(-1)!;
  expect(message.role).toBe("assistant");
  expect(s.runtime.configuration?.model).toBe("model-a");
  for (const [, init] of s.fetchImplementation.mock.calls) expect(JSON.parse(String(init?.body)).model).toBe("model-b");
  if (content.includes("email")) expect(message.artifacts).toMatchObject({ emailDraft: { state: "DRAFT_NOT_SENT", to: "manager@example.test" }, can_execute: false });
  if (content.startsWith("Create")) expect(Object.values(state.workflows)[0]).toMatchObject({ publishedVersion: 0, canRun: false });
});

test("queued snapshot does not adopt later administration model/endpoint/credential changes", async () => {
  const s = await setup(); const queue = chatJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.send("Show me invoices", { model: "model-b" })).json().data.operation;
  s.runtime.activate({ ...s.runtime.configuration!, baseURL: "https://new.example.test/v1", apiKey: "new-fixture-key", model: "new-model" });
  kick.mockRestore(); queue.kick(); expect((await s.terminal(admitted.id)).status).toBe("ANSWERED");
  for (const [url, init] of s.fetchImplementation.mock.calls) {
    expect(url).toBe("https://old.example.test/v1/chat/completions"); expect((init!.headers as Record<string,string>).authorization).toBe("Bearer private-fixture-key");
    expect(JSON.parse(String(init!.body)).model).toBe("model-b");
  }
  expect(s.runtime.configuration?.model).toBe("new-model");
  expect(Object.values((await s.repository.snapshot()).invocationProvenance).every(entry => entry.configurationRevision === admitted.modelBinding.configurationRevision)).toBe(true);
});

test("queued cancellation makes zero external calls, and other accounts cannot see or cancel it", async () => {
  const s = await setup(); const kick = vi.spyOn(chatJobQueue(s.services), "kick").mockImplementation(() => {});
  const id = (await s.send()).json().data.operation.id;
  expect((await s.get(id, "other")).statusCode).toBe(404);
  expect((await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers("other"), payload: {} })).statusCode).toBe(404);
  const result = await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  expect(result.statusCode).toBe(200); expect(result.json().data.status).toBe("CANCELLED");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  kick.mockRestore();
});

test("in-flight cancellation preserves UNKNOWN and late output never becomes an answer", async () => {
  const s = await setup(), entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { value: "late-not-confirmed" } }; });
  const id = (await s.send()).json().data.operation.id; await entered.promise;
  expect((await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} })).statusCode).toBe(202);
  const terminal = await s.terminal(id); expect(terminal).toMatchObject({ status: "RECOVERY_REQUIRED", attempts: [{ status: "UNKNOWN" }] });
  unblock.release(); await new Promise(resolve => setImmediate(resolve));
  expect((await s.repository.snapshot()).chatOperations[id]).toEqual(terminal);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1);
});

test("known MCP failure and unconfirmed timeout remain distinct", async () => {
  for (const timeout of [false, true]) {
    const s = await setup({ timeoutMs: 30 });
    s.callTool.mockImplementationOnce(async () => timeout ? new Promise(() => {}) : { content: [{ type: "text", text: "Rate limit reached" }], isError: true, _meta: { private: "secret", "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1000 } } });
    const id = (await s.send()).json().data.operation.id;
    const final = await s.terminal(id);
    expect(final.attempts[0]?.status).toBe(timeout ? "UNKNOWN" : "FAILED");
    expect(final.status).toBe(timeout ? "RECOVERY_REQUIRED" : "ANSWERED");
    if (!timeout) {
      const visible = (await s.get(id)).json().data.operation;
      expect(visible.attempts[0].output).toMatchObject({ isError: true, _meta: { "com.erpbridge/error": { type: "rate_limit", retryAfterMs: 1000 } } });
      expect(JSON.stringify(visible)).not.toContain("secret");
    }
    expect(s.callTool).toHaveBeenCalledOnce();
  }
});

test("actor revocation before final narration cannot persist an old-role answer", async () => {
  const s = await setup(), entered = barrier(), unblock = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "one", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }] } }] }));
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return Response.json({ choices: [{ finish_reason: "stop", message: { content: "old-role-private-answer" } }] }); });
  const id = (await s.send()).json().data.operation.id; await entered.promise;
  await s.repository.mutate(state => { state.users.owner!.roleId = "role_client"; });
  unblock.release(); expect((await s.terminal(id)).status).toBe("FAILED");
  expect((await s.get(id)).statusCode).toBe(403);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1);
  expect(s.callTool).toHaveBeenCalledOnce();
});

test("unclaimed durable job survives restart and private model configuration is encrypted", async () => {
  const persistence = new Persistence(), first = await setup({ persistence });
  const kick = vi.spyOn(chatJobQueue(first.services), "kick").mockImplementation(() => {});
  const id = (await first.send("Show me invoices", { model: "model-b" })).json().data.operation.id;
  const state = await first.repository.snapshot(); expect(state.chatOperations[id]?.inputCiphertext).not.toContain("private-fixture-key");
  await first.app.close(); kick.mockRestore();
  const second = await setup({ persistence }); await second.app.ready();
  const final = await second.terminal(id); expect(final.status).toBe("ANSWERED");
  expect(second.callTool).toHaveBeenCalledOnce(); expect(first.callTool).not.toHaveBeenCalled();
  expect(second.fetchImplementation.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).model === "model-b")).toBe(true);
});

test("claimed crash image recovers without replay; stale worker output is fenced", async () => {
  const persistence = new Persistence(), first = await setup({ persistence }), entered = barrier(), unblock = barrier();
  first.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { value: "late-stale-worker" } }; });
  const id = (await first.send()).json().data.operation.id; await entered.promise;
  const crash = new Persistence(); crash.payload = Buffer.from(persistence.payload!);
  const second = await setup({ persistence: crash }); await second.app.ready();
  expect((await second.repository.snapshot()).chatOperations[id]).toMatchObject({ status: "RECOVERY_REQUIRED", attempts: [{ status: "UNKNOWN" }] });
  expect(second.callTool).not.toHaveBeenCalled();
  await first.app.close(); unblock.release(); await new Promise(resolve => setImmediate(resolve));
  expect((await first.repository.snapshot()).chats[first.sessionId]?.messages).toHaveLength(1);
});

test.each(["QUEUED", "RUNNING", "ANSWERED"])("lost %s acknowledgement fences dispatch and does not replay a claimed job", async phase => {
  const persistence = new Persistence(), first = await setup({ persistence }); persistence.commitBeforeFailure = true;
  persistence.failWhen = state => Object.values(state.chatOperations).some(op => op.status === phase);
  const response = await first.send(); expect(response.statusCode).toBe(phase === "QUEUED" ? 500 : 202);
  await vi.waitFor(async () => expect((await first.repository.persistenceStatus()).healthy).toBe(false));
  const stored = JSON.parse(Buffer.from(persistence.payload!).toString("utf8")) as RepositoryState;
  const id = Object.keys(stored.chatOperations)[0]!;
  const image = new Persistence(); image.payload = Buffer.from(persistence.payload!);
  await first.repository.recoverPersistenceState(); await first.app.close();
  const second = await setup({ persistence: image }); await second.app.ready();
  const final = await second.terminal(id);
  expect(final.status).toBe(phase === "RUNNING" ? "RECOVERY_REQUIRED" : "ANSWERED");
  expect(second.callTool).toHaveBeenCalledTimes(phase === "QUEUED" ? 1 : 0);
  expect(first.callTool).toHaveBeenCalledTimes(phase === "ANSWERED" ? 1 : 0);
});

test("one active operation per conversation and synchronous sends cannot bypass it", async () => {
  const s = await setup(); const kick = vi.spyOn(chatJobQueue(s.services), "kick").mockImplementation(() => {});
  await s.send(); expect((await s.send("Other", { idempotencyKey: "another-chat-key-0001" })).statusCode).toBe(409);
  const sync = await s.app.inject({ method: "POST", url: `/api/chat/sessions/${s.sessionId}/messages`, headers: s.headers(), payload: { content: "Show me invoices" } });
  expect((await s.app.inject({ method: "DELETE", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers() })).statusCode).toBe(409);
  expect(sync.statusCode).toBe(409); expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1); kick.mockRestore();
});

test("invalid storage or oversized private context admits no operation and performs no external work", async () => {
  const unsupported = new Persistence(); Object.defineProperty(unsupported, "readQueueDurability", { value: undefined });
  const first = await setup({ persistence: unsupported }); expect((await first.send()).statusCode).toBe(503);
  expect(first.fetchImplementation).not.toHaveBeenCalled(); expect(Object.keys((await first.repository.snapshot()).chatOperations)).toHaveLength(0);
  const second = await setup();
  await second.repository.mutate(state => { state.chats[second.sessionId]!.messages.push({ id: "large-history", role: "user", text: "x".repeat(510_000) }); });
  expect((await second.send()).statusCode).toBe(413); expect(second.fetchImplementation).not.toHaveBeenCalled();
  expect(Object.keys((await second.repository.snapshot()).chatOperations)).toHaveLength(0);
});

test.each(["connection", "ciphertext"])("queued %s binding corruption cannot dispatch", async corruption => {
  const s = await setup(), kick = vi.spyOn(chatJobQueue(s.services), "kick").mockImplementation(() => {});
  const id = (await s.send()).json().data.operation.id;
  if (corruption === "connection") s.services.config.erpbridgeRoleMap["Platform Admin"] = "different-role";
  else await s.repository.mutate(state => { state.chatOperations[id]!.inputCiphertext = Buffer.from("not-authenticated").toString("base64"); });
  kick.mockRestore(); chatJobQueue(s.services).kick(); expect((await s.terminal(id)).status).toBe("FAILED");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("events reject future/gapped/cross-session evidence and list omits changed-authority records", async () => {
  const s = await setup(); const id = (await s.send()).json().data.operation.id; const final = await s.terminal(id);
  expect((await s.get(id, "owner", final.lastSequence + 1)).statusCode).toBe(409);
  await s.repository.mutate(state => { state.chatOperationEvents[id]![0]!.sessionId = "unrelated"; });
  expect((await s.get(id)).statusCode).toBe(409);
  await s.repository.mutate(state => { state.users.owner!.permissionOverrides.push("new:permission"); });
  const list = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}/operations`, headers: s.headers() });
  expect(list.statusCode).toBe(200); expect(list.json().data).toEqual([]); expect((await s.get(id)).statusCode).toBe(403);
});

test("saved draft reference survives a lost artifact acknowledgement without regenerating", async () => {
  const persistence = new Persistence(), first = await setup({ persistence }); persistence.commitBeforeFailure = true;
  persistence.failWhen = state => Object.values(state.chatOperations).some(op => op.stage === "DRAFT_SAVED");
  const id = (await first.send("Create a workflow to read invoices")).json().data.operation.id;
  await vi.waitFor(async () => expect((await first.repository.persistenceStatus()).healthy).toBe(false));
  const image = new Persistence(); image.payload = Buffer.from(persistence.payload!);
  await first.repository.recoverPersistenceState(); await first.app.close();
  const second = await setup({ persistence: image }); await second.app.ready(); const recovered = await second.terminal(id);
  expect(recovered.status).toBe("RECOVERY_REQUIRED"); expect(recovered.artifactRefs).toHaveLength(1);
  const state = await second.repository.snapshot(), draftId = recovered.artifactRefs![0]!.id;
  expect(state.workflows[draftId]).toMatchObject({ canRun: false, publishedVersion: 0, chatSessionId: first.sessionId });
  expect(second.fetchImplementation).not.toHaveBeenCalled(); expect(second.callTool).not.toHaveBeenCalled();
  expect((await second.get(id)).json().data.operation.artifactRefs).toEqual(recovered.artifactRefs);
});
