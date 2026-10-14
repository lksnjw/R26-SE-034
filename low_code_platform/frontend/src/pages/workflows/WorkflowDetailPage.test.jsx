/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

let permissions = ["workflow:write", "chat:use"];
const navigateTo = jest.fn(), refetch = jest.fn();
const workflow = { id: "saved-flow", name: "Saved report", description: "Existing reviewed source", owner: "Owner", status: "published", steps: 2,
  yaml: "must not be copied into an authoring handoff", draftVersion: 4 };
jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
jest.unstable_mockModule("../../context/RouteContext", () => ({ useRoute: () => ({ selectedWorkflowId: workflow.id, navigateTo }) }));
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ default: () => ({ has: permission => permissions.includes(permission), actorId: "owner" }) }));
jest.unstable_mockModule("../../hooks/useWorkflows", () => ({ useWorkflow: () => ({ data: workflow, refetch }) }));
jest.unstable_mockModule("../../hooks/useWorkflowDetailRun", () => ({ useWorkflowDetailRun: () => ({ state: {}, recovery: {}, run: jest.fn() }) }));
for (const path of ["../../components/workflows/WorkflowActions", "../../components/workflows/WorkflowAssignments", "../../components/canvas/WorkflowBuilderCanvas",
  "../../components/workflows/PendingGenerationApprovalCard", "../../components/workflows/WorkflowSchedulePanel", "../../components/workflows/WorkflowRunReceipt",
  "../../components/executions/RunAdmissionRecoveryPanel"]) jest.unstable_mockModule(path, () => ({ default: () => null }));
const { default: WorkflowDetailPage } = await import("./WorkflowDetailPage");
const { peekWorkflowForChatEdit } = await import("../../utils/workflowCanvas.utils");
function Location() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}</output>; }
function open() { return render(<MemoryRouter initialEntries={["/workflows/saved-flow"]}><WorkflowDetailPage /><Location /></MemoryRouter>); }
afterEach(() => { cleanup(); localStorage.clear(); permissions = ["workflow:write", "chat:use"]; navigateTo.mockClear(); refetch.mockClear(); });

test("saved workflow opens the chat editor by identity, never a stale source copy or execution", () => {
  open(); fireEvent.click(screen.getByRole("button", { name: "Edit in chat" }));
  expect(screen.getByLabelText("Current route").textContent).toMatch(/^\/chat\?new=1&creation=[a-f0-9-]{36}&workflow=saved-flow$/);
  expect(peekWorkflowForChatEdit()).toEqual({ workflowId: "saved-flow", workflowName: "Saved report" });
  expect(navigateTo).not.toHaveBeenCalled(); expect(refetch).not.toHaveBeenCalled();
});
test.each([["workflow:write"], ["chat:use"], []])("chat authoring entry requires both permissions: %j", (...values) => {
  permissions = values; open(); expect(screen.queryByRole("button", { name: "Edit in chat" })).toBeNull();
  expect(peekWorkflowForChatEdit()).toBeNull();
});
test("the builder action is labelled as a preview and preserves its existing destination", () => {
  open(); fireEvent.click(screen.getByRole("button", { name: "Preview canvas" }));
  expect(navigateTo).toHaveBeenCalledWith("workflows", "builder"); expect(peekWorkflowForChatEdit()).toBeNull();
});
