/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, beforeEach, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import WorkflowWorkspaceEditor from "./WorkflowWorkspaceEditor";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";

const yaml = "name: Report\ntrigger:\n  type: manual\nsteps:\n - id: first\n   action: demo.echo\n   parameters:\n     value: original\n - id: last\n   action: demo.echo\n   parameters:\n     value: tail\n";
const record = { workflowId: "report", version: 1, contentHash: `sha256:${"a".repeat(64)}`, yaml, validation: { passed: true, errors: [] }, published: false, bridge: "not_connected", can_attempt_run: false };
const proposal = { id: "proposal-one", workflowId: "report", nodeId: "first", baseVersion: 1, baseHash: record.contentHash, status: "PROPOSED", before: { id: "first", action: "demo.echo", parameters: { value: "original" } }, after: { id: "first", action: "demo.echo", parameters: { value: "proposed" } }, command: { type: "updateNode", nodeId: "first", patch: { parameters: { value: "proposed" } } } };
beforeEach(() => {
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(workflowService, "command").mockResolvedValue({ ...record, version: 2 });
  jest.spyOn(workflowService, "proposeNode").mockResolvedValue(proposal);
  jest.spyOn(workflowService, "publish").mockResolvedValue({});
  jest.spyOn(workflowService, "run").mockResolvedValue({ id: "run-one", status: "DONE", stepOutputs: {} });
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(executionService, "getTimeline").mockResolvedValue([]);
  jest.spyOn(executionService, "get").mockResolvedValue({ id: "run-failed", status: "FAILED", workflowSnapshot: { version: 1 }, stepOutputs: { first: { structuredContent: { value: "real answer" } } } });
});
afterEach(() => { cleanup(); sessionStorage.clear(); jest.restoreAllMocks(); });
async function open(props = {}) {
  const view = render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit selectionStorageKey="account.chat" {...props} />);
  await screen.findByRole("button", { name: /01 first/ });
  return view;
}
async function selectNode() { fireEvent.click(screen.getByRole("button", { name: /01 first/ })); }

test("manual editing is preview-only until an explicit revision-bound apply", async () => {
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Node label" }), { target: { value: "Read invoices" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).textContent).toContain("Read invoices");
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "updateNode", nodeId: "first", patch: { description: "Read invoices", action: "demo.echo", parameters: { value: "original" } } }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("node prompts persist a scoped proposal and stale apply preserves its preview", async () => {
  workflowService.command.mockRejectedValue({ response: { data: { message: "Draft changed. Reload." } } });
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Change the value" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await screen.findByRole("region", { name: "Node change preview" });
  expect(workflowService.proposeNode).toHaveBeenCalledWith("report", record, "first", "Change the value", "chat");
  expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  expect(workflowService.command).toHaveBeenCalledWith("report", { version: 1, contentHash: record.contentHash, proposalId: proposal.id }, proposal.command);
});

test("saved proposals restore after remount and a discarded proposal cannot reappear from stale chat cache", async () => {
  const view = await open({ savedProposals: [proposal] });
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull());
  expect(workflowService.command).toHaveBeenCalledWith("report", record, { type: "discardProposal", proposalId: proposal.id });
  view.rerender(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit savedProposals={[proposal]} />);
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
});

test("read-only users see source and run status, never editing or proposal actions", async () => {
  await open({ canEdit: false, savedProposals: [proposal] }); await selectNode();
  expect(screen.queryByRole("textbox", { name: "Node label" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply to draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Publish reviewed draft" })).toBeNull();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
});

test("publication is explicit and does not call execution", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Publish reviewed draft" }));
  await waitFor(() => expect(workflowService.publish).toHaveBeenCalledWith("report", "Explicitly reviewed in chat workspace"));
  expect(workflowService.run).not.toHaveBeenCalled();
});

test("a failed run retrieves actual partial node outputs and does not silently publish", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, bridge: "discovery_available" });
  workflowService.run.mockRejectedValue({ response: { data: { message: "Second node failed", meta: { executionId: "run-failed" } } } });
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "DONE" }, { nodeId: "last", status: "FAILED" }]);
  await open(); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText("Node answer · run run-failed");
  expect(screen.getByText(/real answer/)).toBeTruthy();
  expect(executionService.get).toHaveBeenCalledWith("run-failed");
  expect(workflowService.publish).not.toHaveBeenCalled();
});

test("a save acknowledgement survives a readiness refresh failure and blocks further publication", async () => {
  workflowService.readiness.mockResolvedValueOnce(record).mockRejectedValue(new Error("Offline"));
  await open(); await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByText("Draft saved, but readiness could not be refreshed. Reload before publishing or running.");
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
  expect(screen.getByRole("button", { name: "Publish reviewed draft" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
});
