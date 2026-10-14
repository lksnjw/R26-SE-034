import { afterEach, expect, test, vi } from "vitest";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";
import { assertChatCancellationIntent, chatCancellationIntent, chatCancellationIntentSchema, configureChatCancellation } from "../src/agent/chat-cancellation.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function setup() { const f = await boundedChatFixture(); closers.push(f.close); await f.send(); return f; }

test("stop command binds the complete original task, not caller-supplied execution authority", async () => {
  const f = await setup(), op = (await f.repository.snapshot()).chatOperations[f.sent[0]!.operationId]!, intent = chatCancellationIntent(op);
  expect(assertChatCancellationIntent(op, intent)).toEqual(intent);
  expect(() => chatCancellationIntentSchema.parse({ ...intent, provider: "other", content: "Run instead" })).toThrow();
  for (const field of ["actorId", "operationId", "taskId", "bindingHash", "authorityFingerprint", "createdAt"] as const)
    expect(() => assertChatCancellationIntent(op, { ...intent, [field]: `${intent[field]}-different` })).toThrow();
  expect(() => configureChatCancellation(f.repository, { requested: async () => false })).not.toThrow();
  expect(() => configureChatCancellation(f.repository, { requested: async () => true })).toThrow("new bounded owner");
});

test("queued durable stop intent is consumed before any model/tool work and keeps the original terminal receipt", async () => {
  const f = await setup(), requested = vi.fn(async () => true); configureChatCancellation(f.repository, { requested });
  const result = await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 }); expect(result.status).toBe("CANCELLED");
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
  const state = await f.repository.snapshot(); expect(state.chats[f.sessionId]!.messages).toHaveLength(1);
  expect(state.chatOperationEvents[result.id]!.filter(event => event.type === "operation.cancel_requested")).toHaveLength(1);
  expect((await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).status).toBe("CANCELLED"); expect(requested).toHaveBeenCalledOnce();
});

test("running model is stopped by the owned observer, not by another writable repository", async () => {
  const f = await setup(); let stop = false, release!: (value: Response) => void;
  configureChatCancellation(f.repository, { requested: async () => stop });
  f.fetchImplementation.mockImplementationOnce((_url, init) => new Promise((resolve, reject) => {
    release = resolve; init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  const result = f.queue.executeTask(f.sent[0]!, { timeoutMs: 3000 }); await vi.waitFor(() => expect(f.fetchImplementation).toHaveBeenCalledOnce()); stop = true;
  expect((await result).status).toBe("CANCELLED"); expect(f.sdk.callTool).not.toHaveBeenCalled();
  release(Response.json({ choices: [{ message: { content: "Late ignored answer" } }] }));
  expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1);
});

test("stop check at the provider-to-tool boundary prevents a dispatch before the next poll", async () => {
  const f = await setup(); let stop = false;
  configureChatCancellation(f.repository, { requested: async () => stop });
  const original = f.fetchImplementation.getMockImplementation()!;
  f.fetchImplementation.mockImplementationOnce(async (...args) => { const value = await original(...args); stop = true; return value; });
  expect((await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).status).toBe("CANCELLED");
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1);
});

test("stop check before an answer commit fences a late model answer", async () => {
  const f = await setup(); let stop = false;
  configureChatCancellation(f.repository, { requested: async () => stop });
  f.fetchImplementation.mockImplementationOnce(async () => { stop = true; return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Do not save this answer" } }] }); });
  expect((await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).status).toBe("CANCELLED");
  expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("cancelling an in-flight unconfirmed SDK read preserves UNKNOWN instead of claiming rollback", async () => {
  const f = await setup(); let stop = false, release!: (value: unknown) => void;
  configureChatCancellation(f.repository, { requested: async () => stop });
  f.sdk.callTool.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const result = f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 }); await vi.waitFor(() => expect(f.sdk.callTool).toHaveBeenCalledOnce()); stop = true;
  const stopped = await result; expect(stopped.status).toBe("RECOVERY_REQUIRED"); expect(stopped.cancellationRequested).toBe(true);
  expect(stopped.attempts[0]!.status).toBe("UNKNOWN");
  release({ content: [], structuredContent: { value: "Late read" } });
  expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1);
  expect((await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).status).toBe("RECOVERY_REQUIRED"); expect(f.sdk.callTool).toHaveBeenCalledOnce();
});

test("unavailable control channel fences further work but does not invent a user cancellation", async () => {
  const f = await setup(); configureChatCancellation(f.repository, { requested: async () => { throw new Error("Private control failure"); } });
  const stopped = await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 }); expect(stopped.status).toBe("FAILED"); expect(stopped.cancellationRequested).toBe(false);
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("a revoked current actor cannot consume a previously authenticated intent as authority", async () => {
  const f = await setup(); configureChatCancellation(f.repository, { requested: async () => true });
  await f.repository.mutate(state => { state.users.owner!.status = "Inactive"; });
  const stopped = await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 }); expect(stopped.status).toBe("FAILED"); expect(stopped.cancellationRequested).toBe(false);
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});
