/** @jest-environment jsdom */
import React from "react";
import { jest, expect, test, beforeEach, afterEach } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const accountA = { id: "auth-a", role: "Operator", permissions: ["chat:use"] };
const accountB = { id: "auth-b", role: "Operator", permissions: ["chat:use"] };
const privateSession = { id: "auth-a-chat", title: "A private chat" };
const privateMessage = { id: "auth-a-message", role: "assistant", text: "A confidential result" };
let serverActor;
const auth = { me: jest.fn(), login: jest.fn(), register: jest.fn(), logout: jest.fn() };
const chat = Object.fromEntries(["listSessions", "getSession", "operations", "operation", "createSession", "deleteSession", "updateSession", "sendMessage", "capabilities", "cancelOperation"].map(name => [name, jest.fn()]));
jest.unstable_mockModule("../services/auth.service", () => ({ authService: auth }));
jest.unstable_mockModule("../services/chat.service", () => ({ chatService: chat }));
const { AuthProvider, useAuthContext } = await import("./AuthContext");
const { useChat } = await import("../hooks/useChat");
const { useChatSessions } = await import("../hooks/useChatSessions");
let client;
function wrapper({ children }) { return <QueryClientProvider client={client}><AuthProvider>{children}</AuthProvider></QueryClientProvider>; }
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function useProbe() {
  const authentication = useAuthContext();
  const sessions = useChatSessions();
  const messages = useChat(privateSession.id);
  return { authentication, sessions, messages };
}
async function loaded() {
  const view = renderHook(useProbe, { wrapper });
  await waitFor(() => expect(view.result.current.messages.messages).toEqual([privateMessage]));
  await waitFor(() => expect(view.result.current.sessions.sessions).toEqual([privateSession]));
  return view;
}
function cachedPrivateData() {
  return client.getQueryCache().getAll().flatMap(query => query.state.data === undefined ? [] : [query.state.data]);
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  serverActor = accountA;
  localStorage.setItem("workflow.user", JSON.stringify(accountA));
  localStorage.setItem("workflow.authToken", "a-token");
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 }, mutations: { retry: false } } });
  auth.me.mockImplementation(async () => serverActor);
  auth.login.mockImplementation(async () => { serverActor = accountB; return { user: accountB }; });
  auth.logout.mockImplementation(async () => { localStorage.clear(); });
  chat.operations.mockResolvedValue([]);
  chat.listSessions.mockImplementation(async () => serverActor.id === accountA.id && serverActor.permissions?.includes("chat:use") ? [privateSession] : []);
  chat.getSession.mockImplementation(async id => {
    if (serverActor.id !== accountA.id || !serverActor.permissions?.includes("chat:use")) throw Object.assign(new Error("Forbidden"), { response: { status: 403, data: { message: "Not your session" } } });
    return { id, messages: [privateMessage] };
  });
});
afterEach(() => { cleanup(); client.clear(); localStorage.clear(); sessionStorage.clear(); Object.values(auth).forEach(mock => mock.mockReset()); Object.values(chat).forEach(mock => mock.mockReset()); });

test("actual logout removes sensitive query data before a B login reuses the QueryClient", async () => {
  const view = await loaded();
  await act(async () => { await view.result.current.authentication.logout(); });
  expect(view.result.current.authentication.user).toBeNull();
  expect(JSON.stringify(cachedPrivateData())).not.toContain(privateMessage.text);
  await act(async () => { await view.result.current.authentication.login({ email: "b@example.test" }); });
  expect(view.result.current.authentication.user).toEqual(accountB);
  expect(view.result.current.messages.messages).toEqual([]);
});

test("actual auth:expired event removes A list and messages from the shared cache", async () => {
  const view = await loaded();
  act(() => { window.dispatchEvent(new CustomEvent("auth:expired")); });
  expect(view.result.current.authentication.user).toBeNull();
  expect(JSON.stringify(cachedPrivateData())).not.toContain(privateMessage.text);
  expect(view.result.current.sessions.sessions).toEqual([]);
  expect(view.result.current.messages.messages).toEqual([]);
});

test("actual A to B login changes identity without returning A's cached content", async () => {
  const view = await loaded();
  await act(async () => { await view.result.current.authentication.login({ email: "b@example.test" }); });
  expect(view.result.current.authentication.user).toEqual(accountB);
  expect({ list: view.result.current.sessions.sessions, messages: view.result.current.messages.messages }).toEqual({ list: [], messages: [] });
});

test("an initial held A /me response cannot replace B after B logs in", async () => {
  const heldMe = deferred();
  auth.me.mockReturnValueOnce(heldMe.promise);
  const view = renderHook(useProbe, { wrapper });
  await waitFor(() => expect(auth.me).toHaveBeenCalled());
  await act(async () => { await view.result.current.authentication.login({ email: "b@example.test" }); });
  expect(view.result.current.authentication.user).toEqual(accountB);
  await act(async () => { heldMe.resolve(accountA); });
  expect(view.result.current.authentication.user).toEqual(accountB);
  expect(JSON.parse(localStorage.getItem("workflow.user"))).not.toEqual(accountA);
});

test("a held logout completion cannot end a newer B login", async () => {
  const view = await loaded();
  const heldLogout = deferred();
  auth.logout.mockReturnValue(heldLogout.promise);
  let loggingOut;
  act(() => { loggingOut = view.result.current.authentication.logout(); });
  await act(async () => { await view.result.current.authentication.login({ email: "b@example.test" }); });
  await act(async () => { heldLogout.resolve(); await loggingOut; });
  expect(view.result.current.authentication.user).toEqual(accountB);
});

test("a same-authority /me refresh preserves A's usable fresh cache", async () => {
  const view = await loaded();
  const before = cachedPrivateData().find(data => data?.messages);
  const listCalls = chat.listSessions.mock.calls.length;
  const readCalls = chat.getSession.mock.calls.length;
  auth.me.mockResolvedValue({ ...accountA, name: "Updated display name", permissions: ["chat:use", "chat:use"] });
  await act(async () => { await view.result.current.authentication.refreshUser(); });
  expect(view.result.current.messages.messages).toEqual([privateMessage]);
  expect(cachedPrivateData().find(data => data?.messages)).toBe(before);
  expect(chat.listSessions).toHaveBeenCalledTimes(listCalls);
  expect(chat.getSession).toHaveBeenCalledTimes(readCalls);
});

test("equivalent permission ordering and duplicates do not rotate authority or flush cache", async () => {
  const ordered = { ...accountA, permissions: ["chat:use", "workflow:read"] };
  localStorage.setItem("workflow.user", JSON.stringify(ordered));
  serverActor = ordered;
  const view = await loaded();
  const cachedSession = cachedPrivateData().find(data => data?.messages);
  const listCalls = chat.listSessions.mock.calls.length;
  const readCalls = chat.getSession.mock.calls.length;
  auth.me.mockResolvedValue({ ...ordered, name: "Updated", permissions: ["workflow:read", "chat:use", "chat:use"] });
  await act(async () => { await view.result.current.authentication.refreshUser(); });
  expect(view.result.current.authentication.user.permissions).toEqual(["workflow:read", "chat:use", "chat:use"]);
  expect(cachedPrivateData().find(data => data?.messages)).toBe(cachedSession);
  expect(chat.listSessions).toHaveBeenCalledTimes(listCalls);
  expect(chat.getSession).toHaveBeenCalledTimes(readCalls);
});

test("an actual role or permission authority change removes earlier sensitive cache", async () => {
  const view = await loaded();
  auth.me.mockImplementation(async () => {
    serverActor = { ...accountA, role: "Viewer", permissions: [] };
    return serverActor;
  });
  await act(async () => { await view.result.current.authentication.refreshUser(); });
  expect(view.result.current.authentication.user.role).toBe("Viewer");
  expect(JSON.stringify(cachedPrivateData())).not.toContain(privateMessage.text);
});
