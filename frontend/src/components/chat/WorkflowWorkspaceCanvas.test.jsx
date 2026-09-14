/** @jest-environment jsdom */
import React from "react";
import { expect, test, afterEach, jest } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
const editorProps = jest.fn();
jest.unstable_mockModule("./WorkflowWorkspaceEditor", () => ({ default: (props) => { editorProps(props); return React.createElement("div", { "data-testid": "saved-workflow-editor" }); } }));
const { default: WorkflowWorkspaceCanvas } = await import("./WorkflowWorkspaceCanvas");
afterEach(() => { cleanup(); sessionStorage.clear(); editorProps.mockClear(); });

test("canvas is present before generation", () => {
  render(<WorkflowWorkspaceCanvas messages={[]} />);
  expect(screen.getByRole("region", { name: "Workflow canvas" })).toBeTruthy();
  expect(screen.getByText("Your workflow starts here")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
});

test("saved workflow selector numbers identify conversations' artifacts, not current draft versions", () => {
  render(<WorkflowWorkspaceCanvas messages={[{ id: "saved", artifacts: { workflowId: "report", yaml: "name: Report\nsteps: []" } }]} />);
  expect(screen.getByRole("option", { name: "Workflow 1 · report" })).toBeTruthy(); expect(screen.queryByRole("option", { name: "Draft 1 · report" })).toBeNull();
});

test("selects node parameters and retains draft after non-workflow answer", () => {
  const messages = [{ id: "one", artifacts: { selected_workflow_yaml: "name: Report\nsteps:\n - id: fetch\n   action: erp.list\n   params:\n     status: open" } }];
  const view = render(<WorkflowWorkspaceCanvas messages={messages} />);
  fireEvent.click(screen.getByRole("button", { name: /fetch/ }));
  expect(screen.getByRole("complementary", { name: "Selected node details" }).textContent).toContain("Statusopen");
  expect(screen.getByRole("complementary", { name: "Selected node details" }).querySelector("pre")).toBeNull();
  view.rerender(<WorkflowWorkspaceCanvas messages={[...messages, { id: "two", artifacts: { intent: "QUERY" } }]} />);
  expect(screen.getByRole("button", { name: /fetch/ }).getAttribute("aria-pressed")).toBe("true");
});

test("restores selected draft and node after Settings navigation remount", () => {
  const messages = [{ id: "one", artifacts: { yaml: "steps:\n - id: fetch\n   action: erp.list" } }];
  const view = render(<WorkflowWorkspaceCanvas messages={messages} selectionStorageKey="canvas.account.session" />);
  fireEvent.click(screen.getByRole("button", { name: /fetch/ }));
  view.unmount();
  render(<WorkflowWorkspaceCanvas messages={messages} selectionStorageKey="canvas.account.session" />);
  expect(screen.getByRole("button", { name: /fetch/ }).getAttribute("aria-pressed")).toBe("true");
});

test("canvas handoff opens the exact saved workflow and selected node", () => {
  render(<WorkflowWorkspaceCanvas messages={[]} initialWorkflowContext={{ workflowId: "report", yaml: "name: Report\nsteps: []", selectedNodeId: "invoices" }} sessionId="chat" />);
  expect(screen.getByTestId("saved-workflow-editor")).toBeTruthy();
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", sessionId: "chat", initialSelectedNodeId: "invoices" }));
});

test("durable node-edit messages restore workflow and node context without YAML", () => {
  render(<WorkflowWorkspaceCanvas messages={[{ id: "request", artifacts: { intent: "NODE_EDIT_REQUEST", workflowId: "report", nodeId: "invoices" } }]} sessionId="chat" />);
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", initialSelectedNodeId: "invoices" }));
});
