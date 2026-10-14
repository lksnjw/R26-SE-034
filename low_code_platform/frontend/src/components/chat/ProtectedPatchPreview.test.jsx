/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import ProtectedPatchPreview from "./ProtectedPatchPreview";

afterEach(cleanup);
const output = { schema: { type: "string", maxLength: 120 }, success: { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "id"] }, handled: { kind: "ref", source: "nodeOutput", nodeId: "group", path: ["error", "code"] } };
const before = { id: "group", body: { nodes: [{ nodeId: "unchanged_body_child" }] }, handler: { nodes: [] }, output };
const proposal = { nodeId: "group", before, after: { ...before, output }, command: { type: "updateProtected", nodeId: "group", patch: { output } } };
test("protected preview shows readable distinct mappings and schema constraints, not body contents or raw JSON", () => {
  const view = render(<ProtectedPatchPreview proposal={proposal} />);
  expect(screen.getAllByText("Body succeeds")).toHaveLength(2); expect(screen.getAllByText("Error handled")).toHaveLength(2);
  expect(screen.getAllByText("Node lookup → structuredContent → id")).toHaveLength(2);
  expect(screen.getAllByText("Node group → error → code")).toHaveLength(2);
  expect(screen.getAllByText("120")).toHaveLength(2); expect(view.container.querySelector("pre")).toBeNull();
  expect(view.container.textContent).not.toContain("unchanged_body_child"); expect(view.container.textContent).not.toContain('"kind":');
  expect(screen.getByText(/does not prove absence/)).toBeTruthy(); expect(screen.getByText(/error policy, body and handler stay unchanged/)).toBeTruthy();
});
test("manual protected output preview accepts direct output and preserves false and explicit null", () => {
  const next = { schema: { type: "boolean" }, success: { kind: "literal", value: false }, handled: { kind: "literal", value: true } };
  const value = { ...proposal, before: { schema: { type: "null" }, success: { kind: "literal", value: null }, handled: { kind: "literal", value: null } }, command: { ...proposal.command, patch: { output: next } } };
  const snapshot = JSON.stringify(value), view = render(<ProtectedPatchPreview proposal={value} />);
  expect(screen.getAllByText("Explicit null")).toHaveLength(3); expect(screen.getByText("No", { selector: "span" })).toBeTruthy(); expect(screen.getByText("Yes", { selector: "span" })).toBeTruthy();
  expect(view.container.querySelector("pre")).toBeNull(); expect(JSON.stringify(value)).toBe(snapshot);
});
test("bounded group preview announces long display limits without changing the saved mappings", () => {
  const next = { schema: { type: "array", items: { type: "string" } }, success: { kind: "array", items: Array.from({ length: 30 }, (_, index) => ({ kind: "literal", value: `row-${index}` })) }, handled: { kind: "array", items: [] } };
  const value = { ...proposal, command: { ...proposal.command, patch: { output: next } } }, snapshot = JSON.stringify(value);
  render(<ProtectedPatchPreview proposal={value} />); expect(screen.getByText(/Remaining mappings are preserved, not removed/)).toBeTruthy();
  expect(screen.getByText("30")).toBeTruthy(); expect(screen.queryByText("row-29")).toBeNull(); expect(JSON.stringify(value)).toBe(snapshot);
});
