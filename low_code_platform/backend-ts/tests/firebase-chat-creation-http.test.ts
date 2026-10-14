import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { handleFunctionHttp } from "../src/firebase/http.js";
import { boundedReadFixture, TaskRecords } from "./fixtures/bounded-read-task.js";
import { Repository } from "../src/repository/store.js";
import { isFunctionChatCreationRequest } from "../src/firebase/chat-creation-http.js";

const fixtures = vi.hoisted(() => ({ open: vi.fn(), construct: vi.fn() }));
vi.mock("../src/entrypoints/application-runtime.js", () => ({ openApplicationResources: fixtures.open, constructApplicationRuntime: fixtures.construct }));
const closers: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  fixtures.construct.mockRejectedValue(new Error("MCP/provider construction is forbidden for simple chat creation"));
});
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function setup() {
  const storage = new TaskRecords(), f = await boundedReadFixture({ storage, configure: false }); closers.push(f.close);
  const config = { ...f.services.config, storageDriver: "firestore-records" as const };
  const close = vi.fn(async () => {});
  fixtures.open.mockImplementation(async () => {
    const repository = await Repository.open(storage); closers.push(() => repository.close());
    return { config, repository, registries: f.services.registries, close: async () => { try { await close(); } finally { await repository.close(); } } };
  });
  const input = { config, root: process.cwd(), transport: { timeoutMs: 1000, enqueue: f.enqueue } };
  const request = { method: "POST", url: "/api/chat/sessions", headers: { ...f.headers, "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify({ title: "Simple saved chat", idempotencyKey: "lean-chat-creation-original-001" })) };
  const snapshot = () => JSON.parse(storage.bytes!.toString());
  return { ...f, config, close, input, request, snapshot, storage };
}

test("native chat creation does not construct the full MCP/provider runtime and still saves one original receipt", async () => {
  const f = await setup();
  const first = await handleFunctionHttp(f.input, f.request), replay = await handleFunctionHttp(f.input, f.request);
  expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200);
  expect(JSON.parse(first.body.toString()).data.id).toBe(JSON.parse(replay.body.toString()).data.id);
  expect(fixtures.construct).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(2);
  const state = f.snapshot();
  expect(Object.keys(state.chats)).toHaveLength(1); expect(Object.keys(state.chatCreationReceipts)).toHaveLength(1);
  expect(state.chatOperations).toEqual({}); expect(state.executions).toEqual({}); expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("chat creation authentication is retained without starting model or ERP services", async () => {
  const f = await setup();
  const denied = await handleFunctionHttp(f.input, { ...f.request, headers: { "content-type": "application/json" } });
  expect(denied.statusCode).toBe(401); expect(fixtures.construct).not.toHaveBeenCalled();
  expect(Object.keys(f.snapshot().chats)).toHaveLength(0);
});

test.each(["{", "[]", "null", '"text"', '{"idempotencyKey":0}', '{"idempotencyKey":"short"}', '{"invalidJSONBody":true}'])("invalid original body retains the full-route response: %s", async raw => {
  const f = await setup(), rawBody = Buffer.from(raw);
  const full = await f.app.inject({ method: "POST", url: f.request.url, headers: f.request.headers, payload: rawBody });
  const thin = await handleFunctionHttp(f.input, { ...f.request, rawBody, body: { title: "Do not repair malformed original bytes" } });
  expect(thin.statusCode).toBe(full.statusCode); expect(JSON.parse(thin.body.toString())).toEqual(full.json());
  expect(Object.keys(f.snapshot().chats)).toHaveLength(0); expect(fixtures.construct).not.toHaveBeenCalled();
});

test.each(["missing", "invalid", "revoked", "suspended", "deleted"])("current %s identity/permission denial matches the existing route", async scenario => {
  const f = await setup(); let headers = { ...f.request.headers };
  if (scenario === "missing") headers = { "content-type": "application/json" } as typeof headers;
  if (scenario === "invalid") headers.authorization = "Bearer invalid";
  if (["revoked", "suspended", "deleted"].includes(scenario)) await f.repository.mutate(state => {
    if (scenario === "revoked") { state.users.owner!.roleId = "role_client"; state.roles.role_client!.permissions = []; }
    if (scenario === "suspended") state.users.owner!.status = "Suspended";
    if (scenario === "deleted") delete state.users.owner;
  });
  const full = await f.app.inject({ method: "POST", url: f.request.url, headers, payload: f.request.rawBody });
  const thin = await handleFunctionHttp(f.input, { ...f.request, headers });
  expect(thin.statusCode).toBe(full.statusCode); expect(JSON.parse(thin.body.toString())).toEqual(full.json());
  expect(Object.keys(f.snapshot().chats)).toHaveLength(0); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("a nonadmin chat-only actor can save and recover the original command without activating broken provider configuration", async () => {
  const f = await setup();
  await f.repository.mutate(state => {
    state.users.owner!.roleId = "role_client"; state.roles.role_client!.permissions = ["chat:use"];
    state.providers.broken = { id: "broken", active: true, type: "unsupported", apiKey: "fixture-secret-never-export", baseURL: "https://private.example.test" };
  });
  const before = f.snapshot();
  const first = await handleFunctionHttp(f.input, f.request);
  expect(first.statusCode).toBe(201); expect(first.body.toString()).not.toContain("fixture-secret"); expect(first.body.toString()).not.toContain("private.example");
  const replay = await handleFunctionHttp(f.input, f.request); expect(replay.statusCode).toBe(200);
  expect(f.snapshot().providers).toEqual(before.providers); expect(f.snapshot().settings).toEqual(before.settings);
  expect(fixtures.construct).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("full-route creation and lean recovery return exactly the same public original chat", async () => {
  const f = await setup();
  const original = await f.app.inject({ method: "POST", url: f.request.url, headers: f.request.headers, payload: f.request.rawBody });
  expect(original.statusCode).toBe(201);
  const recovered = await handleFunctionHttp(f.input, f.request);
  expect(recovered.statusCode).toBe(200); expect(JSON.parse(recovered.body.toString()).data).toEqual(original.json().data);
  expect(Object.keys(f.snapshot().chats)).toHaveLength(1);
});

test("a changed command conflicts and a deleted original cannot be resurrected", async () => {
  const f = await setup(), first = await handleFunctionHttp(f.input, f.request);
  expect(first.statusCode).toBe(201);
  const changed = await handleFunctionHttp(f.input, { ...f.request, rawBody: Buffer.from(JSON.stringify({ title: "Changed", idempotencyKey: "lean-chat-creation-original-001" })) });
  expect(changed.statusCode).toBe(409);
  const state = f.snapshot(); delete state.chats[JSON.parse(first.body.toString()).data.id];
  f.storage.bytes = Buffer.from(JSON.stringify(state));
  expect((await handleFunctionHttp(f.input, f.request)).statusCode).toBe(410);
  expect(Object.keys(f.snapshot().chats)).toHaveLength(0); expect(Object.keys(f.snapshot().chatCreationReceipts)).toHaveLength(1);
});

test("success waits for resource cleanup; a cleanup failure exposes recovery guidance without blindly replaying the command", async () => {
  const f = await setup(); let finish!: () => void, settled = false;
  f.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = handleFunctionHttp(f.input, f.request).then(value => { settled = true; return value; });
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce()); expect(settled).toBe(false);
  finish(); expect((await pending).statusCode).toBe(201);
  f.close.mockRejectedValueOnce(new Error("private cleanup details must not escape"));
  const failed = await handleFunctionHttp(f.input, f.request);
  expect(failed.statusCode).toBe(503); expect(JSON.parse(failed.body.toString()).meta.code).toBe("FUNCTIONS_INVOCATION_UNCONFIRMED");
  expect(failed.body.toString()).not.toContain("private cleanup");
  expect(Object.keys(f.snapshot().chats)).toHaveLength(1); expect(fixtures.open).toHaveBeenCalledTimes(2);
  expect((await handleFunctionHttp(f.input, f.request)).statusCode).toBe(200);
  expect(Object.keys(f.snapshot().chats)).toHaveLength(1);
});

test("a committed creation with a lost storage acknowledgement returns 503, then recovers the original on a fresh owner", async () => {
  const f = await setup(); f.storage.commitBeforeFailure = true;
  f.storage.failWhen = state => Object.keys(state.chatCreationReceipts).length === 1;
  const unknown = await handleFunctionHttp(f.input, f.request);
  expect(unknown.statusCode).toBe(503); expect(Object.keys(f.snapshot().chats)).toHaveLength(1);
  expect(fixtures.open).toHaveBeenCalledOnce();
  const recovered = await handleFunctionHttp(f.input, f.request);
  expect(recovered.statusCode).toBe(200); expect(Object.keys(f.snapshot().chats)).toHaveLength(1);
  expect(f.enqueue).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("preflight uses the same CORS contract without opening any writable resource", async () => {
  const f = await setup(), before = f.snapshot();
  const headers = { origin: f.config.corsOrigins[0]!, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" };
  const full = await f.app.inject({ method: "OPTIONS", url: f.request.url, headers });
  const thin = await handleFunctionHttp(f.input, { method: "OPTIONS", url: f.request.url, headers });
  expect(thin.statusCode).toBe(full.statusCode); expect(thin.headers["access-control-allow-origin"]).toBe(full.headers["access-control-allow-origin"]);
  expect(fixtures.open).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
});

test("the exact selector cannot bypass the normal runtime for messages, model changes, arbitrary writes or alternate hosts", async () => {
  const f = await setup();
  for (const request of [
    { method: "POST", url: "/api/chat/sessions/x/messages" }, { method: "PATCH", url: "/api/chat/sessions/x" },
    { method: "GET", url: "/api/chat/sessions" }, { method: "POST", url: "/api/chat/sessions/" },
    { method: "POST", url: "/api/workflows" }, { method: "POST", url: "//foreign.test/api/chat/sessions" },
  ]) expect(isFunctionChatCreationRequest(f.config, { ...request, headers: {} })).toBe(false);
  expect(isFunctionChatCreationRequest({ ...f.config, storageDriver: "memory" }, f.request)).toBe(false);
  expect(isFunctionChatCreationRequest({ ...f.config, apiBasePath: "/other" }, f.request)).toBe(false);
  expect(isFunctionChatCreationRequest(f.config, { ...f.request, url: "/api/chat/sessions?source=demo" })).toBe(true);
});
