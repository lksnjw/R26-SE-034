import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { workflowService } from "./workflow.service";
afterEach(() => jest.restoreAllMocks());
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
