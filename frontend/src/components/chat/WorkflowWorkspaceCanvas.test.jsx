/** @jest-environment jsdom */
import React from "react";
import { expect, test, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkflowWorkspaceCanvas from "./WorkflowWorkspaceCanvas";
afterEach(() => { cleanup(); sessionStorage.clear(); });

test("canvas is present before generation", () => {
  render(<WorkflowWorkspaceCanvas messages={[]} />);
  expect(screen.getByRole("region", { name: "Workflow canvas" })).toBeTruthy();
  expect(screen.getByText("Your workflow starts here")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
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
