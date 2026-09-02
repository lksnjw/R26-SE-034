import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Executor } from "../src/runner/executor.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { classifyIntent } from "../src/agent/intent-classifier.js";
import { createEmailDraft, deliveryIntent, type EmailDraft } from "../src/delivery/email-draft.js";
import { runQueryLoop } from "../src/agent/query-loop.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const requestText = "Get invoice details, analyse the report and email it to manager@example.test";
const headersFor = (id: string, secret: string) => ({ authorization: `Bearer ${jwt.sign({}, secret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
async function setup(options: { bridge?: boolean; calls?: boolean; final?: string; finalStop?: string; failure?: boolean; unadmitted?: boolean; providerFailsAfterRead?: boolean } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "test-email-draft-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), erpbridgeRoleMap: { "Platform Admin": "admin" } };
  const repository = new Repository(null);
  await repository.mutate((state) => { for (const id of ["owner", "other"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "U", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  const registries = await RegistryService.load(resolve(options.unadmitted ? "tests/fixtures/tools.json" : "tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository);
  const executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    const hasToolResult = input.messages.some((message: { role: string }) => message.role === "tool");
    if (options.providerFailsAfterRead && hasToolResult) throw new Error("private-provider-secret must not leak");
    return Response.json({ choices: [{ finish_reason: options.calls && !hasToolResult ? "tool_calls" : options.finalStop ?? "stop", message: options.calls && !hasToolResult ? {
      content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture report"}' } }],
    } : { content: options.final ?? "Synthetic fixture report for review." } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  const providerRuntime = new ProviderRuntime(repository, executor, fetchImplementation);
  providerRuntime.activate({ id: "test", name: "Test", type: "openai_compatible", baseURL: "https://provider.example.test/v1", apiKey: "test", model: "test", temperature: 0, timeoutMs: 1000 });
  const callTool = vi.fn(async () => options.failure ? { content: [{ type: "text", text: "denied" }], isError: true } : { content: [], structuredContent: { value: "fixture report" } });
  const erpbridgeSession = options.bridge ? await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture-only", timeoutMs: 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => registries.snapshot().tools.map((tool) => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema })), callTool } }) : undefined;
  const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime, ...(erpbridgeSession ? { erpbridgeSession } : {}) }); apps.push(app);
  const headers = headersFor("owner", config.jwtSecret);
  const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} });
  const sessionId = created.json().data.id;
  const send = (content = requestText, extra = {}, actor = "owner") => app.inject({ method: "POST", url: `/api/chat/sessions/${sessionId}/messages`, headers: headersFor(actor, config.jwtSecret), payload: { content, ...extra } });
  return { app, repository, send, sessionId, headers, fetchImplementation, callTool };
}
function command(draft: EmailDraft, commandId = "edit-command-00000001") { return { draftId: draft.id, baseVersion: draft.version, baseHash: draft.contentHash, commandId, patch: { to: "confirmed@example.test", subject: "Invoice review", body: "Reviewed report draft." } }; }

test.each([
  "Send an email to manager@example.test", requestText, "Send invoice details to my manager every day", "Please mail this to my manager",
])("direct delivery request remains explicit: %s", (text) => { expect(classifyIntent(text)).toBe("EMAIL_DELIVERY"); });
test.each(["How would you email the manager?", "What happened to the email?", "Do not send email; list invoices", "Check if the email was sent"])("informational or negated request is not delivery authority: %s", (text) => { expect(classifyIntent(text)).not.toBe("EMAIL_DELIVERY"); });
test("explicit canvas generation stays a workflow proposal, not a delivery attempt", () => { expect(classifyIntent("Create a workflow to get invoices and email the manager daily")).toBe("ACTION"); });
test("person or multiple-address request never guesses or silently picks a recipient", () => {
  for (const text of ["Send an email to my manager", "Email this to a@example.test and b@example.test"]) {
    const intent = deliveryIntent(text)!;
    expect(createEmailDraft("draft", "chat", "owner", text, intent).to).toBe("");
  }
});
test("offline request saves the original recipient/report/recurrence without model or SDK dispatch", async () => {
  const s = await setup(); const result = await s.send(requestText + " every day");
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.operation).toEqual({ success: false, code: "EMAIL_NOT_SENT" });
  expect(result.json().data.assistantMessage.artifacts).toMatchObject({ reportReason: "ERPBRIDGE_NOT_CONNECTED", can_execute: false, emailDraft: { originalRequest: requestText + " every day", to: "manager@example.test", recurring: true, body: "", reportStatus: "NOT_PREPARED", state: "DRAFT_NOT_SENT" } });
  expect(result.json().data.answer).toContain("No schedule is active");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).workflows).toEqual({});
  const restored = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers });
  expect(restored.json().data.messages[1].artifacts.emailDraft.to).toBe("manager@example.test");
});
test("zero-tool model 'sent' claim cannot become a report or delivery result", async () => {
  const s = await setup({ bridge: true, final: "Email sent successfully." }); const result = await s.send();
  expect(result.json().data.assistantMessage.artifacts.emailDraft).toMatchObject({ state: "DRAFT_NOT_SENT", reportStatus: "NOT_PREPARED", body: "", sourceEvidence: [] });
  expect(result.json().data.answer).not.toContain("successfully"); expect(s.callTool).not.toHaveBeenCalled();
});
test("confirmed reads produce a review draft, not sent or approved", async () => {
  const s = await setup({ bridge: true, calls: true }); const result = await s.send();
  expect(result.statusCode, result.body).toBe(200);
  const draft = result.json().data.assistantMessage.artifacts.emailDraft;
  expect(draft).toMatchObject({ body: "Synthetic fixture report for review.", reportStatus: "PREPARED_FOR_REVIEW", state: "DRAFT_NOT_SENT" });
  expect(draft.sourceEvidence).toHaveLength(1); expect(draft.sourceEvidence[0].outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(s.callTool).toHaveBeenCalledExactlyOnceWith("demo.echo", { value: "fixture report", role: "admin" });
  expect(result.json().data.operation.success).toBe(false);
});
test.each([{ failure: true }, { final: "I have sent the email successfully." }, { final: "x".repeat(32001) }, { finalStop: "length" }, { finalStop: "content_filter" }])("failed, unsupported, truncated or oversized report is not silently used as a complete email body: %j", async (extra) => {
  const s = await setup({ bridge: true, calls: true, ...extra }); const result = await s.send();
  expect(result.json().data.assistantMessage.artifacts.emailDraft.body).toBe("");
  expect(result.json().data.assistantMessage.artifacts.emailDraft.reportStatus).not.toBe("PREPARED_FOR_REVIEW");
  expect(s.callTool).toHaveBeenCalledTimes(1);
});
test("unadmitted registry makes no provider or SDK call", async () => {
  const s = await setup({ bridge: true, unadmitted: true }); const result = await s.send();
  expect(result.json().data.assistantMessage.artifacts.reportReason).toBe("NO_ADMITTED_READ_TOOLS"); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
test("provider failure after an acknowledged read preserves partial evidence without generating a complete email body", async () => {
  const s = await setup({ bridge: true, calls: true, providerFailsAfterRead: true }); const result = await s.send();
  expect(result.statusCode, result.body).toBe(200);
  const artifact = result.json().data.assistantMessage.artifacts;
  expect(artifact.reportReason).toBe("PROVIDER_FAILED"); expect(artifact.emailDraft).toMatchObject({ body: "", reportStatus: "PARTIAL", state: "DRAFT_NOT_SENT" });
  expect(artifact.emailDraft.sourceEvidence).toHaveLength(1); expect(artifact.toolSteps[0].status).toBe("SUCCEEDED");
  expect(result.body).not.toContain("private-provider-secret"); expect(s.callTool).toHaveBeenCalledTimes(1);
});
test("role change during analysis prevents returning or persisting an old-role report draft", async () => {
  const s = await setup({ bridge: true, calls: true });
  const originalFetch = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (...args) => {
    const response = await originalFetch(...args);
    const input = JSON.parse(String(args[1]?.body));
    if (input.messages.some((message: { role: string }) => message.role === "tool")) await s.repository.mutate((state) => { state.users.owner!.roleId = "role_client"; });
    return response;
  });
  const result = await s.send(); expect(result.statusCode).toBe(403);
  expect(s.callTool).toHaveBeenCalledTimes(1); expect(result.body).not.toContain("fixture report");
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1);
});
test("versioned edit is atomic, deduplicated, source-preserving and never invokes a provider or SDK", async () => {
  const s = await setup({ bridge: true, calls: true }); const initial = await s.send(); const draft = initial.json().data.assistantMessage.artifacts.emailDraft;
  s.fetchImplementation.mockClear(); s.callTool.mockClear();
  const edit = command(draft); const results = await Promise.all([s.send("", { emailDraftCommand: edit }), s.send("", { emailDraftCommand: edit })]);
  expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json().data.assistantMessage.id).toBe(results[1]!.json().data.assistantMessage.id);
  const updated = results[0]!.json().data.assistantMessage.artifacts.emailDraft;
  expect(updated).toMatchObject({ version: 2, state: "DRAFT_NOT_SENT", reportStatus: "USER_EDITED", to: "confirmed@example.test" });
  expect(updated.sourceEvidence).toEqual(draft.sourceEvidence); expect(updated.originalRequest).toBe(draft.originalRequest); expect(updated.contentHash).not.toBe(draft.contentHash);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(4);
  const history = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers });
  expect(history.json().data.messages[1].artifacts.emailDraftSuperseded).toBe(true);
  expect(history.json().data.messages[3].artifacts.emailDraftSuperseded).toBe(false);
  const replayChanged = await s.send("", { emailDraftCommand: { ...edit, patch: { ...edit.patch, body: "Different" } } }); expect(replayChanged.statusCode).toBe(409);
  const stale = await s.send("", { emailDraftCommand: command(draft, "edit-command-00000002") }); expect(stale.statusCode).toBe(409);
  const reopened = new Repository(null, await s.repository.snapshot());
  expect((await reopened.snapshot()).chats[s.sessionId]?.messages[3]?.artifacts).toMatchObject({ emailDraft: { version: 2, state: "DRAFT_NOT_SENT" } });
});
test("concurrent different edits cannot overwrite each other", async () => {
  const s = await setup(); const initial = await s.send(); const draft = initial.json().data.assistantMessage.artifacts.emailDraft;
  const results = await Promise.all([s.send("", { emailDraftCommand: command(draft) }), s.send("", { emailDraftCommand: command(draft, "edit-command-00000002") })]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
});
test.each(["foreign", "forged-state", "extra-patch", "header-injection", "invalid-recipient", "bad-hash", "revoked"])("invalid or unauthorized draft edit is rejected: %s", async (scenario) => {
  const s = await setup(); const initial = await s.send(); const draft = initial.json().data.assistantMessage.artifacts.emailDraft;
  const edit: any = command(draft);
  if (scenario === "forged-state") edit.state = "SENT";
  if (scenario === "extra-patch") edit.patch.sourceEvidence = [];
  if (scenario === "header-injection") edit.patch.subject = "Hello\r\nBcc: thief@example.test";
  if (scenario === "invalid-recipient") edit.patch.to = "not an email";
  if (scenario === "bad-hash") edit.baseHash = "sha256:" + "0".repeat(64);
  if (scenario === "revoked") await s.repository.mutate((state) => { state.users.owner!.status = "Disabled"; });
  const result = await s.send("", { emailDraftCommand: edit }, scenario === "foreign" ? "other" : "owner");
  expect(result.statusCode).toBeGreaterThanOrEqual(400); expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(2);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).not.toHaveBeenCalled();
});
test("platform-admin visibility never grants another person's delivery draft creation", async () => {
  const s = await setup(); const result = await s.send(requestText, {}, "other"); expect(result.statusCode).toBe(404);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(0);
});
test("query itself rejects no-read completion prose", async () => {
  const s = await setup({ bridge: true, final: "Email sent successfully." }); const result = await s.send("List invoices");
  expect(result.json().data.answer).toContain("No confirmed ERP data"); expect(result.json().data.answer).toContain("No email was sent"); expect(s.callTool).not.toHaveBeenCalled();
});
test("already cancelled preparation cannot call a provider or tool", async () => {
  const controller = new AbortController(); controller.abort();
  const queryWithTools = vi.fn(); const callTool = vi.fn();
  const result = await runQueryLoop({ userMessage: requestText, chatHistory: [], sessionId: "chat", actorId: "owner", actorRole: "Platform Admin", signal: controller.signal }, [], callTool, { queryWithTools } as unknown as ProviderRuntime, true);
  expect(result).toMatchObject({ stopReason: "CANCELLED", readOutcome: "NO_CONFIRMED_READ" });
  expect(queryWithTools).not.toHaveBeenCalled(); expect(callTool).not.toHaveBeenCalled();
});
test("cancellation after one acknowledged read retains it and prevents a later proposed tool", async () => {
  const controller = new AbortController();
  const queryWithTools = vi.fn(async () => ({ text: "", inputTokens: 1, outputTokens: 1, stopReason: "tool_calls", toolCalls: [
    { id: "one", name: "fixture.one", arguments: {} }, { id: "two", name: "fixture.two", arguments: {} },
  ] }));
  const callTool = vi.fn(async () => { controller.abort(); return { content: [], structuredContent: { fixture: true } }; });
  const result = await runQueryLoop({ userMessage: requestText, chatHistory: [], sessionId: "chat", actorId: "owner", actorRole: "Platform Admin", signal: controller.signal }, [], callTool, { queryWithTools } as unknown as ProviderRuntime, true);
  expect(result).toMatchObject({ stopReason: "CANCELLED", readOutcome: "PARTIAL_READ", boundHit: true });
  expect(result.toolSteps[0]?.status).toBe("SUCCEEDED"); expect(callTool).toHaveBeenCalledTimes(1); expect(queryWithTools).toHaveBeenCalledTimes(1);
  expect(createEmailDraft("draft", "chat", "owner", requestText, deliveryIntent(requestText)!, result)).toMatchObject({ body: "", reportStatus: "PARTIAL", state: "DRAFT_NOT_SENT" });
});
