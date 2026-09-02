/** @jest-environment jsdom */
import React from "react";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { jest, expect, test, beforeEach, afterEach } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
const user = { id: "owner", role: "Operator", permissions: ["chat:use"] };
const service = { capabilities: jest.fn(), getSession: jest.fn(), operations: jest.fn(), operation: jest.fn(), sendMessage: jest.fn(), cancelOperation: jest.fn() };
jest.unstable_mockModule("../context/AuthContext", () => ({ useAuthContext: () => ({ user }) }));
jest.unstable_mockModule("../services/chat.service", () => ({ chatService: service }));
const { useChat } = await import("./useChat");
const op = (status = "RUNNING") => ({ id: "job", sessionId: "chat", userMessageId: "user-message", status, stage: "MODEL", lastSequence: 0, attempts: [] });
let client;
function wrapper({ children }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto }); globalThis.TextEncoder = TextEncoder;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  service.getSession.mockResolvedValue({ id: "chat", messages: [] }); service.operations.mockResolvedValue([]);
  service.capabilities.mockResolvedValue({ profile: "chat-admission-v1", asyncChat: true, nodeProposals: true });
  service.operation.mockResolvedValue({ operation: op(), events: [], nextCursor: 0, hasMore: false });
});
afterEach(() => { cleanup(); client.clear(); sessionStorage.clear(); Object.values(service).forEach(mock => mock.mockReset()); });

test("acknowledges before completion, displays saved user once and restores the operation on reload", async () => {
  const receipt = { operation: op(), userMessage: { id: "user-message", operationId: "job", role: "user", text: "Read invoices" }, session: { id: "chat" } };
  service.sendMessage.mockImplementation(async () => { service.operations.mockResolvedValue([op()]); service.getSession.mockResolvedValue({ id: "chat", messages: [receipt.userMessage] }); return receipt; }); const { result, unmount } = renderHook(() => useChat("chat"), { wrapper });
  await waitFor(() => expect(service.getSession).toHaveBeenCalled());
  await act(async () => { expect(await result.current.send("Read invoices")).toEqual(receipt); });
  expect(service.sendMessage.mock.calls[0][2]).toMatchObject({ delivery: "async-chat", idempotencyKey: expect.stringMatching(/^[a-f0-9]{48}$/) });
  await waitFor(() => expect(result.current.loading).toBe(true)); expect(result.current.messages).toHaveLength(1); expect(result.current.messages[0].role).toBe("user");
  unmount(); service.operations.mockResolvedValue([op()]); client.clear();
  const restored = renderHook(() => useChat("chat"), { wrapper }); await waitFor(() => expect(restored.result.current.operation?.id).toBe("job"));
  expect(service.sendMessage).toHaveBeenCalledTimes(1);
});
test("a lost acknowledgement retains its identity across retry and remount without storing raw text", async () => {
  service.sendMessage.mockRejectedValueOnce(new Error("Connection lost")); const first = renderHook(() => useChat("chat"), { wrapper });
  await act(async () => { expect(await first.result.current.send("Private invoice prompt", undefined, { model: "a" })).toBeNull(); });
  const key = service.sendMessage.mock.calls[0][2].idempotencyKey;
  expect(JSON.stringify(Object.values(sessionStorage))).not.toContain("Private invoice prompt"); first.unmount();
  service.sendMessage.mockImplementation(async () => { const userMessage = { id: "saved", operationId: "job", role: "user", text: "Private invoice prompt" }; service.operations.mockResolvedValue([op()]); service.getSession.mockResolvedValue({ id: "chat", messages: [userMessage] }); return { operation: { ...op(), userMessageId: "saved" }, userMessage, session: { id: "chat" } }; });
  const next = renderHook(() => useChat("chat"), { wrapper }); await act(async () => { await next.result.current.send("Private invoice prompt", undefined, { model: "a" }); });
  expect(service.sendMessage.mock.calls[1][2].idempotencyKey).toBe(key); await waitFor(() => expect(next.result.current.messages.filter(message => message.id === "saved")).toHaveLength(1));
});
test("saved terminal answers refresh history and cancellation is never a message retry", async () => {
  service.operations.mockResolvedValue([op()]); service.cancelOperation.mockResolvedValue(op("CANCELLED"));
  const { result } = renderHook(() => useChat("chat"), { wrapper }); await waitFor(() => expect(result.current.operation?.id).toBe("job"));
  service.operation.mockResolvedValue({ operation: { ...op("ANSWERED"), assistantMessageId: "answer" }, events: [], nextCursor: 0, hasMore: false });
  service.getSession.mockResolvedValue({ id: "chat", messages: [{ id: "answer", role: "assistant", text: "Saved answer" }] });
  act(() => result.current.cancelOperation()); await waitFor(() => expect(result.current.messages[0]?.id).toBe("answer"));
  expect(service.cancelOperation).toHaveBeenCalledWith("job"); expect(service.sendMessage).not.toHaveBeenCalled(); expect(result.current.loading).toBe(false);
});
test("local revision-bound email edits do not enter the external-processing queue", async () => {
  service.sendMessage.mockResolvedValue({ assistantMessage: { id: "draft", role: "assistant", text: "Draft not sent" } });
  const { result } = renderHook(() => useChat("chat"), { wrapper }); const options = { emailDraftCommand: { commandId: "local", baseVersion: 1 } };
  await act(async () => { await result.current.send("Save draft", undefined, options); }); expect(service.sendMessage).toHaveBeenCalledWith("chat", "Save draft", options);
  expect(service.capabilities).not.toHaveBeenCalled();
});

test.each([undefined, { profile: "chat-admission-v1", asyncChat: false }, { profile: "chat-admission-v1", asyncChat: true, nodeProposals: false }])("unsupported admission fails before POST and keeps the draft identity: %s", async capabilities => {
  service.capabilities.mockResolvedValue(capabilities);
  const { result } = renderHook(() => useChat("chat"), { wrapper });
  await act(async () => { expect(await result.current.send("Edit selected node", undefined, { nodeContext: { workflowId: "w", nodeId: "n", baseVersion: 1, baseHash: "hash" } })).toBeNull(); });
  expect(service.sendMessage).not.toHaveBeenCalled(); expect(result.current.error).toContain("No message was sent");
});

test("malformed or wrong-node acknowledgements never clear retry identity or install an answer", async () => {
  const context = { workflowId: "w", nodeId: "n", baseVersion: 1, baseHash: "hash" };
  const receipt = { operation: { ...op(), nodeContext: { ...context, nodeId: "other" } }, session: { id: "chat" }, userMessage: { id: "user-message", operationId: "job", role: "user", text: "Edit" } };
  service.sendMessage.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ assistantMessage: { id: "bad", role: "assistant" } });
  const { result } = renderHook(() => useChat("chat"), { wrapper });
  await act(async () => { expect(await result.current.send("Edit", undefined, { nodeContext: context })).toBeNull(); });
  const key = service.sendMessage.mock.calls[0][2].idempotencyKey;
  await act(async () => { expect(await result.current.send("Edit", undefined, { nodeContext: context })).toBeNull(); });
  expect(service.sendMessage.mock.calls[1][2].idempotencyKey).toBe(key);
  expect(result.current.messages).toEqual([]);
});

test("a selected-node acknowledgement exposes saved progress, not an invented proposal", async () => {
  const context = { workflowId: "report", nodeId: "echo", baseVersion: 1, baseHash: "hash" };
  const operation = { ...op(), nodeContext: context }, userMessage = { id: "user-message", operationId: "job", role: "user", text: "Change node" };
  const receipt = { operation, userMessage, session: { id: "chat" } };
  service.sendMessage.mockImplementation(async () => { service.operations.mockResolvedValue([operation]); service.getSession.mockResolvedValue({ id: "chat", messages: [userMessage] }); return receipt; });
  service.operation.mockResolvedValue({ operation, events: [], nextCursor: 0, hasMore: false });
  const { result } = renderHook(() => useChat("chat"), { wrapper });
  await act(async () => { expect(await result.current.send("Change node", undefined, { nodeContext: context })).toEqual(receipt); });
  await waitFor(() => expect(result.current.operation?.nodeContext).toEqual(context));
  expect(result.current.messages).toEqual([userMessage]);
});
