/** @jest-environment jsdom */

import { afterEach, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import ExecutionOutputPanel from "./ExecutionOutputPanel";
import { projectIterationEvidence } from "../../utils/iterationEvidence";
import { iterationFixture } from "../../utils/iterationEvidence.fixture";

afterEach(cleanup);

test("collection outputs require matching item evidence and retain an explicit null return", () => {
  const s = iterationFixture(0); s.execution.finalOutput = null; s.execution.valueOutputs.answer = { value: null }; s.timeline.at(-1).output = { value: null };
  render(<ExecutionOutputPanel execution={s.execution} iterationModel={projectIterationEvidence(s.execution, s.timeline, s.context)} />);
  expect(screen.getByTestId("final-output").textContent).toContain("Explicit null returned"); expect(screen.getByText("Saved workflow return")).toBeTruthy();
});
test("a collection with unmatched evidence never falls back to raw step/final output maps", () => {
  const s = iterationFixture(); render(<ExecutionOutputPanel execution={s.execution} />); expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.queryByText("Answer 1")).toBeNull(); expect(screen.queryByTestId("final-output")).toBeNull();
});
test("collection run detail lists readable per-item answers with the original positions", () => {
  const s = iterationFixture(); render(<ExecutionOutputPanel execution={s.execution} iterationModel={projectIterationEvidence(s.execution, s.timeline, s.context)} />);
  expect(screen.getByRole("region", { name: "Saved per-item answers" })).toBeTruthy(); expect(screen.getByText("each · item 2 · Read")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Saved item answer" })[1]); expect(screen.getAllByText("Answer 2").length).toBeGreaterThan(0);
});

test("a confirmed explicit null return is not hidden as missing output", () => {
  render(<ExecutionOutputPanel execution={{ status: "DONE", finalOutput: null, readProgress: { values: { answer: { kind: "return", status: "DONE" } } } }} />);
  expect(screen.getByTestId("final-output").textContent).toContain("Explicit null returned"); expect(screen.queryByTestId("no-output")).toBeNull();
});

test("a return receipt without a saved final output cannot invent a value", () => {
  render(<ExecutionOutputPanel execution={{ status: "FAILED", readProgress: { values: { answer: { kind: "return", status: "DONE" } } } }} />);
  expect(screen.getByTestId("no-output")).toBeTruthy(); expect(screen.queryByTestId("final-output")).toBeNull();
});

const doneExecution = {
  id: "run-1",
  status: "DONE",
  finalOutput: { invoiceId: "INV-42", cleared: true },
  stepOutputs: { classify: { category: "utilities" }, clear: { invoiceId: "INV-42", cleared: true } },
};

const failedExecution = {
  id: "run-2",
  status: "FAILED",
  finalOutput: { vendorId: "V-1", valid: true },
  stepOutputs: { validate: { vendorId: "V-1", valid: true } },
  failure: {
    failureCategory: "TOOL_FAILURE",
    failedStepId: "create",
    failedToolName: "procurement.create_purchase_order",
    toolWasCalled: true,
  },
};

test("a DONE execution renders its final output", () => {
  render(<ExecutionOutputPanel execution={doneExecution} />);

  const final = screen.getByTestId("final-output");
  expect(final.textContent).toMatch(/Final output/);
  expect(final.textContent).toMatch(/INV-42/);
  expect(final.textContent).toMatch(/ClearedYes/);
  expect(final.querySelector("pre")).toBeNull();
  // Every step output is listed too.
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/classify/);
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/utilities/);
  // A completed run is not labelled partial.
  expect(screen.queryByTestId("partial-output-badge")).toBeNull();
});

test("scheduled report coverage is explained without exposing raw receipt JSON", () => {
  render(<ExecutionOutputPanel execution={{ ...doneExecution, reportCoverage: { profile: "schedule-report-coverage/v1", nodeId: "invoiceReport", itemCount: 42,
    startAt: "2026-10-06T00:00:00.000Z", endAt: "2026-10-07T00:00:00.000Z", confirmedAt: "2026-10-07T09:00:01.000Z",
    pagination: { profile: "report-page-evidence/v1", firstPage: 1, lastPage: 3, pageCount: 3 } } }} />);
  const coverage = screen.getByRole("region", { name: "Scheduled report coverage" });
  expect(coverage.textContent).toMatch(/Complete report window confirmed/); expect(coverage.textContent).toMatch(/Records returned42/);
  expect(coverage.textContent).toMatch(/Pages confirmed3 · 1 through 3/);
  expect(coverage.textContent).toMatch(/does not approve or prove delivery/i); expect(coverage.querySelector("pre")).toBeNull();
});

test("a FAILED execution still renders the partial output it produced", () => {
  render(<ExecutionOutputPanel execution={failedExecution} />);

  expect(screen.getByTestId("partial-output-badge").textContent).toMatch(/Partial/);
  const final = screen.getByTestId("final-output");
  expect(final.textContent).toMatch(/Last completed step/);
  expect(final.textContent).toMatch(/V-1/);
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/validate/);
});

test("an execution with no output says so instead of rendering an empty box", () => {
  render(<ExecutionOutputPanel execution={{ id: "run-3", status: "FAILED" }} />);
  expect(screen.getByTestId("no-output").textContent).toMatch(/did not produce a confirmed output/i);
  expect(screen.queryByTestId("final-output")).toBeNull();
});

test("redacted output renders safely when credential-shaped fields are absent", () => {
  render(
    <ExecutionOutputPanel
      execution={{
        id: "run-redacted",
        status: "DONE",
        finalOutput: { value: "visible" },
        stepOutputs: { lookup: { value: "visible" } },
      }}
    />,
  );

  expect(screen.getByTestId("final-output").textContent).toMatch(/visible/);
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/lookup/);
});

test("a large output has a bounded readable table with disclosed preview limits", () => {
  const big = { rows: Array.from({ length: 4000 }, (_, index) => ({ index, value: `row-${index}` })) };
  render(<ExecutionOutputPanel execution={{ id: "run-4", status: "DONE", finalOutput: big }} />);

  const block = screen.getAllByTestId("output-block")[0];
  expect(block.querySelector("pre")).toBeNull();
  expect(block.querySelectorAll("tbody tr")).toHaveLength(25);
  expect(block.textContent).toMatch(/Showing 25 of 4000 records/);

  const toggle = screen.getByRole("button", { name: /Show more fields and rows/i });
  fireEvent.click(toggle);
  expect(block.querySelectorAll("tbody tr")).toHaveLength(50);
  expect(block.textContent).toMatch(/Showing 50 of 4000 records/);
});

test.each(["CANCELLED", "RECOVERY_REQUIRED", "RUNNING"])("%s retains confirmed partial answers without a completed outcome label", (status) => {
  render(<ExecutionOutputPanel execution={{ ...failedExecution, status }} />);
  expect(screen.getByTestId("final-output").textContent).toMatch(/Last completed step/);
  expect(screen.getByTestId("partial-output-badge")).not.toBeNull();
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/V-1/);
});
