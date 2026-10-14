/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import WorkflowEditHistory from "./WorkflowEditHistory";
import { workflowService } from "../../services/workflow.service";

const record = { version: 4, contentHash: "current" };
const entry = { id: "old", version: 2, artifactState: "DRAFT", contentHash: "saved", name: "Old report", nodeCount: 1, change: { type: "updateCollection", nodeId: "each" }, createdBy: { name: "Owner" } };
const page = { entries: [entry], total: 2, undoDepth: 1, redoDepth: 1, undoLimit: 100, nextBeforeId: null };
const source = { ...entry, yaml: "name: Old report\ntrigger:\n  type: manual\nsteps:\n - id: read\n   action: demo.echo\n   parameters:\n     value: false\nmetadata:\n  note: All paths are preserved\n" };
beforeEach(() => { jest.spyOn(workflowService, "editHistory").mockResolvedValue(page); jest.spyOn(workflowService, "editHistoryVersion").mockResolvedValue(source); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test("history preview is readable, preserves settings and restores only after an explicit revision-pinned action", async () => {
  const onRestore = jest.fn(); render(<WorkflowEditHistory workflowId="report" record={record} canEdit onRestore={onRestore} />);
  await screen.findByText(/Collection edited/); expect(onRestore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect saved revision old" }));
  const preview = await screen.findByRole("region", { name: "Saved revision preview" });
  expect(within(preview).getByText(/full draft/)).toBeTruthy(); expect(within(preview).getByText(/Workflow settings and paths/)).toBeTruthy();
  expect(within(preview).getByText("No")).toBeTruthy(); expect(preview.querySelector("pre")).toBeNull();
  expect(onRestore).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Restore as new draft" }));
  expect(onRestore).toHaveBeenCalledWith({ type: "restoreVersion", versionId: "old", contentHash: "saved" });
  expect(workflowService.editHistoryVersion).toHaveBeenCalledWith("report", record, entry);
});

test("read-only users can inspect history but have no restore control", async () => {
  render(<WorkflowEditHistory workflowId="report" record={record} />); await screen.findByText(/Collection edited/);
  fireEvent.click(screen.getByRole("button", { name: "Inspect saved revision old" })); await screen.findByRole("region", { name: "Saved revision preview" });
  expect(screen.queryByRole("button", { name: "Restore as new draft" })).toBeNull();
});

test("history pagination preserves old entries and uses the returned cursor", async () => {
  workflowService.editHistory.mockResolvedValueOnce({ ...page, nextBeforeId: "old" }).mockResolvedValueOnce({ ...page, entries: [{ ...entry, id: "older", version: 1 }], nextBeforeId: null });
  render(<WorkflowEditHistory workflowId="report" record={record} />); fireEvent.click(await screen.findByRole("button", { name: "Load older revisions" }));
  await screen.findByRole("button", { name: "Inspect saved revision older" });
  expect(screen.getByRole("button", { name: "Inspect saved revision old" })).toBeTruthy();
  expect(workflowService.editHistory).toHaveBeenLastCalledWith("report", record, "old");
});

test("stale history errors do not fabricate snapshots or dispatch a restore", async () => {
  workflowService.editHistory.mockRejectedValue(new Error("Draft changed")); const onRestore = jest.fn();
  render(<WorkflowEditHistory workflowId="report" record={record} canEdit onRestore={onRestore} />);
  await screen.findByRole("alert"); expect(screen.getByText(/Draft changed/)).toBeTruthy(); expect(onRestore).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Inspect saved revision/ })).toBeNull();
});

test("a late snapshot from the previous workflow cannot become the new workflow's restore target", async () => {
  let release; workflowService.editHistoryVersion.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const view = render(<WorkflowEditHistory key="old" workflowId="report" record={record} canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect saved revision old" })); await waitFor(() => expect(workflowService.editHistoryVersion).toHaveBeenCalled());
  view.rerender(<WorkflowEditHistory key="new" workflowId="other" record={{ version: 1, contentHash: "new" }} canEdit />);
  release(source); await screen.findByRole("button", { name: "Inspect saved revision old" });
  expect(screen.queryByRole("region", { name: "Saved revision preview" })).toBeNull();
});
