import { afterEach, expect, test, vi } from "vitest";
import jwt from "jsonwebtoken";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";
import { authorizeChatOperation, publicChatOperation } from "../src/agent/chat-progress.js";
import { FirestoreSnapshotChanged } from "../src/storage/firestore-record-store.js";
import { isFunctionChatCancellationRequest } from "../src/firebase/chat-cancellation-http.js";
import { handleFunctionHttp } from "../src/firebase/http.js";

const native = vi.hoisted(() => ({ open: vi.fn(), runtime: vi.fn() }));
vi.mock("../src/firebase/invocation.js", () => ({ withFunctionRuntime: native.runtime, withFunctionResources: native.runtime }));
vi.mock("../src/storage/firestore-chat-cancellation.js", async importOriginal => ({ ...await importOriginal<object>(), openFirestoreChatCancellation: native.open }));
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); vi.clearAllMocks(); });
async function setup() {
  const f = await boundedChatFixture(); closers.push(f.close); await f.send();
  const operationId = f.sent[0]!.operationId;
  const config = { ...f.services.config, storageDriver: "firestore-records" as const, firestoreProjectId: "demo-lcwe-records", firestoreDatabaseId: "(default)", firestoreWorkspaceId: "test_control" };
  const snapshot = vi.fn(() => f.repository.snapshot()), close = vi.fn(async () => {});
  const request = vi.fn(async (state: Awaited<ReturnType<typeof snapshot>>, user: NonNullable<Awaited<ReturnType<typeof f.repository.effectiveUser>>>, id: string) => {
    const op = authorizeChatOperation(state, state.chatOperations[id], user);
    return { ...publicChatOperation(op), cancellationRequested: ["QUEUED", "RUNNING"].includes(op.status) || op.cancellationRequested === true };
  });
  native.open.mockReturnValue({ snapshot, request, close }); native.runtime.mockRejectedValue(new Error("Full runtime/writer must not be opened"));
  const path = `/api/chat/operations/${operationId}/cancel`;
  const send = (options: { raw?: string; headers?: Record<string, string>; url?: string; method?: string } = {}) => handleFunctionHttp({ config, root: "unused", transport: { timeoutMs: 1000, enqueue: vi.fn() } },
    { method: options.method ?? "POST", url: options.url ?? path, headers: { "content-type": "application/json", ...(options.headers ?? f.headers) }, rawBody: Buffer.from(options.raw ?? "{}") });
  return { ...f, config, snapshot, closeControl: close, requestControl: request, path, operationId, send };
}
const body = (result: Awaited<ReturnType<typeof handleFunctionHttp>>) => JSON.parse(result.body.toString());

test("exact native Cancel records only a durable stop request and awaits cleanup without opening full runtime or dispatch", async () => {
  const f = await setup(); let finish!: () => void, settled = false;
  f.closeControl.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = f.send().then(result => { settled = true; return result; });
  await vi.waitFor(() => expect(f.closeControl).toHaveBeenCalledOnce()); expect(settled).toBe(false); finish();
  const result = await pending; expect(result.statusCode).toBe(202); expect(body(result).data).toMatchObject({ id: f.operationId, status: "QUEUED", cancellationRequested: true });
  expect(result.headers["cache-control"]).toBe("no-store"); expect(result.headers["x-trace-id"]).toBeTruthy();
  expect(native.runtime).not.toHaveBeenCalled(); expect(f.requestControl).toHaveBeenCalledOnce(); expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test.each([{}, { authorization: "Bearer invalid" }])("invalid authentication never opens cancellation storage: %j", async headers => {
  const f = await setup(), result = await f.send({ headers }); expect(result.statusCode).toBe(401);
  expect(native.open).not.toHaveBeenCalled(); expect(f.requestControl).not.toHaveBeenCalled(); expect(native.runtime).not.toHaveBeenCalled();
});

test.each(["deleted", "inactive", "permission"])("current %s identity is denied before a stop intent is recorded", async kind => {
  const f = await setup(); await f.repository.mutate(state => {
    if (kind === "deleted") delete state.users.owner;
    if (kind === "inactive") state.users.owner!.status = "Inactive";
    if (kind === "permission") state.roles.role_admin!.permissions = [];
  });
  expect((await f.send()).statusCode).toBe(kind === "deleted" ? 401 : 403); expect(f.requestControl).not.toHaveBeenCalled();
});

test("another account cannot cancel the owner's original operation", async () => {
  const f = await setup(); await f.repository.mutate(state => { state.users.other = { ...state.users.owner!, id: "other", email: "other@example.test" }; });
  const headers = { authorization: `Bearer ${jwt.sign({}, f.config.jwtSecret, { algorithm: "HS256", subject: "other", expiresIn: 3600 })}` };
  const result = await f.send({ headers }); expect(result.statusCode).toBe(404); expect(native.runtime).not.toHaveBeenCalled();
});

test.each(["{", "null", "[]", '"invalid"', '{"run":true}', '{"model":"other"}'])("malformed or expanded command cannot smuggle execution authority: %s", async raw => {
  const f = await setup(); expect((await f.send({ raw })).statusCode).toBe(400); expect(f.requestControl).not.toHaveBeenCalled();
});

test("query commands and oversized bodies are refused without a cancellation write", async () => {
  const f = await setup(); expect((await f.send({ url: `${f.path}?run=true` })).statusCode).toBe(400);
  expect((await f.send({ raw: JSON.stringify({ ignored: "a".repeat(1024) }) })).statusCode).toBe(413); expect(f.requestControl).not.toHaveBeenCalled();
});

test("coherence retry reloads and reauthenticates; current revocation cannot inherit the first image's authority", async () => {
  const f = await setup(); f.requestControl.mockImplementationOnce(async () => {
    await f.repository.mutate(state => { state.users.owner!.status = "Inactive"; }); throw new FirestoreSnapshotChanged();
  });
  expect((await f.send()).statusCode).toBe(403); expect(f.snapshot).toHaveBeenCalledTimes(2); expect(f.requestControl).toHaveBeenCalledOnce();
});

test("only explicit pre-commit head changes can retry; uncertain commit or cleanup is not replayed", async () => {
  const f = await setup(); f.requestControl.mockRejectedValueOnce(new Error("private ACK diagnostic"));
  const result = await f.send(); expect(result.statusCode).toBe(503); expect(body(result).meta.code).toBe("CHAT_CANCELLATION_UNCONFIRMED");
  expect(result.body.toString()).not.toContain("private ACK"); expect(f.requestControl).toHaveBeenCalledOnce();
  f.requestControl.mockClear(); f.closeControl.mockRejectedValueOnce(new Error("private teardown diagnostic"));
  const cleanup = await f.send(); expect(cleanup.statusCode).toBe(503); expect(cleanup.body.toString()).not.toContain("teardown diagnostic"); expect(f.requestControl).toHaveBeenCalledOnce();
});

test("persistent head changes exhaust a bounded authentication budget without full-runtime fallback", async () => {
  const f = await setup(); f.requestControl.mockRejectedValue(new FirestoreSnapshotChanged());
  expect((await f.send()).statusCode).toBe(503); expect(f.snapshot).toHaveBeenCalledTimes(3); expect(f.requestControl).toHaveBeenCalledTimes(3); expect(native.runtime).not.toHaveBeenCalled();
});

test("terminal progress is returned honestly without claiming a newly recorded cancellation", async () => {
  const f = await setup(); await f.repository.mutate(state => { state.chatOperations[f.operationId]!.status = "FAILED"; });
  const result = await f.send(); expect(result.statusCode).toBe(200); expect(body(result).data.cancellationRequested).toBe(false); expect(body(result).message).toContain("already terminal");
});

test("preflight opens no storage and the fixed selector does not intercept other commands or deployments", async () => {
  const f = await setup(); const result = await f.send({ method: "OPTIONS", headers: { origin: f.config.corsOrigins[0]!, "access-control-request-method": "POST" } });
  expect(result.statusCode).toBe(204); expect(native.open).not.toHaveBeenCalled(); expect(native.runtime).not.toHaveBeenCalled();
  for (const method of ["GET", "PUT", "DELETE"]) expect(isFunctionChatCancellationRequest(f.config, { method, url: f.path, headers: {} })).toBe(false);
  for (const url of [`${f.path}/extra`, `${f.path}/`, "/api/chat/sessions", "/api/executions/run/cancel"]) expect(isFunctionChatCancellationRequest(f.config, { method: "POST", url, headers: {} })).toBe(false);
  expect(isFunctionChatCancellationRequest({ ...f.config, storageDriver: "memory" }, { method: "POST", url: f.path, headers: {} })).toBe(false);
});
