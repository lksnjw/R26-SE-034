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

test("reviewed resource lookup failure is not rendered as proof of absence or a handled error", () => {
  const { container } = render(<GovernanceBlockPanel failure={{ failureCategory: "MCP_READ_TOOL_ERROR", businessErrorCode: "ERP_RESOURCE_NOT_FOUND", failedStepId: "employee" }} />);
  expect(screen.getByRole("heading", { name: "ERP resource lookup failed" })).toBeTruthy();
  expect(screen.getByText(/This does not prove the record is absent/)).toBeTruthy();
  expect(screen.getByText(/no handler, later node or automatic retry was run/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "ERP record not found" })).toBeNull();
  expect(container.querySelector("pre")).toBeNull(); expect(container.querySelector("button")).toBeNull();
});

test("unclassified acknowledged errors do not infer a business-error category from remote text", () => {
  render(<GovernanceBlockPanel failure={{ failureCategory: "MCP_READ_TOOL_ERROR", reason: "not_found", failedStepId: "lookup" }} />);
  expect(screen.getByRole("heading", { name: "ERP read returned an error" })).toBeTruthy();
  expect(screen.getByText(/not a successful answer/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "ERP resource lookup failed" })).toBeNull();
});

test("a business code alone cannot relabel an uncertain write as a confirmed read failure", () => {
  render(<GovernanceBlockPanel failure={{ failureCategory: "OPERATION_OUTCOME_UNKNOWN", businessErrorCode: "ERP_RESOURCE_NOT_FOUND", failedStepId: "send" }} />);
  expect(screen.getByRole("heading", { name: "Outcome unknown" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "ERP resource lookup failed" })).toBeNull();
});
