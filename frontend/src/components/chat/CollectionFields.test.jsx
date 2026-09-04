/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CollectionFields, { collectionOwners, flowLoops, IterationFixturePicker } from "./CollectionFields";
import CollectionInspector, { CollectionWrapForm } from "./CollectionInspector";
afterEach(cleanup);
const sequence = (...nodes) => ({ kind: "sequence", nodes });
const config = { items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [] } }, maxItems: 3, collect: { schema: { type: "string" }, value: { kind: "literal", value: "" } } };
const inner = { kind: "foreach", id: "inner", ...config, body: sequence({ kind: "action", nodeId: "read" }) };
const outer = { kind: "foreach", id: "outer", ...config, body: sequence(inner) };

test("nested collection ownership is preserved without flattening branch bodies", () => {
  const flow = sequence({ kind: "if", id: "gate", then: sequence(outer), else: sequence() }, { kind: "action", nodeId: "after" });
  expect(flowLoops(flow).map(node => node.id)).toEqual(["outer", "inner"]);
  expect(collectionOwners(flow).get("read")).toEqual([{ id: "outer", maxItems: 3 }, { id: "inner", maxItems: 3 }]); expect(collectionOwners(flow).get("after")).toEqual([]);
});
test("one-based fixture positions create exact nested addresses and disallow empty, excessive or duplicate positions", () => {
  const onAdd = jest.fn(), loops = [{ id: "outer", maxItems: 3 }, { id: "inner", maxItems: 2 }];
  const view = render(<IterationFixturePicker nodeId="read" loops={loops} fixtures={{}} onAdd={onAdd} />);
  fireEvent.change(screen.getByLabelText("read outer fixture item number"), { target: { value: "2" } }); fireEvent.change(screen.getByLabelText("read inner fixture item number"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Add item response for read" })); expect(onAdd).toHaveBeenCalledWith("outer/1/inner/1/read");
  for (const value of ["", "0", "4", "1.5"]) { fireEvent.change(screen.getByLabelText("read outer fixture item number"), { target: { value } }); expect(screen.getByRole("button").disabled).toBe(true); }
  fireEvent.change(screen.getByLabelText("read outer fixture item number"), { target: { value: "2" } });
  view.rerender(<IterationFixturePicker nodeId="read" loops={loops} fixtures={{ "outer/1/inner/1/read": {} }} onAdd={onAdd} />); expect(screen.getByRole("button").disabled).toBe(true);
});
test("collection budgets accept only bounded integers", () => {
  const onChange = jest.fn(); render(<CollectionFields value={config} onChange={onChange} />);
  for (const value of ["", "0", "101", "1.5"]) fireEvent.change(screen.getByLabelText("Maximum collection items"), { target: { value } }); expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Maximum collection items"), { target: { value: "5" } }); expect(onChange).toHaveBeenCalledWith({ ...config, maxItems: 5 });
});
test("wrapping is an explicit preview and never guesses current-item mappings", () => {
  const onPreview = jest.fn(); const { container } = render(<CollectionWrapForm nodeId="read" onPreview={onPreview} />);
  fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "each" } }); fireEvent.submit(screen.getByRole("form", { name: "Wrap node in collection" }));
  expect(onPreview).toHaveBeenCalledWith({ type: "wrapCollection", nodeId: "read", loopId: "each", ...config, maxItems: 25 }, "Existing action", expect.objectContaining({ bodyAction: "read" })); expect(container.querySelector("pre")).toBeNull();
});
test("collection edits preserve their body and cannot silently flatten a nonempty collection", () => {
  const onPreview = jest.fn(), onRemove = jest.fn(); render(<CollectionInspector node={inner} canEdit onPreview={onPreview} onRemove={onRemove} />);
  fireEvent.change(screen.getByLabelText("Maximum collection items"), { target: { value: "2" } }); fireEvent.click(screen.getByRole("button", { name: "Preview collection edit" }));
  expect(onPreview).toHaveBeenCalledWith({ type: "updateCollection", nodeId: "inner", patch: { ...config, maxItems: 2 } }, config, { ...config, maxItems: 2 }); expect(screen.getByRole("button", { name: "Remove empty collection…" }).disabled).toBe(true); expect(onRemove).not.toHaveBeenCalled();
});
test("read-only collection details do not expose mutation controls", () => {
  const { container } = render(<CollectionInspector node={inner} canEdit={false} />); expect(screen.queryByRole("button")).toBeNull(); expect(screen.queryByLabelText("Maximum collection items")).toBeNull(); expect(container.querySelector("pre")).toBeNull();
});
