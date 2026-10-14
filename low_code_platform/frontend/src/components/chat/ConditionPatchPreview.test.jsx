/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import ConditionPatchPreview from "./ConditionPatchPreview";

afterEach(cleanup);
const merge = { schema: { type: "object", properties: { orderIds: { type: "array", items: { type: "string" }, maxItems: 40 } }, required: ["orderIds"], additionalProperties: false },
  then: { kind: "object", fields: { orderIds: { kind: "ref", source: "nodeOutput", nodeId: "invoice_yes", path: ["structuredContent", "orderIds"] } } },
  else: { kind: "object", fields: { orderIds: { kind: "ref", source: "nodeOutput", nodeId: "invoice_no", path: ["structuredContent", "orderIds"] } } } };
const before = { id: "gate", predicate: { kind: "literal", value: true }, then: { nodes: [{ nodeId: "private_branch_action" }] }, else: { nodes: [] } };
const proposal = patch => ({ nodeId: "gate", command: { type: "updateCondition", nodeId: "gate", patch }, before, after: { ...before, ...patch } });

test("condition patch shows named Yes/No source mappings and every declared contract without raw JSON or unrelated actions", () => {
  const view = render(<ConditionPatchPreview proposal={proposal({ merge })} />);
  expect(screen.getByText("If yes")).toBeTruthy(); expect(screen.getByText("If no")).toBeTruthy();
  expect(screen.getByText("Node invoice_yes → structuredContent → orderIds")).toBeTruthy();
  expect(screen.getByText("Node invoice_no → structuredContent → orderIds")).toBeTruthy();
  expect(screen.getByText(/Max items/i)).toBeTruthy(); expect(screen.getByText("40")).toBeTruthy(); expect(screen.getByText(/Additional properties/i)).toBeTruthy();
  expect(view.container.querySelector("pre")).toBeNull(); expect(view.container.textContent).not.toContain('"kind":'); expect(view.container.textContent).not.toContain("private_branch_action");
  expect(screen.getByText(/not a fetched answer or proof of delivery/)).toBeTruthy();
});
test("predicate/output combined patch displays false explicitly without pretending that a node was removed", () => {
  render(<ConditionPatchPreview proposal={proposal({ predicate: { kind: "literal", value: false }, merge })} />);
  const conditions = screen.getAllByText("Condition"); expect(conditions).toHaveLength(2);
  expect(within(conditions[1].nextElementSibling).getByText("No")).toBeTruthy();
  expect(screen.getByText(/Only the listed condition fields change/)).toBeTruthy();
});
test("removal preview warns about downstream consumers and distinguishes absent output from an explicit null value", () => {
  const value = proposal({ merge: null }); value.before = { ...before, merge }; delete value.after.merge;
  render(<ConditionPatchPreview proposal={value} />);
  expect(screen.getByText(/Branch output will be removed/)).toBeTruthy(); expect(screen.getByText("No declared output")).toBeTruthy();
  fireEvent.click(screen.getByText("Before")); expect(screen.getByText("Node invoice_yes → structuredContent → orderIds")).toBeTruthy();
  cleanup(); const nullable = { schema: { type: "null" }, then: { kind: "literal", value: null }, else: { kind: "literal", value: null } };
  const view = render(<ConditionPatchPreview proposal={proposal({ merge: nullable })} />);
  expect(within(view.container).getAllByText("Explicit null")).toHaveLength(3); expect(screen.queryByText("No declared output", { selector: "span" })).toBeTruthy();
  expect(screen.queryByText(/Branch output will be removed/)).toBeNull();
});
test("deep and long mapping previews announce display limits and do not transform the saved proposal", () => {
  let then = { kind: "literal", value: "deep-private-preview-tail" }; for (let i = 0; i < 12; i++) then = { kind: "array", items: [then] };
  const value = proposal({ merge: { schema: { type: "array", items: { type: "string" } }, then, else: { kind: "array", items: Array.from({ length: 30 }, (_, i) => ({ kind: "literal", value: `item-${i}` })) } } });
  const snapshot = JSON.stringify(value); render(<ConditionPatchPreview proposal={value} />);
  expect(screen.getByText(/Remaining mappings are preserved, not removed/)).toBeTruthy(); expect(screen.getByText("30")).toBeTruthy();
  expect(screen.queryByText("deep-private-preview-tail")).toBeNull(); expect(JSON.stringify(value)).toBe(snapshot);
});
