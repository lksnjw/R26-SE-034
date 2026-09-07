/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, beforeEach, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { within } from "@testing-library/react";
import { iterationFixture } from "../../utils/iterationEvidence.fixture";

const yaml = "name: Report\ntrigger:\n  type: manual\nsteps:\n - id: first\n   action: demo.echo\n   parameters:\n     value: original\n - id: last\n   action: demo.echo\n   parameters:\n     value: tail\n";
const record = { workflowId: "report", version: 1, contentHash: `sha256:${"a".repeat(64)}`, yaml, validation: { passed: true, errors: [] }, published: false, bridge: "not_connected", can_attempt_run: false };
const proposal = { id: "proposal-one", workflowId: "report", nodeId: "first", baseVersion: 1, baseHash: record.contentHash, status: "PROPOSED", before: { id: "first", action: "demo.echo", parameters: { value: "original" } }, after: { id: "first", action: "demo.echo", parameters: { value: "proposed" } }, command: { type: "updateNode", nodeId: "first", patch: { parameters: { value: "proposed" } } } };
let messages = [];
const send = jest.fn();
jest.unstable_mockModule("../../hooks/useChat", () => ({ useChat: () => ({ messages, send, loading: false }) }));
const { default: WorkflowWorkspaceEditor } = await import("./WorkflowWorkspaceEditor");
beforeEach(() => {
  messages = []; send.mockReset(); send.mockResolvedValue({ operation: { id: "saved" } });
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

test("reopened workspace undo/redo uses saved server targets instead of remembered client YAML", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, editHistory: { profile: "draft-edit-history/v1", undoTarget: "base-snapshot", redoTarget: "saved-edit" } });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Undo workflow edit" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "undoDraft", versionId: "base-snapshot" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Redo workflow edit" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Redo workflow edit" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenLastCalledWith("report", expect.objectContaining({ version: 1 }), { type: "redoDraft", versionId: "saved-edit" }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("unknown history never enables local undo and read-only users cannot activate undo/redo", async () => {
  const view = await open(); expect(screen.getByRole("button", { name: "Undo workflow edit" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Redo workflow edit" }).disabled).toBe(true);
  view.unmount(); await open({ canEdit: false });
  expect(screen.queryByRole("button", { name: "Undo workflow edit" })).toBeNull(); expect(screen.queryByRole("button", { name: "Redo workflow edit" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit history" })).toBeTruthy();
});

test("selected structural scope stays pending rather than becoming unscoped while a saved edit's readiness refresh is held", async () => {
  const saved = collectionRecord(); let release; const onNodeContext = jest.fn();
  workflowService.readiness.mockResolvedValueOnce(saved).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  workflowService.command.mockResolvedValue({ ...saved, version: 2, editHistory: { undoTarget: "base", redoTarget: null } });
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit onNodeContext={onNodeContext} />); fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum collection items" }), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview collection edit" })); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "each", version: 2, pending: true })));
  expect(screen.getByRole("button", { name: "Undo workflow edit" }).disabled).toBe(true);
  release({ ...saved, version: 2 }); await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "each", version: 2, pending: false })));
});

function collectionRecord() {
  const s = iterationFixture();
  return { ...record, yaml: s.yaml, contentHash: s.sourceHash, authoring: { profile: "read-authoring/v1", controlFlow: s.flow, collections: [{ nodeId: "each", itemSources: [], collectSources: [] }] } };
}

test("selecting a collection owner forwards its exact saved scope to main chat and exposes a mobile focus action", async () => {
  const saved = collectionRecord(), onNodeContext = jest.fn(), onFocusChat = jest.fn(); workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit onNodeContext={onNodeContext} onFocusChat={onFocusChat} />);
  fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "each", label: "Collection each", workflowId: "report", sessionId: "chat", version: 1, contentHash: saved.contentHash })));
  expect(screen.getByText(/This collection is selected in the main chat/)).toBeTruthy(); expect(screen.queryByRole("textbox", { name: "Selected node prompt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit this collection in chat" })); expect(onFocusChat).toHaveBeenCalledTimes(1);
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("standalone collection owner prompt uses the saved async chat node contract without edits or legacy calls", async () => {
  const saved = collectionRecord(); workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Limit this collection to two items" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Limit this collection to two items", undefined, { nodeContext: { workflowId: "report", nodeId: "each", baseVersion: 1, baseHash: saved.contentHash } }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.proposeNode).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("saved collection-owner proposal has a readable preview and applies only its exact partial draft command", async () => {
  const saved = collectionRecord(), change = { ...proposal, nodeId: "each", baseHash: saved.contentHash, before: { maxItems: 3 }, after: { maxItems: 2 }, command: { type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } } };
  workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit savedProposals={[change]} />);
  const preview = await screen.findByRole("region", { name: "Node change preview" });
  expect(preview.querySelector("pre")).toBeNull(); expect(within(preview).getByText("2")).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(within(preview).getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", { version: 1, contentHash: saved.contentHash, proposalId: change.id }, change.command));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("read-only collection selection cannot activate chat edit scope or collection mutation controls", async () => {
  workflowService.readiness.mockResolvedValue(collectionRecord()); const onNodeContext = jest.fn();
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" onNodeContext={onNodeContext} />);
  fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  expect(screen.getByRole("complementary", { name: "Selected collection details" })).toBeTruthy(); expect(onNodeContext).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole("textbox", { name: "Selected node prompt" })).toBeNull(); expect(screen.queryByRole("button", { name: "Preview collection edit" })).toBeNull(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("a collection proposal exposes compiler errors before applying a blocked draft", async () => {
  const saved = collectionRecord(), change = { ...proposal, nodeId: "each", baseHash: saved.contentHash, before: { maxItems: 3 }, after: { maxItems: 2 }, command: { type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } }, validation: { passed: false, errors: ["Collection result each has an unavailable reference"] } };
  workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit savedProposals={[change]} />);
  const preview = await screen.findByRole("region", { name: "Node change preview" });
  expect(within(preview).getByText(/may only be saved as a blocked draft/)).toBeTruthy(); expect(within(preview).getByText("Proposal issues (1)")).toBeTruthy();
  expect(within(preview).getByText("Collection result each has an unavailable reference")).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("matching collection run answers appear separately beside their node and do not change chat edit scope", async () => {
  const s = iterationFixture(), context = jest.fn();
  workflowService.readiness.mockResolvedValue({ ...record, yaml: s.yaml, contentHash: s.sourceHash, authoring: { profile: "read-authoring/v1", controlFlow: s.flow } });
  executionService.list.mockResolvedValue([s.execution]); executionService.get.mockResolvedValue(s.execution); executionService.getTimeline.mockResolvedValue(s.timeline);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [], cursor: 0, lastSequence: 0, hasMore: false, status: "DONE", profile: "read-progress-v1" });
  const view = render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit onNodeContext={context} />);
  const panel = await screen.findByRole("region", { name: "Saved item evidence for lookup" });
  expect(within(panel).getByText("each · item 1 · Read")).toBeTruthy(); expect(within(panel).getByText("each · item 2 · Read")).toBeTruthy();
  fireEvent.click(within(panel).getAllByRole("button", { name: "Saved item answer" })[1]); expect(within(panel).getByText("Answer 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /01 lookup/ })); await waitFor(() => expect(context).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "lookup", version: 1, contentHash: s.sourceHash })));
  expect(view.container.querySelector("section[aria-label='Saved item evidence for lookup'] pre")).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("a collection answer from another source snapshot cannot appear in the current canvas", async () => {
  const s = iterationFixture(); workflowService.readiness.mockResolvedValue({ ...record, yaml: s.yaml + " ", contentHash: s.sourceHash, authoring: { profile: "read-authoring/v1", controlFlow: s.flow } });
  executionService.list.mockResolvedValue([s.execution]); executionService.getTimeline.mockResolvedValue(s.timeline); executionService.get.mockResolvedValue(s.execution);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [], cursor: 0, lastSequence: 0, hasMore: false, status: "DONE", profile: "read-progress-v1" });
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" />); await screen.findByText(/Saved item evidence does not match/);
  expect(screen.queryByRole("button", { name: "Saved item answer" })).toBeNull(); expect(screen.queryByText("Answer 1")).toBeNull(); expect(screen.queryByText("Answer 2")).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("canvas collection wrapping remains preview-only until an explicit revision-bound apply", async () => {
  await open(); await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Wrap node in collection" }));
  fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "each" } }); fireEvent.submit(screen.getByRole("form", { name: "Wrap node in collection" }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), expect.objectContaining({ type: "wrapCollection", nodeId: "first", loopId: "each", maxItems: 25 })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

test("an unacknowledged canvas prompt is retained on remount and is not applied", async () => {
  send.mockResolvedValue(null); const view = await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Keep my pending edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalled()); view.unmount();
  await open(); expect(screen.getByRole("textbox", { name: "Selected node prompt" }).value).toBe("Keep my pending edit");
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.proposeNode).not.toHaveBeenCalled();
});

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
  const view = await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Change the value" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Change the value", undefined, { nodeContext: { workflowId: "report", nodeId: "first", baseVersion: 1, baseHash: record.contentHash } }));
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
  expect(workflowService.proposeNode).not.toHaveBeenCalled();
  messages = [{ artifacts: { proposal } }]; view.rerender(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit selectionStorageKey="account.chat" />);
  await screen.findByRole("region", { name: "Node change preview" });
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

test("operation-ready workspace uses separate admission and continues managing an exact approval wait", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1" });
  const admitted = { id: "operation-wait", status: "AWAITING_APPROVAL", readProgress: { profile: "read-progress-v1", lastSequence: 1 }, workflowSnapshot: { yaml, version: 1, executionProfile: "sequential-operation-v1" }, stepOutputs: {} };
  workflowService.run.mockResolvedValue(admitted); executionService.get.mockResolvedValue(admitted);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "AWAITING_APPROVAL", sideEffect: true }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: admitted.id, sequence: 1, timestamp: "2026-10-06T00:00:00Z", type: "approval.requested" }], cursor: 1, lastSequence: 1, hasMore: false, status: admitted.status, profile: "read-progress-v1" });
  await open({ canControl: true }); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText("Exact operation approval requested");
  expect(workflowService.run).toHaveBeenCalledWith("report", {}, expect.objectContaining({ mode: "async-operation", idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }));
  expect(screen.getByText(/this operation has not been dispatched/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Request cancellation" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(workflowService.run).toHaveBeenCalledTimes(1);
});

test("an uncertain operation node explains possible ERP effects and cannot start another run", async () => {
  const interrupted = { id: "operation-unknown", workflowId: "report", status: "RECONCILIATION_REQUIRED", startedAt: "2026-10-06T00:00:00Z", workflowSnapshot: { yaml, version: 1, executionProfile: "sequential-operation-v1" }, readProgress: { profile: "read-progress-v1", lastSequence: 1 }, stepOutputs: {} };
  executionService.list.mockResolvedValue([interrupted]); executionService.get.mockResolvedValue(interrupted);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "UNKNOWN", sideEffect: true }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: interrupted.id, sequence: 1, timestamp: interrupted.startedAt, type: "node.outcome_unknown", nodeId: "first" }], cursor: 1, lastSequence: 1, hasMore: false, status: interrupted.status, profile: "read-progress-v1" });
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1" });
  await open({ canControl: true }); await screen.findByText(/operation may have taken effect in ERP/);
  expect(screen.queryByText(/the read may have reached ERP/)).toBeNull();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true); expect(workflowService.run).not.toHaveBeenCalled();
});

test("operator-closed canvas retains external evidence beside the unknown node without fabricating a tool answer or rerun", async () => {
  const closed = { id: "operation-closed", workflowId: "report", status: "RECONCILED", hasOperationReconciliation: true, startedAt: "2026-10-06T00:00:00Z", workflowSnapshot: { yaml, version: 1, executionProfile: "sequential-operation-v1" }, readProgress: { profile: "read-progress-v1", lastSequence: 1 }, stepOutputs: {} };
  executionService.list.mockResolvedValue([closed]); executionService.get.mockResolvedValue(closed);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "UNKNOWN", sideEffect: true, reconciliation: { id: "evidence", outcome: "APPLIED", basis: "operator-attestation", actorId: "operator", recordedAt: closed.startedAt, evidence: { reference: "ERP-123", note: "Inspected external record", kind: "erp-record", observedAt: closed.startedAt } } }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: closed.id, sequence: 1, timestamp: closed.startedAt, type: "operation.reconciliation_recorded", nodeId: "first", payload: { outcome: "APPLIED" } }], cursor: 1, lastSequence: 1, hasMore: false, status: closed.status, profile: "read-progress-v1" });
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1" });
  await open({ canControl: true }); await screen.findByText("Effect observed · operator attestation");
  // The optional collapsed YAML source is not the business-evidence display.
  expect(screen.getByText("ERP-123")).toBeTruthy(); expect(screen.getByText(/Not a saved tool answer/)).toBeTruthy(); expect(screen.getByLabelText("Operator evidence").querySelector("pre")).toBeNull();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true); expect(screen.queryByText(/Node answer/)).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("schema guidance selects readable data and applies only the reviewed revision-bound draft", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [{ nodeId: "first", actions: ["demo.echo"], inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, dataSources: [{ expression: "{{input.report}}", label: "Workflow input · report", schema: { type: "string" } }] }] } });
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("combobox", { name: "Parameters · value input mode" }), { target: { value: "data" } });
  expect(screen.getByRole("combobox", { name: "Parameters · value data source" }).textContent).toContain("Workflow input · report · string");
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "updateNode", nodeId: "first", patch: { description: "", action: "demo.echo", parameters: { value: "{{input.report}}" } } }));
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
});

test("changing the tool never applies the former tool schema or erases old parameters", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [{ nodeId: "first", actions: ["demo.echo"], inputSchema: { type: "object", properties: { value: { type: "string" } } }, dataSources: [] }] } });
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Node tool" }), { target: { value: "unknown.tool" } });
  expect(screen.getByText(/No current supported schema guidance for this tool/)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Parameters · value" }).value).toBe("original");
  expect(workflowService.command).not.toHaveBeenCalled();
});

test("stale compiled publication can explicitly republish instead of leaving the workspace unable to repair it", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, compilation: { state: "BLOCKED" } });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Republish reviewed draft" }));
  await waitFor(() => expect(workflowService.publish).toHaveBeenCalledWith("report", "Explicitly reviewed in chat workspace", expect.objectContaining({ version: 1, contentHash: record.contentHash })));
  expect(workflowService.run).not.toHaveBeenCalled();
});

test("compiler and publication readiness reasons are visible and not hidden behind successful original validation", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, compilation: { state: "BLOCKED" }, issues: ["Published execution artifact needs current capability review and explicit re-publication"] });
  await open();
  expect(screen.getByText("Execution readiness issues (1)")).toBeTruthy();
  expect(screen.getByText(/Published execution artifact needs current capability review/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
});

test("workspace renders confirmed branch scopes, selectable action nodes and truthful skipped-node status", async () => {
  const flow = { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] } }] };
  workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [], controlFlow: flow } });
  executionService.list.mockResolvedValue([{ id: "branch-run", workflowId: "report", startedAt: "2026-10-05T00:00:00Z", status: "DONE", workflowSnapshot: { yaml }, readProgress: { decisions: { gate: { status: "DONE", selected: "then" } } }, stepOutputs: { first: { structuredContent: { value: "selected answer" } } } }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "gate", status: "DONE", outcome: "CONDITION_SELECTED" }, { nodeId: "first", status: "DONE" }, { nodeId: "last", status: "SKIPPED" }]);
  await open(); await screen.findByText("If yes · Selected");
  expect(screen.getByText(/another branch was selected.*no answer/)).toBeTruthy(); expect(screen.getByText("selected answer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /first demo.echo/ })); expect(screen.getByRole("textbox", { name: "Node label" })).toBeTruthy();
  expect(workflowService.run).not.toHaveBeenCalled();
});

const conditionFlow = { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] } }] };
function showConditions(extra = {}) { workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [], controlFlow: conditionFlow, conditions: [{ nodeId: "gate", dataSources: [] }] }, ...extra }); }

test("return selection scopes chat and previews a false output without saving or executing", async () => {
  const output = { schema: { type: "boolean" }, value: { kind: "literal", value: true } }, flow = JSON.parse(JSON.stringify(conditionFlow));
  flow.nodes.push({ kind: "return", id: "answer", output });
  showConditions({ authoring: { profile: "read-authoring/v1", controlFlow: flow, returns: [{ nodeId: "answer", dataSources: [] }] } });
  const onNodeContext = jest.fn(); await open({ onNodeContext }); fireEvent.click(screen.getByRole("button", { name: "Select return answer" }));
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "answer", version: 1, contentHash: record.contentHash })));
  fireEvent.change(screen.getByRole("combobox", { name: "Return value" }), { target: { value: "false" } }); fireEvent.click(screen.getByRole("button", { name: "Preview return edit" }));
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "updateReturn", nodeId: "answer", patch: { output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } } }));
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
});

test("branch merge and new return require explicit reviewed commands", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" })); fireEvent.click(screen.getByRole("checkbox", { name: "Declare branch output" }));
  fireEvent.change(screen.getByRole("textbox", { name: "If yes output" }), { target: { value: "yes value" } }); fireEvent.change(screen.getByRole("textbox", { name: "If no output" }), { target: { value: "no value" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview branch output edit" })); expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "setConditionMerge", nodeId: "gate", merge: { schema: { type: "string" }, then: { kind: "literal", value: "yes value" }, else: { kind: "literal", value: "no value" } } }));
});

test("a new return preserves its explicit destination in a readable preview", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Add return" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New return ID" }), { target: { value: "answer" } }); fireEvent.change(screen.getByRole("combobox", { name: "New return destination" }), { target: { value: "gate:then" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Return value" }), { target: { value: "Explicit output" } }); fireEvent.click(screen.getByRole("button", { name: "Preview new return" }));
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "addReturn", nodeId: "answer", beforeNodeId: null, destination: { conditionId: "gate", branch: "then" }, output: { schema: { type: "string" }, value: { kind: "literal", value: "Explicit output" } } }));
});

test("condition selection forwards stable revision-bound scope to main chat and manual edits stay previews", async () => {
  showConditions(); const onNodeContext = jest.fn(); await open({ onNodeContext });
  fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "gate", workflowId: "report", version: 1, contentHash: record.contentHash })));
  fireEvent.change(screen.getByRole("combobox", { name: "Condition value" }), { target: { value: "false" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview condition edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("condition prompts use the saved asynchronous node scope and do not call tools or the legacy proposal route", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Select yes only when enabled" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Select yes only when enabled", undefined, { nodeContext: { workflowId: "report", nodeId: "gate", baseVersion: 1, baseHash: record.contentHash } }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.proposeNode).not.toHaveBeenCalled();
});

test("adding an action into an explicit branch submits its destination instead of a detached flat declaration", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Add node" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New node ID" }), { target: { value: "more" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New node tool" }), { target: { value: "demo.echo" } });
  fireEvent.change(screen.getByRole("combobox", { name: "New node destination" }), { target: { value: "gate:else" } });
  fireEvent.click(screen.getByRole("button", { name: "Add draft node" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "addNode", node: { id: "more", action: "demo.echo", parameters: {} }, beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } }));
});
const recordExpect = () => expect.objectContaining({ version: 1, contentHash: record.contentHash });

test("moving an action selects a named branch scope and keeps the action ID", async () => {
  showConditions(); await open(); await selectNode();
  fireEvent.change(screen.getByRole("combobox", { name: "Move node destination" }), { target: { value: "gate:else" } });
  fireEvent.click(screen.getByRole("button", { name: "Move to selected scope end" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByText(/references and prerequisites may need repair/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "moveNode", nodeId: "first", beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } }));
});

test("direct canvas placement is preview-only, revision-bound and available by keyboard-friendly buttons", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" }));
  fireEvent.click(screen.getByRole("button", { name: "Move last" }));
  fireEvent.click(screen.getByRole("button", { name: "Place last · Main sequence · before first" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  const view = screen.getByRole("region", { name: "Node change preview" }); expect(view.querySelector("pre")).toBeNull();
  expect(within(view).getByText("Main sequence · before first")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "moveNode", nodeId: "last", beforeNodeId: "first" }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("whole-condition canvas moves preserve both paths in the preview and disable all own-descendant positions", async () => {
  const flow = JSON.parse(JSON.stringify(conditionFlow)); flow.nodes.push({ kind: "return", id: "answer", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  showConditions({ authoring: { profile: "read-authoring/v1", controlFlow: flow } }); await open();
  fireEvent.click(screen.getByRole("button", { name: "Arrange flow" })); fireEvent.click(screen.getByRole("button", { name: "Move Condition gate" }));
  expect(screen.getByRole("button", { name: "Place gate · Main sequence → gate · If yes · end" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Place gate · Main sequence · before Return answer" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Place gate · Main sequence · end" }));
  expect(screen.getAllByText("Included in move")).toHaveLength(3);
  expect(screen.getByRole("region", { name: "gate If yes" })).toBeTruthy(); expect(screen.getByRole("region", { name: "gate If no" })).toBeTruthy();
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "moveNode", nodeId: "gate", beforeNodeId: null }));
});

test.each(["action", "if", "return"])("insert %s at a visible branch-before-action point requires explicit preview/apply", async kind => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" }));
  fireEvent.click(screen.getByRole("button", { name: "Insert step · Main sequence → gate · If no · before last" }));
  const form = screen.getByRole("form", { name: "Insert canvas step" });
  fireEvent.change(within(form).getByRole("combobox", { name: "Canvas step type" }), { target: { value: kind } });
  fireEvent.change(within(form).getByRole("textbox", { name: "Canvas step ID" }), { target: { value: "inserted" } });
  if (kind === "action") fireEvent.change(within(form).getByRole("textbox", { name: "Canvas step tool" }), { target: { value: "demo.echo" } });
  fireEvent.submit(form); expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), expect.objectContaining({ type: kind === "action" ? "addNode" : kind === "if" ? "addCondition" : "addReturn", beforeNodeId: "last", destination: { conditionId: "gate", branch: "else" } })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("foreign/stale drag payload cannot create a proposal; matching revision drag remains preview-only", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" }));
  const data = new Map(), dataTransfer = { setData: (key, value) => data.set(key, value), getData: key => data.get(key) || "", effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(screen.getByRole("button", { name: "Move last" }), { dataTransfer });
  const target = screen.getByRole("listitem", { name: "Insertion point · Main sequence · before first" });
  const exact = data.get("application/x-workflow-node");
  for (const bad of ["{}", "not JSON", JSON.stringify({ ...JSON.parse(exact), workflowId: "other" }), JSON.stringify({ ...JSON.parse(exact), baseVersion: 0 }), "x".repeat(1025)]) {
    data.set("application/x-workflow-node", bad); fireEvent.drop(target, { dataTransfer }); expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
  }
  data.set("application/x-workflow-node", exact); fireEvent.drop(target, { dataTransfer });
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("read-only and unconfirmed structural views expose no canvas mutations or invented editable chain", async () => {
  const view = await open({ canEdit: false }); expect(screen.queryByRole("button", { name: "Arrange flow" })).toBeNull(); view.unmount();
  workflowService.readiness.mockResolvedValue({ ...record, yaml: yaml + "metadata:\n  controlFlow:\n    schemaVersion: unknown\n" });
  await open(); expect(screen.getByRole("button", { name: "Arrange flow" }).disabled).toBe(true);
  expect(screen.getByText(/not a confirmed execution layout/)).toBeTruthy(); expect(screen.queryByRole("button", { name: /^Insert step/ })).toBeNull();
});

test.each([undefined, { data: { meta: { code: "DRAFT_SAVE_UNCONFIRMED" }, message: "Unconfirmed" } }])("unconfirmed save %j fences further edits, retains preview and requires authoritative reload", async response => {
  workflowService.command.mockRejectedValueOnce({ response, message: "Lost response" }); await open(); await selectNode();
  fireEvent.click(screen.getByRole("button", { name: "Move to end" })); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByText(/Edit save outcome is unconfirmed/); expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Arrange flow" }).disabled).toBe(true); expect(workflowService.command).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload workflow" })); await waitFor(() => expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(false));
  expect(workflowService.command).toHaveBeenCalledTimes(1);
});

test("reloading a changed revision clears old placement context and retains a stale preview without enabling apply", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" })); fireEvent.click(screen.getByRole("button", { name: "Move last" }));
  fireEvent.click(screen.getByRole("button", { name: "Place last · Main sequence · before first" }));
  workflowService.readiness.mockResolvedValue({ ...record, version: 2, contentHash: `sha256:${"b".repeat(64)}` });
  fireEvent.click(screen.getByRole("button", { name: "Reload workflow" }));
  await screen.findByText(/This preview belongs to an older draft/);
  expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(true); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Move last" }).disabled).toBe(false));
  expect(screen.queryByRole("button", { name: /^Place last/ })).toBeNull();
});

test("wrapping an action requires a reviewed preview before saving its explicit branch meaning", async () => {
  await open(); await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Wrap node in condition" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New condition ID" }), { target: { value: "newGate" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Condition value" }), { target: { value: "true" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Wrapped node branch" }), { target: { value: "else" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview new condition" })); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "wrapNode", nodeId: "first", conditionId: "newGate", predicate: { kind: "literal", value: true }, branch: "else" }));
});

test("empty condition creation is previewed with readable scope rather than raw source", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New condition ID" }), { target: { value: "inner" } });
  fireEvent.change(screen.getByRole("combobox", { name: "New condition destination" }), { target: { value: "gate:then" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview new condition" }));
  expect(within(screen.getByRole("region", { name: "Node change preview" })).getByText(/gate · If yes.*empty paths/)).toBeTruthy();
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "addCondition", conditionId: "inner", predicate: { kind: "literal", value: false }, beforeNodeId: null, destination: { conditionId: "gate", branch: "then" } }));
});

test("nonempty conditions cannot be removed or silently flattened", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  expect(screen.getByRole("button", { name: "Remove empty condition…" }).disabled).toBe(true);
  expect(screen.getByText(/Nothing is silently flattened/)).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("read-only condition inspection exposes no predicate form or mutation controls", async () => {
  showConditions(); await open({ canEdit: false }); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  expect(screen.getByRole("complementary", { name: "Selected condition details" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Condition value" })).toBeNull(); expect(screen.queryByRole("button", { name: "Add condition" })).toBeNull();
});

test("stale condition apply retains the exact unapplied predicate proposal", async () => {
  showConditions(); workflowService.command.mockRejectedValue({ response: { data: { message: "Draft changed. Reload." } } });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Condition value" }), { target: { value: "false" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview condition edit" })); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByRole("alert"); expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  expect(workflowService.command).toHaveBeenCalledTimes(1); expect(workflowService.run).not.toHaveBeenCalled();
});
