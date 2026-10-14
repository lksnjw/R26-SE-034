import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { executionService } from "./execution.service";

afterEach(() => jest.restoreAllMocks());
const h = `sha256:${"a".repeat(64)}`;
const value = { id: "run/one", workflowName: "Daily invoices", status: "RECONCILIATION_REQUIRED", reportPageResolution: {
  profile: "report-page-resolution-case/v1", state: "OPEN", intentId: "intent", nodeId: "report", invocationId: "run:report:cursor:2",
  continuationProfile: "opaque-cursor/v1", pointer: 2, cursorHash: h, preparedAt: "2026-10-07T10:00:00.000Z", requesterId: "requester",
  toolName: "Invoice report", remoteToolName: "erp.invoice_report", arguments: { startAt: "2026-10-06T00:00:00.000Z", cursor: "[protected cursor]" },
  outputSchema: { type: "object", properties: { complete: { type: "boolean" } }, required: ["complete"], additionalProperties: false },
  confirmedPages: 1, confirmedItems: 50, version: 1, factsHash: h, canRecord: true, canResume: true, noReplay: true, history: [], explanation: "No replay." } };

test("report-page review loads the dedicated minimum view and accepts only a complete exact shape", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: value } });
  expect(await executionService.getReportPageResolution("run/one")).toEqual(value);
  expect(get).toHaveBeenCalledWith("/executions/run%2Fone/report-page-resolutions");
  get.mockResolvedValue({ data: { success: true, data: { ...value, reportPageResolution: { ...value.reportPageResolution, cursorHash: "cursor-2" } } } });
  await expect(executionService.getReportPageResolution("run/one")).rejects.toThrow(/exact uncertain report-page/i);
});

test("report-page resolution posts only to its dedicated endpoint", async () => {
  const command = { profile: "report-page-resolution-command/v1", intentId: "intent", baseVersion: 1, factsHash: h, decisionKey: "resolution-command-0001",
    outcome: "ABANDONED", evidence: { reference: "case", note: "No captured result", observedAt: "2026-10-07T10:01:00.000Z" } };
  const response = { executionId: "run/one", intentId: "intent", recordId: "record", outcome: "ABANDONED", version: 2, state: "FAILED",
    resumeQueued: false, pageAccepted: false, replayed: false, noReplay: true, toolWasCalled: false };
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { success: true, data: response } });
  expect(await executionService.resolveReportPage("run/one", command)).toEqual(response);
  expect(post).toHaveBeenCalledWith("/executions/run%2Fone/report-page-resolutions", command);
});
