/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { executionService } from "../../services/execution.service";

let permissions = new Set(["execution:approve"]);
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ default: () => ({ hasAny: required => required.some(key => permissions.has(key)) }) }));
const { default: ExecutionApprovalReviewPage } = await import("./ExecutionApprovalReviewPage");
const clients = [];
const view = { id: "run", workflowName: "Exact review", status: "AWAITING_APPROVAL", runtimeApproval: { profile: "runtime-approval/v1", id: "review", version: 1,
  reviewHash: `sha256:${"a".repeat(64)}`, state: "PENDING", arguments: { recipient: "manager@example.test" }, reason: "Review exact recipient", canDecide: true, canResume: false,
  resumeReason: "Approval does not send.", toolName: "Fixture report review", remoteToolName: "fixture.review", nodeId: "send", requesterId: "requester", connectionId: "erpbridge-default", invocationId: "attempt", capabilityRevision: "revision", expiresAt: "2026-10-06T15:00:00.000Z", approverRole: "Manager" } };
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  render(<QueryClientProvider client={client}><MemoryRouter><ExecutionApprovalReviewPage executionId="run" /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); permissions = new Set(["execution:approve"]); jest.restoreAllMocks(); });

test("review-only page requests the minimal projection, not full run or logs, and has an accessible return link", async () => {
  const review = jest.spyOn(executionService, "getApproval").mockResolvedValue(view);
  const full = jest.spyOn(executionService, "get"), logs = jest.spyOn(executionService, "getLogs");
  show(); await screen.findByRole("heading", { name: "Review transaction" });
  expect(review).toHaveBeenCalledWith("run"); expect(review).toHaveBeenCalledTimes(1);
  expect(full).not.toHaveBeenCalled(); expect(logs).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "← Review inbox" }).getAttribute("href")).toBe("/executions/reviews");
  expect(screen.queryByRole("link", { name: "← Workspace" })).toBeNull();
});
test("workspace users retain the chat return link without broadening review-only permissions", async () => {
  permissions.add("chat:use"); jest.spyOn(executionService, "getApproval").mockResolvedValue(view);
  show(); await screen.findByRole("heading", { name: "Review transaction" });
  expect(screen.getByRole("link", { name: "← Workspace" }).getAttribute("href")).toBe("/chat");
});
test("a fresh review revision resets the old affirmative selection and note", async () => {
  const review = jest.spyOn(executionService, "getApproval").mockResolvedValueOnce(view).mockResolvedValue({ ...view, runtimeApproval: { ...view.runtimeApproval, version: 2, reviewHash: `sha256:${"b".repeat(64)}`, arguments: { recipient: "new-manager@example.test" } } });
  show(); await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision note" }), { target: { value: "Old context" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload exact review" })); await screen.findByText("new-manager@example.test");
  expect(review).toHaveBeenCalledTimes(2); expect(screen.getByRole("checkbox").checked).toBe(false);
  expect(screen.getByRole("textbox", { name: "Decision note" }).value).toBe("");
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
});
test("unavailable review has no automatic retry and a failed explicit retry remains an error", async () => {
  const review = jest.spyOn(executionService, "getApproval").mockRejectedValue(new Error("Review unavailable"));
  show(); await screen.findByText("Could not load this data"); expect(review).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(review).toHaveBeenCalledTimes(2));
  await screen.findByText("Could not load this data");
  expect(screen.queryByRole("button", { name: "Record approval" })).toBeNull();
});
