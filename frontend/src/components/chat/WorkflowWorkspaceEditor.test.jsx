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
  await screen.findByRole("button", { name: /first/ });
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
  await waitFor(() => expect(workflowService.publish).toHaveBeenCalledWith("report", "Explicitly reviewed in chat workspace", record));
  expect(workflowService.run).not.toHaveBeenCalled();
});

test("a failed run retrieves actual partial node outputs and does not silently publish", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, bridge: "discovery_available" });
  workflowService.run.mockRejectedValue({ response: { data: { message: "Second node failed", meta: { executionId: "run-failed" } } } });
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "DONE" }, { nodeId: "last", status: "FAILED" }]);
  await open(); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText("Node answer · run run-failed");
  expect(screen.getByText(/real answer/)).toBeTruthy();
  expect(screen.getByText("Value")).toBeTruthy();
  expect(screen.getByText("Node answer · run run-failed").parentElement.querySelector("pre")).toBeNull();
  expect(executionService.get).toHaveBeenCalledWith("run-failed");
  expect(workflowService.publish).not.toHaveBeenCalled();
});

test("known failed-node response is readable beside the node and is not called a successful answer", async () => {
  executionService.list.mockResolvedValue([{ id: "run-failure", workflowId: "report", startedAt: "2026-10-05T00:00:00Z", status: "FAILED", workflowSnapshot: { yaml }, stepOutputs: {} }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "FAILED", output: { content: [{ type: "text", text: "Rate limit reached" }], isError: true, _meta: { "com.erpbridge/error": { type: "rate_limit", retryable: true } } } }]);
  await open(); await screen.findByText("Node failure response · run run-failure");
  expect(screen.getByText("The tool reported an error.")).toBeTruthy(); expect(screen.getByText("Rate limit reached")).toBeTruthy();
  expect(screen.queryByText("Node answer · run run-failure")).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
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

test("friendly parameter fields produce the same revision-bound command without a JSON editor", async () => {
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Parameters · value" }), { target: { value: "manager report" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), expect.objectContaining({ patch: { description: "", action: "demo.echo", parameters: { value: "manager report" } } })));
});

test("friendly run input fields submit typed values only through explicit Run", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, bridge: "discovery_available" });
  await open();
  fireEvent.change(screen.getByRole("textbox", { name: "Run inputs new field name" }), { target: { value: "limit" } });
  fireEvent.click(screen.getByRole("button", { name: "Add field" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Run inputs · limit value type" }), { target: { value: "number" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Run inputs · limit" }), { target: { value: "5" } });
  expect(workflowService.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await waitFor(() => expect(workflowService.run).toHaveBeenCalledWith("report", { limit: 5 }));
  expect(workflowService.publish).not.toHaveBeenCalled();
});

test("a synchronous run request does not lock draft/node editing or send a second run", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true });
  let finish;
  workflowService.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await open(); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText(/synchronous endpoint has not returned its run identifier/);
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  await selectNode();
  expect(screen.getByRole("button", { name: "Preview manual edit" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  expect(workflowService.run).toHaveBeenCalledTimes(1);
  finish({ id: "run-one", status: "DONE", stepOutputs: {} });
  await waitFor(() => expect(screen.queryByText(/synchronous endpoint has not returned/)).toBeNull());
});

test("an unconfirmed run response blocks repeat dispatch and directs the user to history", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true });
  workflowService.run.mockRejectedValue(new Error("Network Error"));
  await open(); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByRole("link", { name: /Review execution history/ });
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(workflowService.run).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/No automatic retry was sent/)).toBeTruthy();
});

test("recovered runs show readable saved answers and unknown nodes, never a fresh run action", async () => {
  const interrupted = { id: "run-recovery", workflowId: "report", status: "RECOVERY_REQUIRED", startedAt: "2026-10-05T00:00:00Z", workflowSnapshot: { yaml, version: 1 }, readProgress: { profile: "read-progress-v1", lastSequence: 1 }, stepOutputs: { first: { structuredContent: { value: "retained answer" } } } };
  executionService.list.mockResolvedValue([interrupted]); executionService.get.mockResolvedValue(interrupted);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "DONE" }, { nodeId: "last", status: "UNKNOWN" }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: interrupted.id, sequence: 1, timestamp: interrupted.startedAt, type: "node.outcome_unknown", nodeId: "last" }], cursor: 1, lastSequence: 1, hasMore: false, status: interrupted.status, profile: "read-progress-v1" });
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true });
  await open({ canControl: true });
  await screen.findByText(/Outcome unknown · the read may have reached ERP/);
  expect(screen.getByText("retained answer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Request cancellation" })).toBeNull();
});

test("async-ready workspace admits once, receives the run ID and starts monitoring saved queued state", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, read_job_admission: "read-job-v1" });
  const admitted = { id: "run-queued", status: "PENDING", readProgress: { profile: "read-progress-v1", lastSequence: 1 }, workflowSnapshot: { yaml, version: 1 }, stepOutputs: {} };
  workflowService.run.mockResolvedValue(admitted); executionService.get.mockResolvedValue(admitted);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: admitted.id, sequence: 1, timestamp: "2026-10-05T00:00:00Z", type: "run.queued" }], cursor: 1, lastSequence: 1, hasMore: false, status: "PENDING", profile: "read-progress-v1" });
  await open({ canControl: true }); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText("Read job queued");
  expect(workflowService.run).toHaveBeenCalledWith("report", {}, expect.objectContaining({ mode: "async-read", idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }));
  expect(screen.getByRole("button", { name: "Request cancellation" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(workflowService.run).toHaveBeenCalledTimes(1);
});
