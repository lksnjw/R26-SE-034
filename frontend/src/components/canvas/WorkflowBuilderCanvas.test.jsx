/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { dump } from "js-yaml";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { apiClient } from "../../config/axios.js";
import { workflowService } from "../../services/workflow.service.js";
import { executionService } from "../../services/execution.service.js";

jest.unstable_mockModule("@xyflow/react", () => {
  const Container = ({ children }) => React.createElement("div", null, children);
  return {
    addEdge: (connection, edges) => [...edges, connection],
    applyEdgeChanges: (_changes, edges) => edges,
    applyNodeChanges: (_changes, nodes) => nodes,
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: "arrow-closed" },
    MiniMap: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlow: Container,
    ReactFlowProvider: Container,
    useReactFlow: () => ({
      fitView: jest.fn(),
      screenToFlowPosition: (position) => position,
    }),
  };
});

const notify = jest.fn();
jest.unstable_mockModule("../../context/NotificationContext", () => ({
  useNotifications: () => ({ notify }),
}));

const { default: WorkflowBuilderCanvas } = await import("./WorkflowBuilderCanvas.jsx");

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  notify.mockClear();
  localStorage.clear();
});

test("writable builder loads and renders the registered tool catalog", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      success: true,
      data: [
        {
          name: "demo.echo",
          display_name: "Demo Echo",
          description: "Deterministic catalog tool",
          module: "General",
          status: "active_mcp_schema_present",
          allowed_roles: ["Platform Admin"],
          required_parameters: ["message"],
        },
      ],
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><WorkflowBuilderCanvas readOnly={false} /></MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByRole("button", { name: /Demo Echo/i })).not.toBeNull();
  await waitFor(() => {
    expect(get).toHaveBeenCalledWith("/tools/catalog", { params: { status: "active_mcp_schema_present" } });
  });
  expect(screen.queryByText(/Cannot read properties of undefined/i)).toBeNull();
  expect(screen.queryByText(/Tool catalog unavailable/i)).toBeNull();

  queryClient.clear();
});

const source = "name: report\ntrigger:\n  type: manual\nsteps:\n - id: first\n   action: demo.echo\n   parameters:\n     value: original\n";
function builder(workflowId) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = render(<QueryClientProvider client={queryClient}><MemoryRouter><WorkflowBuilderCanvas workflowId={workflowId} embedded /></MemoryRouter></QueryClientProvider>);
  return { queryClient, view };
}
function mockSaved() {
  jest.spyOn(workflowService, "getById").mockResolvedValue({ id: "report", name: "report", description: "" });
  jest.spyOn(workflowService, "getYAML").mockResolvedValue({ yaml: source });
  const revision = { version: 1, contentHash: `sha256:${"a".repeat(64)}`, yaml: source, can_attempt_run: true };
  jest.spyOn(workflowService, "readiness").mockResolvedValue(revision);
  jest.spyOn(workflowService, "publish").mockResolvedValue({});
  jest.spyOn(workflowService, "create").mockResolvedValue({ id: "new", name: "new" });
  jest.spyOn(workflowService, "command").mockResolvedValue({ ...revision, version: 2 });
  jest.spyOn(workflowService, "run").mockResolvedValue({ id: "run", status: "DONE", stepOutputs: {} });
  jest.spyOn(workflowService, "validateCanvas").mockResolvedValue({ validation: { passed: true, errors: [] }, step_errors: [], conversion: { profile: "source-order-canvas/v1" } });
  jest.spyOn(executionService, "getTimeline").mockResolvedValue([{ nodeId: "first", status: "DONE" }]);
  return revision;
}
test("Run on an unsaved imported workflow never creates, publishes or dispatches", async () => {
  mockSaved(); localStorage.setItem("workflow.pendingCanvasWorkflow", JSON.stringify({ yaml: source }));
  const { queryClient } = builder();
  fireEvent.click(await screen.findByRole("button", { name: "Run published workflow" }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run does not publish"), "error"));
  expect(workflowService.create).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
  queryClient.clear(); localStorage.clear();
});
test("published run calls readiness and displays recorded partial evidence after failure", async () => {
  mockSaved();
  workflowService.run.mockRejectedValue({ response: { data: { message: "Node failed", meta: { executionId: "failed-run" } } } });
  jest.spyOn(executionService, "get").mockResolvedValue({ id: "failed-run", status: "FAILED", finalOutput: { value: "actual partial answer" } });
  const { queryClient } = builder("report");
  fireEvent.click(await screen.findByRole("button", { name: "Run published workflow" }));
  await waitFor(() => expect(executionService.get).toHaveBeenCalledWith("failed-run"));
  await screen.findByText(/actual partial answer/);
  expect(workflowService.publish).not.toHaveBeenCalled();
  queryClient.clear();
});
test("explicit publication passes the exact acknowledged command revision", async () => {
  mockSaved(); const { queryClient } = builder("report");
  fireEvent.click(await screen.findByRole("button", { name: "Review & publish draft" }));
  await waitFor(() => expect(workflowService.publish).toHaveBeenCalledWith("report", "Published from visual builder", expect.objectContaining({ version: 2 })));
  expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1 }), expect.objectContaining({ type: "restoreDraft" }));
  expect(workflowService.run).not.toHaveBeenCalled(); queryClient.clear();
});

test("Check canvas validates the semantic graph without saving, publishing or running", async () => {
  mockSaved(); const { queryClient } = builder("report");
  fireEvent.click(await screen.findByRole("button", { name: "Check canvas" }));
  await screen.findByText("Canvas passed the full validation gate");
  expect(workflowService.validateCanvas).toHaveBeenCalledWith(expect.objectContaining({
    profile: "source-order-canvas/v1", name: "report", nodes: [expect.objectContaining({ id: "first", action: "demo.echo" })], edges: [],
  }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
  queryClient.clear();
});

test("explicit structured flow validates preserved source and directs structural edits to chat", async () => {
  mockSaved();
  const structuredSource = dump({ name: "report", trigger: { type: "manual" }, steps: [
    { id: "first", action: "demo.echo", parameters: {} },
    { id: "yesPath", action: "demo.echo", parameters: {} },
    { id: "noPath", action: "demo.echo", parameters: {} },
  ], metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: { kind: "sequence", nodes: [
    { kind: "action", nodeId: "first" },
    { kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "yesPath" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "noPath" }] } },
  ] } } } });
  workflowService.getYAML.mockResolvedValue({ yaml: structuredSource });
  const { queryClient } = builder("report");
  expect(await screen.findByText(/reflects explicit saved branch\/collection semantics/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit structure in governed chat" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check canvas" }));
  await screen.findByText("Canvas passed the full validation gate");
  expect(workflowService.validateCanvas).toHaveBeenCalledWith({ yaml: structuredSource });
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
  queryClient.clear();
});

test("malformed imported source is quarantined without consuming the handoff or rewriting source", async () => {
  mockSaved(); const yaml = "steps: [unfinished";
  localStorage.setItem("workflow.pendingCanvasWorkflow", JSON.stringify({ yaml }));
  const { queryClient } = builder();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(yaml)).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("workflow.pendingCanvasWorkflow")).yaml).toBe(yaml);
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
  queryClient.clear();
});
