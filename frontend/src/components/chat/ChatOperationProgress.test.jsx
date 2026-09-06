/** @jest-environment jsdom */
import React from "react";
import { expect, jest, test, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChatOperationProgress from "./ChatOperationProgress";
afterEach(cleanup);
test("shows readable confirmed answers and cancellation without claiming rollback", () => {
  const cancel = jest.fn(), refresh = jest.fn();
  const { container } = render(<ChatOperationProgress operation={{ status: "RUNNING", stage: "READ_SAVED", persistence: "durable", modelBinding: { model: "fixture-model" }, attempts: [{ id: "one", toolName: "read_invoices", status: "DONE", output: { structuredContent: [{ invoiceNumber: "INV-001", total: 100 }] } }] }} onCancel={cancel} onRefresh={refresh} />);
  expect(screen.getByRole("status").textContent).toBe("Confirmed read saved"); expect(screen.getByRole("table")).toBeTruthy(); expect(screen.getByText("INV-001")).toBeTruthy(); expect(container.querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel request" })); fireEvent.click(screen.getByRole("button", { name: "Refresh saved progress" })); expect(cancel).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
});
test("uncertain and answered states never imply business completion or automatic retry", () => {
  const { rerender } = render(<ChatOperationProgress operation={{ status: "RECOVERY_REQUIRED", stage: "RECOVERY_REQUIRED", persistence: "memory-only", cancellationRequested: true, attempts: [{ id: "one", toolName: "read", status: "UNKNOWN" }] }} />);
  expect(screen.getByText(/remote work was rolled back/)).toBeTruthy(); expect(screen.getByText(/Outcome unconfirmed/)).toBeTruthy(); expect(screen.getByText(/lost on server restart/)).toBeTruthy(); expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
  rerender(<ChatOperationProgress operation={{ status: "ANSWERED", stage: "ANSWERED", persistence: "durable", attempts: [] }} />); expect(screen.getByText(/not proof of email delivery/)).toBeTruthy();
});

test("saved proposal progress describes its original source without prescribing a stale apply action", () => {
  render(<ChatOperationProgress operation={{ status: "ANSWERED", stage: "ANSWERED", persistence: "durable", nodeContext: { nodeId: "each", baseVersion: 1 }, artifactRefs: [{ type: "node-proposal", id: "proposal-one" }] }} />);
  expect(screen.getByText(/source draft v1/)).toBeTruthy(); expect(screen.getByText(/current review status is shown beside the workflow/)).toBeTruthy(); expect(screen.queryByText(/choose Apply to draft/)).toBeNull();
});
