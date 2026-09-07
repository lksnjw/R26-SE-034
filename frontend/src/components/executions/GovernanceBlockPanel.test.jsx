/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import GovernanceBlockPanel from "./GovernanceBlockPanel";

afterEach(cleanup);
test.each([
  ["OPERATION_OUTCOME_UNKNOWN", "Outcome unknown", "not a confirmed tool failure or success"],
  ["READ_OUTCOME_UNKNOWN", "Outcome unknown", "not a confirmed tool failure or success"],
  ["LEGACY_OUTCOME_UNKNOWN", "Outcome unknown", "not a confirmed tool failure or success"],
  ["OPERATION_INTERRUPTED", "Run interrupted", "before its next completion checkpoint"],
  ["READ_INTERRUPTED", "Run interrupted", "before its next completion checkpoint"],
  ["OPERATION_BLOCKED_BEFORE_DISPATCH", "Operation stopped before dispatch", "not rolled back"],
])("%s evidence is not mislabeled a confirmed tool failure", (failureCategory, title, explanation) => {
  const { container } = render(<GovernanceBlockPanel failure={{ failureCategory, failedStepId: "send" }} />);
  expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  expect(screen.getByText(new RegExp(explanation))).toBeTruthy();
  expect(screen.getByText(/No automatic replay/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Tool failure" })).toBeNull();
  expect(container.querySelector("pre")).toBeNull();
});

test("a real tool failure retains its distinct failure explanation", () => {
  render(<GovernanceBlockPanel failure={{ failureCategory: "TOOL_EXECUTION_ERROR", failedStepId: "lookup", failedToolName: "demo.lookup" }} />);
  expect(screen.getByRole("heading", { name: "Tool failure" })).toBeTruthy();
  expect(screen.getByText(/failed while running demo.lookup/)).toBeTruthy();
  expect(screen.queryByTestId("recovery-required-panel")).toBeNull();
});
