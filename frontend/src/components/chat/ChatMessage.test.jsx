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
