/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const resolveReportPage = jest.fn();
jest.unstable_mockModule("../../services/execution.service", () => ({ executionService: { resolveReportPage } }));
const { default: Review } = await import("./ReportPageResolutionReview");
afterEach(() => { cleanup(); resolveReportPage.mockReset(); });
const h = `sha256:${"a".repeat(64)}`;
const execution = { id: "run", workflowName: "Daily invoices", reportPageResolution: { profile: "report-page-resolution-case/v1", state: "OPEN", intentId: "intent",
  nodeId: "report", invocationId: "run:report:cursor:2", continuationProfile: "opaque-cursor/v1", pointer: 2, cursorHash: h,
  requesterId: "requester", toolName: "Invoice report", remoteToolName: "erp.invoice_report", arguments: { cursor: "[protected cursor]", startAt: "2026-10-06" },
  outputSchema: { type: "object", properties: { complete: { type: "boolean" }, summary: { type: "string" } }, required: ["complete", "summary"], additionalProperties: false },
  confirmedPages: 1, confirmedItems: 50, version: 1, factsHash: h, canRecord: true, canResume: true, noReplay: true, history: [], explanation: "No replay." } };

function fillEvidence() {
  fireEvent.change(screen.getByLabelText("Report evidence reference"), { target: { value: "support-case-42" } });
  fireEvent.change(screen.getByLabelText("Report evidence note"), { target: { value: "Checked the captured connector response." } });
  fireEvent.click(screen.getByRole("button", { name: "Observed just now" }));
}

test("uses typed fields and submits a captured page without raw JSON or cursor disclosure", async () => {
  resolveReportPage.mockResolvedValue({ executionId: "run", intentId: "intent", recordId: "record", outcome: "PAGE_CONFIRMED", version: 2,
    state: "RESUMED", resumeQueued: true, pageAccepted: true, replayed: false, noReplay: true, toolWasCalled: false });
  const reload = jest.fn().mockResolvedValue({}); const view = render(<Review execution={execution} onReload={reload} />);
  expect(view.container.querySelector("pre")).toBeNull(); expect(screen.queryByText("cursor-2")).toBeNull();
  expect(screen.getByText("[protected cursor]")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Captured page · summary"), { target: { value: "Captured page two" } }); fillEvidence();
  fireEvent.click(screen.getByText(/I independently captured this exact page/));
  fireEvent.click(screen.getByRole("button", { name: "Validate captured page and continue" }));
  await waitFor(() => expect(resolveReportPage).toHaveBeenCalledTimes(1));
  expect(resolveReportPage.mock.calls[0][1]).toMatchObject({ profile: "report-page-resolution-command/v1", outcome: "PAGE_CONFIRMED",
    output: { content: [], structuredContent: { complete: false, summary: "Captured page two" } } });
  expect(await screen.findByText(/worker continues from the next page or cursor/i)).toBeTruthy();
});

test("abandonment is a separate explicit close action with no invented output", async () => {
  resolveReportPage.mockResolvedValue({ executionId: "run", intentId: "intent", recordId: "record", outcome: "ABANDONED", version: 2,
    state: "FAILED", resumeQueued: false, pageAccepted: false, replayed: false, noReplay: true, toolWasCalled: false });
  render(<Review execution={execution} onReload={jest.fn().mockResolvedValue({})} />); fillEvidence();
  fireEvent.click(screen.getByText(/No trustworthy captured result is available/)); fireEvent.click(screen.getByRole("button", { name: "Abandon this occurrence" }));
  await waitFor(() => expect(resolveReportPage).toHaveBeenCalledTimes(1));
  expect(resolveReportPage.mock.calls[0][1]).toMatchObject({ outcome: "ABANDONED" }); expect(resolveReportPage.mock.calls[0][1]).not.toHaveProperty("output");
});
