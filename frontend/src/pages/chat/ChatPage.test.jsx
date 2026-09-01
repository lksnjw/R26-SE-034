/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { settingsService } from "../../services/settings.service";

const source = "name: Report\ntrigger:\n  type: manual\nsteps:\n - id: invoices\n   action: demo.echo\n   parameters:\n     value: original\n";
const record = { workflowId: "report", version: 4, contentHash: `sha256:${"a".repeat(64)}`, yaml: source, validation: { passed: true }, published: false, bridge: "not_connected" };
const normalSend = jest.fn().mockResolvedValue({});
jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => ({ user: { id: "admin", permissions: ["workflow:write"] } }) }));
jest.unstable_mockModule("../../hooks/useChatSessions", () => ({ useChatSessions: () => ({ selectedSessionId: "chat", sessions: [], loading: false }) }));
jest.unstable_mockModule("../../hooks/useChat", () => ({ useChat: () => ({ messages: [{ id: "saved", role: "assistant", artifacts: { workflowId: "report", yaml: source } }], send: normalSend, loading: false }) }));
jest.unstable_mockModule("../../components/chat/ChatMessage", () => ({ default: () => null }));
const { default: ChatPage } = await import("./ChatPage");
afterEach(() => { cleanup(); sessionStorage.clear(); jest.restoreAllMocks(); normalSend.mockClear(); });

test("canvas is left of chat; selecting a node routes the main composer to a revision-bound proposal, never direct execution", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn(); // jsdom has no layout/scroll implementation.
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(settingsService, "providers").mockResolvedValue([]);
  const propose = jest.spyOn(workflowService, "proposeNode").mockResolvedValue({ id: "one", workflowId: "report", nodeId: "invoices", baseVersion: 4, baseHash: record.contentHash, status: "PROPOSED", command: { type: "updateNode", nodeId: "invoices", patch: { description: "Reviewed" } }, before: {}, after: { description: "Reviewed" } });
  const command = jest.spyOn(workflowService, "command");
  const run = jest.spyOn(workflowService, "run");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter><ChatPage /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByTestId("workspace-canvas-pane").compareDocumentPosition(screen.getByTestId("workspace-chat-pane")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: /01 invoices/ }));
  await screen.findByText("Editing node · invoices");
  expect(screen.queryByRole("textbox", { name: "Selected node prompt" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Rename this node" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("region", { name: "Node change preview" });
  expect(propose).toHaveBeenCalledWith("report", expect.objectContaining({ version: 4, contentHash: record.contentHash, nodeId: "invoices" }), "invoices", "Rename this node", "chat");
  expect(normalSend).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to workflow assistant" }).value).toBe(""));
  fireEvent.click(screen.getByRole("button", { name: "Exit node editing" }));
  await waitFor(() => expect(screen.queryByText("Editing node · invoices")).toBeNull());
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Discuss the whole workflow" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(normalSend).toHaveBeenCalledWith("Discuss the whole workflow", "chat", expect.any(Object)));
  client.clear();
});
