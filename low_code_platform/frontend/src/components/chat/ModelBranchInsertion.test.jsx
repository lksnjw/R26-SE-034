/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, beforeEach, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import WorkflowWorkspaceEditor from "./WorkflowWorkspaceEditor";

const action = nodeId => ({ kind: "action", nodeId });
const sequence = (...nodes) => ({ kind: "sequence", nodes });
const flow = sequence(action("first"), { kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: sequence(), else: sequence() }, action("last"));
const source = `name: Editable decision\ntrigger:\n  type: manual\nsteps:\n - id: first\n   action: demo.echo\n   parameters: { value: original }\n - id: last\n   action: demo.notify\n   parameters: { value: tail }\nmetadata:\n  controlFlow: ${JSON.stringify({ schemaVersion: "read-control-flow/v1", root: flow })}\n`;
const record = { workflowId: "report", version: 1, contentHash: `sha256:${"a".repeat(64)}`, yaml: source, validation: { passed: true, errors: [] },
  executionProfile: "sequential-operation-v1", published: false, bridge: "not_connected", can_attempt_run: false,
  authoring: { profile: "read-authoring/v1", executionProfile: "decision-operation-v1", modelNodesSupported: true, controlFlow: flow,
    nodes: [{ nodeId: "first", effectClass: "read", actions: ["demo.echo"], dataSources: [] }, { nodeId: "last", effectClass: "notification", actions: ["demo.notify"], dataSources: [] }] } };

beforeEach(() => {
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(workflowService, "command").mockResolvedValue({ ...record, version: 2 });
  jest.spyOn(workflowService, "publish").mockResolvedValue({});
  jest.spyOn(workflowService, "run").mockResolvedValue({});
  jest.spyOn(executionService, "list").mockResolvedValue([]);
});
afterEach(() => { cleanup(); sessionStorage.clear(); jest.restoreAllMocks(); });
async function open() {
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  await screen.findByRole("button", { name: "Add analysis" });
}
function fill(kind) {
  fireEvent.change(screen.getByRole("textbox", { name: `New ${kind} ID` }), { target: { value: "derive" } });
  fireEvent.change(screen.getByRole("textbox", { name: `New ${kind} instruction` }), { target: { value: "Derive only from acknowledged input" } });
  fireEvent.change(screen.getByRole("textbox", { name: `New ${kind} input` }), { target: { value: "{{first.structuredContent.value}}" } });
}
const cases = ["analysis", "agent"].flatMap(kind => ["then", "else"].map(branch => [kind, branch]));
test.each(cases)("toolbar inserts %s directly into empty %s with a readable draft-only preview", async (kind, branch) => {
  await open(); fireEvent.click(screen.getByRole("button", { name: kind === "analysis" ? "Add analysis" : "Add bounded agent" })); fill(kind);
  fireEvent.change(screen.getByRole("combobox", { name: `New ${kind} position` }), { target: { value: `gate:${branch}|$end` } });
  fireEvent.click(screen.getByRole("button", { name: `Preview ${kind} node` }));
  const preview = screen.getByRole("region", { name: "Node change preview" });
  expect(within(preview).getAllByText(`Main sequence → gate · ${branch === "then" ? "If yes" : "If no"} · end`).length).toBeGreaterThan(0);
  expect(preview.querySelector("pre")).toBeNull(); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }),
    expect.objectContaining({ type: kind === "analysis" ? "addAnalysis" : "addAgent", beforeNodeId: null, destination: { conditionId: "gate", branch }, node: expect.objectContaining({ id: "derive", kind }) })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test.each(cases)("canvas insertion passes its exact empty %s/%s location to the bounded editor", async (kind, branch) => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" }));
  fireEvent.click(screen.getByRole("button", { name: `Insert step · Main sequence → gate · ${branch === "then" ? "If yes" : "If no"} · end` }));
  const form = screen.getByRole("form", { name: "Insert canvas step" });
  expect(within(form).queryByRole("option", { name: "Workflow return" })).toBeNull();
  fireEvent.change(within(form).getByRole("combobox", { name: "Canvas step type" }), { target: { value: kind } });
  fireEvent.click(within(form).getByRole("button", { name: "Configure model step" })); fill(kind);
  expect(screen.getByRole("combobox", { name: `New ${kind} position` }).value).toBe(`gate:${branch}|$end`);
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: `Preview ${kind} node` }));
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1 }), expect.objectContaining({ destination: { conditionId: "gate", branch }, beforeNodeId: null })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test.each(["analysis", "agent"])("a refreshed draft cannot silently rebind unsaved %s insertion intent", async kind => {
  workflowService.readiness.mockResolvedValueOnce(record).mockResolvedValue({ ...record, version: 2, contentHash: `sha256:${"b".repeat(64)}` });
  await open(); fireEvent.click(screen.getByRole("button", { name: kind === "analysis" ? "Add analysis" : "Add bounded agent" })); fill(kind);
  fireEvent.change(screen.getByRole("combobox", { name: `New ${kind} position` }), { target: { value: "gate:then|$end" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload workflow" }));
  await screen.findByText(/draft changed since this model editor opened/);
  expect(screen.getByRole("textbox", { name: `New ${kind} instruction` }).value).toBe("Derive only from acknowledged input");
  expect(screen.getByRole("button", { name: `Preview ${kind} node` }).disabled).toBe(true);
  fireEvent.submit(screen.getByRole("form", { name: `Create ${kind} node` }));
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("unsupported model profile never offers a canvas model insertion", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, authoring: { ...record.authoring, executionProfile: "unsupported-operation-control-flow", modelNodesSupported: false } });
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Arrange flow" }));
  fireEvent.click(screen.getByRole("button", { name: "Insert step · Main sequence → gate · If yes · end" }));
  const form = screen.getByRole("form", { name: "Insert canvas step" });
  expect(within(form).queryByRole("option", { name: "Structured analysis" })).toBeNull();
  expect(within(form).queryByRole("option", { name: "Bounded runtime agent" })).toBeNull();
});
