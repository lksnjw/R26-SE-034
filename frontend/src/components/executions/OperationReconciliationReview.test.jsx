/** @jest-environment jsdom */
import React from "react";
import { jest, expect, test, afterEach } from "@jest/globals";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import OperationReconciliationReview from "./OperationReconciliationReview";
import { executionService } from "../../services/execution.service";

const review = { profile: "operation-reconciliation/v1", intentId: "intent-1", nodeId: "send", invocationId: "run:send", operationKey: "run:send", preparedAt: "2026-10-06T00:00:00Z",
  requesterId: "owner", toolName: "Mail notification", remoteToolName: "mail.send__1.0.0", arguments: { recipient: "manager@example.test", subject: "Invoice report", body: "Report ready" },
  version: 1, factsHash: `sha256:${"a".repeat(64)}`, state: "OPEN", history: [], canRecord: true, basis: "operator-attestation", canResume: false, noReplay: true,
  explanation: "Record independently checked external evidence. This does not create a tool-confirmed answer, execute, resend, resume later nodes or verify recipient delivery." };
const execution = { id: "run", workflowName: "Daily invoice report", status: "RECONCILIATION_REQUIRED", operationReconciliation: review };
const result = { executionId: "run", intentId: "intent-1", recordId: "record-1", version: 2, outcome: "APPLIED", state: "RESOLVED", basis: "operator-attestation", canResume: false, noReplay: true, toolWasCalled: false };
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
function fill(outcome = "APPLIED") {
  fireEvent.change(screen.getByRole("combobox", { name: "Observed outcome" }), { target: { value: outcome } });
  fireEvent.change(screen.getByRole("textbox", { name: "Evidence reference" }), { target: { value: "ERP-RECORD-123" } });
  fireEvent.change(screen.getByRole("textbox", { name: "What you checked" }), { target: { value: "Independently inspected ERP receipt" } });
  fireEvent.change(screen.getByLabelText("Evidence observed at"), { target: { value: "2026-10-06T10:30:00" } });
  fireEvent.click(screen.getByRole("checkbox"));
}
test("exact readable arguments precede independent evidence consent, never raw JSON or automatic success", async () => {
  const submit = jest.spyOn(executionService, "reconcile").mockResolvedValue(result), reload = jest.fn().mockResolvedValue(execution);
  const { container } = render(<OperationReconciliationReview execution={execution} onReload={reload} />);
  expect(screen.getByText("manager@example.test")).toBeTruthy(); expect(screen.getByText("mail.send__1.0.0")).toBeTruthy(); expect(container.querySelector("pre")).toBeNull();
  expect(screen.getByRole("button", { name: "Record external evidence" }).disabled).toBe(true); expect(screen.getByRole("combobox", { name: "Observed outcome" }).value).toBe("UNRESOLVED");
  fill(); expect(screen.getByRole("button", { name: "Record external evidence" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Record external evidence" })); await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(submit).toHaveBeenCalledWith("run", expect.objectContaining({ intentId: review.intentId, baseVersion: 1, factsHash: review.factsHash, outcome: "APPLIED", decisionKey: expect.any(String),
    evidence: { kind: "erp-record", reference: "ERP-RECORD-123", note: "Independently inspected ERP receipt", observedAt: expect.stringMatching(/Z$/) } }));
  expect(screen.getByRole("status").textContent).toMatch(/closed—not completed successfully/); expect(screen.getByRole("button", { name: "Record external evidence" }).disabled).toBe(true); expect(submit).toHaveBeenCalledTimes(1);
});
test("minimum reconciliation view places saved query evidence after exact arguments without granting full-run controls", () => {
  render(<OperationReconciliationReview execution={execution} onReload={jest.fn()} statusQueries={<section aria-label="ERP status queries">Saved operation-state observation</section>} />);
  const argumentsHeading = screen.getByRole("heading", { name: "Exact business arguments" });
  const queries = screen.getByRole("region", { name: "ERP status queries" });
  const decision = screen.getByRole("combobox", { name: "Observed outcome" });
  expect(argumentsHeading.compareDocumentPosition(queries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(queries.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText(/Execution Logs|Step Timeline|Saved run history/)).toBeNull();
});
test("lost evidence ACK locks the case and reload needs fresh consent, never an automatic resubmission", async () => {
  const submit = jest.spyOn(executionService, "reconcile").mockRejectedValue(new Error("Lost acknowledgement")), reload = jest.fn().mockResolvedValue(execution);
  render(<OperationReconciliationReview execution={execution} onReload={reload} />); fill(); fireEvent.click(screen.getByRole("button", { name: "Record external evidence" }));
  await screen.findByText(/Evidence acknowledgement is unknown/); expect(screen.getByRole("button", { name: "Record external evidence" }).disabled).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1); expect(reload).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Reload exact case" }));
  await screen.findByText(/Authoritative case reloaded/); expect(screen.getByRole("checkbox").checked).toBe(false); expect(submit).toHaveBeenCalledTimes(1);
});
test.each([false, true])("incomplete or unauthorized review (%s) cannot record partial evidence", unauthorized => {
  const value = { ...execution, operationReconciliation: { ...review, ...(unauthorized ? { canRecord: false } : { arguments: { body: "x".repeat(12001) } }) } };
  render(<OperationReconciliationReview execution={value} onReload={jest.fn()} />);
  const button = screen.queryByRole("button", { name: "Record external evidence" }); expect(!button || button.disabled).toBe(true);
  if (unauthorized) expect(screen.getByText(/requester cannot reconcile their own action/)).toBeTruthy(); else expect(screen.getByRole("alert").textContent).toMatch(/complete argument display/);
});
test("historical attestation remains visibly distinct from a tool answer, and closed cases have no decision form", () => {
  const record = { id: "record", outcome: "APPLIED", basis: "operator-attestation", actorId: "operator", recordedAt: "2026-10-06T10:31:00Z", evidence: { kind: "erp-record", reference: "ERP-123", note: "Inspected recipient record", observedAt: "2026-10-06T10:30:00Z" } };
  render(<OperationReconciliationReview execution={{ ...execution, status: "RECONCILED", operationReconciliation: { ...review, version: 2, state: "RESOLVED", canRecord: false, history: [record] } }} onReload={jest.fn()} />);
  expect(screen.getByText("Effect observed · operator attestation")).toBeTruthy(); expect(screen.getByText(/Not a saved tool answer/)).toBeTruthy(); expect(screen.getByText(/original SDK outcome remains unacknowledged/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record external evidence" })).toBeNull(); expect(screen.queryByRole("checkbox")).toBeNull();
});
test("a forged resumable receipt stays unconfirmed instead of displaying success", async () => {
  jest.spyOn(executionService, "reconcile").mockResolvedValue({ ...result, canResume: true });
  render(<OperationReconciliationReview execution={execution} onReload={jest.fn()} />); fill(); fireEvent.click(screen.getByRole("button", { name: "Record external evidence" }));
  await screen.findByText(/Evidence acknowledgement is unknown/); expect(screen.queryByText(/Operator evidence saved/)).toBeNull(); expect(screen.getByRole("button", { name: "Record external evidence" }).disabled).toBe(true);
});
test("changing the outcome clears consent and unresolved evidence does not claim closure", async () => {
  const submit = jest.spyOn(executionService, "reconcile").mockResolvedValue({ ...result, outcome: "UNRESOLVED", state: "OPEN" });
  render(<OperationReconciliationReview execution={execution} onReload={jest.fn().mockResolvedValue(execution)} />); fill();
  fireEvent.change(screen.getByRole("combobox", { name: "Observed outcome" }), { target: { value: "UNRESOLVED" } }); expect(screen.getByRole("checkbox").checked).toBe(false);
  expect(screen.getByRole("button", { name: "Record external evidence" }).disabled).toBe(true); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Record external evidence" }));
  await screen.findByText(/case remains unresolved/); expect(submit).toHaveBeenCalledTimes(1);
});

test("explicit current observation time is bounded by user action and clears any earlier consent", () => {
  render(<OperationReconciliationReview execution={execution} onReload={jest.fn()} />); fill();
  fireEvent.click(screen.getByRole("button", { name: "Observed just now" }));
  expect(screen.getByLabelText("Evidence observed at").value).toMatch(/^\d{4}-\d{2}-\d{2}T/); expect(screen.getByRole("checkbox").checked).toBe(false);
  expect(screen.getByRole("button", { name: "Record external evidence" }).disabled).toBe(true);
});
