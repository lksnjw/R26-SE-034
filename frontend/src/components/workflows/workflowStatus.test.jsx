/** @jest-environment jsdom */

import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import ExecutionStatus from "../executions/ExecutionStatus.jsx";
import WorkflowBadge from "./WorkflowBadge.jsx";

afterEach(cleanup);

test("unknown execution and workflow statuses render the raw value with neutral styling", () => {
  const { unmount } = render(<ExecutionStatus status="FUTURE_STATUS" />);
  const executionStatus = screen.getByTestId("execution-status");
  expect(executionStatus.textContent).toBe("FUTURE_STATUS");
  expect(executionStatus.className).toMatch(/bg-gray-100/);
  expect(executionStatus.textContent).not.toMatch(/Pending/i);
  unmount();

  render(<WorkflowBadge status="ARCHIVED" />);
  const workflowStatus = screen.getByText("ARCHIVED");
  expect(workflowStatus.className).toMatch(/bg-gray-100/);
  expect(screen.queryByText("Pending")).toBeNull();
});

test.each([["CANCELLED", "Cancelled"], ["RECOVERY_REQUIRED", "Recovery required"], ["UNKNOWN", "Outcome unknown"]])("known execution state %s has a readable distinct label", (status, label) => {
  render(<ExecutionStatus status={status} />);
  expect(screen.getByTestId("execution-status").textContent).toBe(label);
  expect(screen.getByTestId("execution-status").textContent).not.toMatch(/Done|Failed|Pending/);
});
