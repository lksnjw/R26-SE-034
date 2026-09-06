import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { workflowService } from "./workflow.service";
afterEach(() => jest.restoreAllMocks());
test("history summaries and explicit snapshots carry current revision and exact saved target", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { data: {} } }), revision = { version: 4, contentHash: "current" };
  await workflowService.editHistory("flow", revision, "older");
  expect(get).toHaveBeenLastCalledWith("/workflows/flow/versions", { params: { view: "edit-history", baseVersion: 4, baseHash: "current", beforeId: "older" } });
  await workflowService.editHistoryVersion("flow", revision, { id: "saved", contentHash: "saved-hash" });
  expect(get).toHaveBeenLastCalledWith("/workflows/flow/versions", { params: { view: "edit-history", baseVersion: 4, baseHash: "current", versionId: "saved", contentHash: "saved-hash" } });
});
test("iteration fixtures use the explicit v2 profile with unchanged revision and dry-run fences", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: {} } }); const outputs = { "each/0/read": { content: [] } };
  await workflowService.simulate("flow", { version: 2, contentHash: "hash" }, { rows: [] }, outputs, "read-fixtures/v2");
  expect(post).toHaveBeenCalledWith("/workflows/flow/run", { dryRun: true, input: { rows: [] }, simulation: { profile: "read-fixtures/v2", baseVersion: 2, baseHash: "hash", outputs } }, { timeout: 30000 });
});
test("an unknown fixture profile is rejected before any request", async () => {
  const post = jest.spyOn(apiClient, "post"); await expect(workflowService.simulate("flow", {}, {}, {}, "live")).rejects.toThrow(); expect(post).not.toHaveBeenCalled();
});
test("fixture simulation uses a revision-bound dry request with no live run options", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: { outcome: "SIMULATED_COMPLETE" } } });
  const outputs = { first: { content: [], structuredContent: { id: "test" } } };
  await workflowService.simulate("flow", { version: 3, contentHash: "sha256:source" }, { enabled: true }, outputs);
  expect(post).toHaveBeenCalledWith("/workflows/flow/run", { dryRun: true, input: { enabled: true }, simulation: { profile: "read-fixtures/v1", baseVersion: 3, baseHash: "sha256:source", outputs } }, { timeout: 30000 });
});
test("fixture request failure is not retried or converted into real execution", async () => {
  const post = jest.spyOn(apiClient, "post").mockRejectedValue(new Error("timeout"));
  await expect(workflowService.simulate("flow", { version: 1, contentHash: "hash" }, {}, {})).rejects.toThrow("timeout"); expect(post).toHaveBeenCalledTimes(1);
});
