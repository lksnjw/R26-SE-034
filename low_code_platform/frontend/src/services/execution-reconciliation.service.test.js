import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { executionService } from "./execution.service";

const observation = { profile: "operation-readback-evaluation/v1", outcome: "NOT_APPLIED", observedAt: "2026-10-06T10:00:02.000Z", settled: true,
  evidenceMeaning: "operation-state", canResume: false, noReplay: true, deliveryVerified: false };
const queryRecord = { id: "resolution-one", outcome: "NOT_APPLIED", queryId: "query-one", observation, actorId: "operator", recordedAt: "2026-10-06T10:01:00.000Z", basis: "queried-operation-state" };
const value = (overrides = {}) => ({ id: "run-one", workflowName: "Daily report", status: "RECONCILIATION_REQUIRED", operationReconciliation: {
  profile: "operation-reconciliation/v1", intentId: "intent-one", nodeId: "send", invocationId: "run-one:send", operationKey: "run-one:send", preparedAt: "2026-10-06T09:59:00.000Z",
  requesterId: "owner", toolName: "Send", remoteToolName: "mail.send__1.0.0", arguments: { recipient: "manager@example.test" }, version: 1,
  factsHash: `sha256:${"a".repeat(64)}`, state: "OPEN", history: [], canRecord: true, basis: "operator-attestation", canResume: false, noReplay: true, explanation: "Independent review only.", ...overrides } });
afterEach(() => jest.restoreAllMocks());

test("minimum reconciliation service accepts an exact query-backed history and rejects invented or contradictory records", async () => {
  const valid = value({ version: 2, state: "RESOLVED", canRecord: false, history: [queryRecord] });
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: valid } });
  expect(await executionService.getReconciliation("run-one")).toEqual(valid);
  expect(get).toHaveBeenCalledWith("/executions/run-one", { params: { view: "reconciliation" } });
  for (const changed of [
    { ...queryRecord, outcome: "APPLIED" },
    { ...queryRecord, observation: { ...observation, settled: false } },
    { ...queryRecord, result: { delivered: true } },
    { ...queryRecord, basis: "tool-success" },
  ]) {
    get.mockResolvedValueOnce({ data: { success: true, data: value({ version: 2, state: "RESOLVED", canRecord: false, history: [changed] }) } });
    await expect(executionService.getReconciliation("run-one")).rejects.toThrow(/Exact uncertain-operation evidence/);
  }
});

test("case state, version and last decision must agree before the browser displays trusted reconciliation history", async () => {
  const get = jest.spyOn(apiClient, "get");
  for (const review of [
    { version: 1, state: "RESOLVED", canRecord: false, history: [queryRecord] },
    { version: 2, state: "OPEN", canRecord: true, history: [queryRecord] },
    { version: 2, state: "RESOLVED", canRecord: true, history: [queryRecord] },
  ]) {
    get.mockResolvedValueOnce({ data: { success: true, data: value(review) } });
    await expect(executionService.getReconciliation("run-one")).rejects.toThrow(/Exact uncertain-operation evidence/);
  }
});
