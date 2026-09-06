/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import CollectionPatchPreview from "./CollectionPatchPreview";
afterEach(cleanup);
const literal = value => ({ kind: "literal", value });
const mapped = value => ({ schema: { type: "string", minLength: 2 }, value });
const proposal = patch => ({ nodeId: "each", command: { type: "updateCollection", patch }, before: { maxItems: 3, body: { kind: "sequence", nodes: [{ nodeId: "unchanged-body" }] } }, after: { maxItems: 2, ...patch } });

test("a limit-only preview shows changed fields without rendering the whole body or internal syntax", () => {
  const { container } = render(<CollectionPatchPreview proposal={proposal({ maxItems: 2 })} />);
  expect(screen.getAllByText("Maximum items")).toHaveLength(2); expect(screen.getByText("3")).toBeTruthy(); expect(screen.getByText("2")).toBeTruthy();
  expect(screen.getByText(/all actions inside it are preserved/)).toBeTruthy(); expect(screen.queryByText("unchanged-body")).toBeNull(); expect(container.querySelector("pre")).toBeNull();
});

test.each([false, 0, null])("explicit collected value %s remains readable rather than disappearing", value => {
  render(<CollectionPatchPreview proposal={proposal({ collect: mapped(literal(value)) })} />);
  expect(screen.getByText(value === null ? "Explicit null" : value === false ? "No" : "0")).toBeTruthy();
  expect(screen.getByText("Min Length")).toBeTruthy(); expect(screen.queryByText("literal")).toBeNull();
});

test("collection references use operational labels and arrays show values without binding objects", () => {
  render(<CollectionPatchPreview proposal={proposal({ items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [literal("FIXTURE-001")] } }, collect: mapped({ kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item", "id"] }) })} />);
  expect(screen.getByText("FIXTURE-001")).toBeTruthy(); expect(screen.getByText("Current item → id")).toBeTruthy(); expect(screen.queryByText("nodeOutput")).toBeNull(); expect(screen.queryByText("ref")).toBeNull();
});

test("large binding previews disclose that undisplayed values remain preserved", () => {
  render(<CollectionPatchPreview proposal={proposal({ items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: Array.from({ length: 30 }, (_, index) => literal(`item-${index}`)) } } })} />);
  expect(screen.getByText("Remaining mappings are preserved, not removed")).toBeTruthy(); expect(screen.getByText("30")).toBeTruthy(); expect(screen.queryByText("item-29")).toBeNull();
});
