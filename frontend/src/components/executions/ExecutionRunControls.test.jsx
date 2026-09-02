/** @jest-environment jsdom */
import React from "react";
import { jest, expect, test, afterEach } from "@jest/globals";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import ExecutionRunControls from "./ExecutionRunControls";
import { executionService } from "../../services/execution.service";
const run = { id: "run", status: "RUNNING", readProgress: { profile: "read-progress-v1", persistence: "memory-only" } };
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
test("cancellation is a pending request, not a fabricated cancelled outcome", async () => {
  jest.spyOn(executionService, "cancel").mockResolvedValue(run);
  const refresh = jest.fn(); render(<ExecutionRunControls execution={run} canControl monitor={{ refresh }} />);
  fireEvent.click(screen.getByRole("button", { name: "Request cancellation" }));
  await screen.findByRole("button", { name: "Cancellation requested" });
  expect(executionService.cancel).toHaveBeenCalledWith("run"); expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("execution-status").textContent).toBe("Running");
  expect(screen.getByRole("status").textContent).toMatch(/in-flight read may finish/);
  expect(screen.getByRole("button", { name: "Cancellation requested" }).disabled).toBe(true);
  expect(screen.getByText(/Memory-only run/)).toBeTruthy();
});
test("a lost cancellation response stays unconfirmed and requests a fresh snapshot", async () => {
  jest.spyOn(executionService, "cancel").mockRejectedValue(new Error("Network failed"));
  const refresh = jest.fn(); render(<ExecutionRunControls execution={run} canControl monitor={{ refresh }} />);
  fireEvent.click(screen.getByRole("button", { name: "Request cancellation" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("alert").textContent).toMatch(/not confirmed/);
  expect(screen.getByTestId("execution-status").textContent).toBe("Running");
  expect(screen.queryByRole("button", { name: "Cancellation requested" })).toBeNull();
});
test("read-only and legacy runs have no cancellation action", () => {
  const view = render(<ExecutionRunControls execution={run} />);
  expect(screen.queryByRole("button", { name: "Request cancellation" })).toBeNull();
  view.rerender(<ExecutionRunControls execution={{ ...run, readProgress: undefined }} canControl />);
  expect(screen.queryByRole("button", { name: "Request cancellation" })).toBeNull();
});
test("recovery and journal are readable, non-replaying and never raw JSON", () => {
  const { container } = render(<ExecutionRunControls execution={{ ...run, status: "RECOVERY_REQUIRED" }} canControl monitor={{ refresh: jest.fn(), cursor: 1, events: [{ sequence: 1, timestamp: "2026-10-05T00:00:00Z", type: "node.outcome_unknown", nodeId: "lookup" }] }} />);
  expect(screen.getByRole("status").textContent).toMatch(/unconfirmed call may have reached ERP/);
  expect(screen.getByText("Node outcome unknown")).toBeTruthy(); expect(container.querySelector("pre")).toBeNull();
  expect(screen.queryByRole("button", { name: /Request cancellation|Retry/ })).toBeNull();
});
