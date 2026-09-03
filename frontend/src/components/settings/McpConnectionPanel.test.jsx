/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
const status = jest.fn(), command = jest.fn();
let role = "Platform Admin", hasSettings = true;
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ usePermissions: () => ({ actorId: "admin", role, has: () => hasSettings }) }));
jest.unstable_mockModule("../../services/mcp-connection.service", () => ({ mcpConnectionService: { status, command } }));
const { default: Panel } = await import("./McpConnectionPanel.jsx");
const connection = (overrides = {}) => ({ id: "erpbridge-default", state: "DISCONNECTED", revision: 1, initialized: false, configured: true, persistence: "memory-only", supports: { connect: true, test: true, disconnect: true }, ...overrides });
const page = (overrides = {}) => ({ connections: [connection(overrides)], recentOperations: [] });
let clients = [];
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } }); clients.push(client); return render(<QueryClientProvider client={client}><Panel /></QueryClientProvider>); }
async function choose(action = "connect") { fireEvent.click(await screen.findByRole("button", { name: action === "connect" ? "Connect MCP" : action === "test" ? "Test MCP initialization" : "Disconnect MCP" })); }
function receipt(action, id, body, state = "DONE") { return { operation: { id: "mcpop_1", actorId: "admin", requestId: body.requestId, action, state, revision: body.baseRevision + (action === "test" ? 0 : 1) }, connection: { id } }; }
beforeEach(() => { sessionStorage.clear(); status.mockResolvedValue(page()); role = "Platform Admin"; hasSettings = true; });
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients = []; status.mockReset(); command.mockReset(); jest.restoreAllMocks(); });

test("real lifecycle commands require explicit confirmation and display initialization separately from tool authority", async () => {
  command.mockImplementation(async (action, id, body) => { status.mockResolvedValue(page({ state: "CONNECTED", revision: 2, initialized: true })); return receipt(action, id, body); });
  mount(); await choose(); expect(command).not.toHaveBeenCalled(); expect(screen.getByText(/Create a new connection revision/)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm connect" })); expect(await screen.findByText(/Saved connect operation: Done/)).not.toBeNull();
  expect(command).toHaveBeenCalledWith("connect", "erpbridge-default", { baseRevision: 1, requestId: expect.stringMatching(/^mcp_/) });
  expect(await screen.findByText(/MCP initialized and discovery completed/)).not.toBeNull(); expect(screen.queryByText("Ready")).toBeNull(); expect(screen.getByRole("button", { name: "Reconnect MCP" })).not.toBeNull();
});

test("unconfirmed commands retain the exact request across remount and duplicate interrupted receipts don't become success", async () => {
  command.mockRejectedValueOnce(new Error("ACK lost")); const first = mount(); await choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm connect" }));
  await screen.findByText("Unconfirmed MCP connect request"); await waitFor(() => expect(screen.getByRole("button", { name: "Retry exact MCP request" }).disabled).toBe(false));
  const request = command.mock.calls[0]; first.unmount(); command.mockImplementationOnce(async (...args) => receipt(...args, "INTERRUPTED")); mount();
  fireEvent.click(await screen.findByRole("button", { name: "Retry exact MCP request" })); expect(await screen.findByText(/Saved connect operation: Interrupted/)).not.toBeNull();
  expect(command.mock.calls[1]).toEqual(request); expect(sessionStorage.getItem("workflow.mcp-operation.admin")).toBeNull();
});

test("wrong request receipt remains unconfirmed and RUNNING duplicates don't repeat initialization or silently clear recovery", async () => {
  command.mockImplementation(async (action, id, body) => ({ ...receipt(action, id, body), operation: { ...receipt(action, id, body).operation, requestId: "wrong-request" } }));
  mount(); await choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm connect" })); await screen.findByRole("alert"); expect(sessionStorage.getItem("workflow.mcp-operation.admin")).not.toBeNull();
  command.mockImplementation(async (...args) => receipt(...args, "RUNNING")); fireEvent.click(screen.getByRole("button", { name: "Retry exact MCP request" }));
  expect(await screen.findByText(/saved and still awaiting completion/)).not.toBeNull(); expect(sessionStorage.getItem("workflow.mcp-operation.admin")).not.toBeNull();
});

test("unavailable status, missing settings permission and non-admin role never provide a new lifecycle command", async () => {
  hasSettings = false; mount(); expect(screen.queryByText("ERPBridge MCP connection")).toBeNull(); expect(status).not.toHaveBeenCalled();
  cleanup(); hasSettings = true; role = "Workflow Builder"; mount(); expect(await screen.findByText(/Read only. Platform Admin/)).not.toBeNull(); expect(screen.queryByRole("button", { name: "Connect MCP" })).toBeNull();
  cleanup(); role = "Platform Admin"; status.mockRejectedValue(new Error("offline")); mount(); expect(await screen.findByText(/MCP lifecycle status unavailable/)).not.toBeNull(); expect(screen.queryByRole("button", { name: "Connect MCP" })).toBeNull(); expect(command).not.toHaveBeenCalled();
});

test("local storage failure prevents untracked commands and explicit recovery reloads before clearing corrupt state", async () => {
  mount(); await choose(); jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("no local persistence"); }); fireEvent.click(screen.getByRole("button", { name: "Confirm connect" }));
  await screen.findByRole("alert"); expect(command).not.toHaveBeenCalled(); cleanup(); jest.restoreAllMocks(); sessionStorage.setItem("workflow.mcp-operation.admin", "invalid"); mount();
  expect(await screen.findByText("Local MCP request record needs recovery")).not.toBeNull(); expect(screen.queryByRole("button", { name: "Retry exact MCP request" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reload status and end MCP retries" })); expect(await screen.findByText(/Local retries ended after status reload/)).not.toBeNull(); expect(sessionStorage.length).toBe(0);
});

test("disconnect warns about in-flight unknown outcomes; test is disposable and supported controls follow backend capabilities", async () => {
  command.mockImplementation(async (...args) => receipt(...args)); mount(); await choose("disconnect"); expect(screen.getByText(/In-flight remote outcomes may be unknown/)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" })); await screen.findByText(/Saved disconnect operation: Done/);
  await choose("test"); expect(screen.getByText(/disposable session/)).not.toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(command).toHaveBeenCalledTimes(1);
  cleanup(); status.mockResolvedValue(page({ configured: false, state: "UNCONFIGURED", supports: { connect: false, test: false, disconnect: true } })); mount();
  expect((await screen.findByRole("button", { name: "Connect MCP" })).disabled).toBe(true); expect(screen.getByRole("button", { name: "Test MCP initialization" }).disabled).toBe(true);
});
