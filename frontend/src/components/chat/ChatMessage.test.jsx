/** @jest-environment jsdom */
import React from "react";
import { test, expect, afterEach, jest } from "@jest/globals";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
const { default: ChatMessage } = await import("./ChatMessage");
afterEach(cleanup);
test("chat shows the persisted proposal decision rather than only stale proposed wording", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Node change proposed.", artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal: { nodeId: "invoices", status: "APPLIED", appliedVersion: 2 } } }} /></MemoryRouter>);
  expect(screen.getByText("Applied to draft v2 · not published or executed by this decision.")).toBeTruthy();
});
test("validated saved workflow is explicitly a draft, not invalid or ready to execute", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Saved.", artifacts: { intent: "WORKFLOW", workflowId: "one", yaml: "name: one\nsteps: []", validation: { passed: true }, can_execute: false } }} /></MemoryRouter>);
  expect(screen.getByText("Saved draft · Validation passed")).toBeTruthy();
  expect(screen.queryByText(/ready to execute/)).toBeNull();
});
test("incomplete read preparation is not mislabeled as a successful result or a known timeout", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Preparation stopped.", artifacts: { intent: "QUERY", sources: [{ name: "read", arguments: {} }], boundHit: true } }} /></MemoryRouter>);
  expect(screen.getByText("1 tool call · preparation incomplete")).toBeTruthy();
  expect(screen.queryByText(/limit reached/)).toBeNull();
});
test("historical chat exposes saved structured/attachment/failure receipts even without an active operation monitor", () => {
  const { container } = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Partial read.", artifacts: { intent: "QUERY", toolSteps: [
    { toolName: "invoices", status: "SUCCEEDED", result: { content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], structuredContent: { invoice_id: "INV-7" } } },
    { toolName: "details", status: "FAILED", result: { content: [{ type: "text", text: "Rate limit reached" }], isError: true } },
  ] } }} /></MemoryRouter>);
  expect(screen.getByText("Saved tool responses · 2")).toBeTruthy(); expect(screen.getByText("Invoice id")).toBeTruthy(); expect(screen.getByText("INV-7")).toBeTruthy();
  expect(screen.getByText("details · Failure response")).toBeTruthy(); expect(screen.getByText("Rate limit reached")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show image attachment" })).toBeTruthy(); expect(container.querySelector("img,pre")).toBeNull();
});
