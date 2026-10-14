/** @jest-environment jsdom */
import React from "react";
import { useState } from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReadValueFields, { ReadBindingFields, SchemaContractFields } from "./ReadValueFields";
afterEach(cleanup);

test("literal reference-looking text stays literal; data mode is explicit", () => {
  const changed = jest.fn(); render(<ReadValueFields value={{ schema: { type: "string" }, value: { kind: "literal", value: "original" } }} onChange={changed} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Return value" }), { target: { value: "{{input.id}}" } });
  expect(changed).toHaveBeenLastCalledWith({ schema: { type: "string" }, value: { kind: "literal", value: "{{input.id}}" } });
});

test("existing unknown references are preserved and only a deliberate data choice replaces them", () => {
  const changed = jest.fn(), binding = { kind: "ref", source: "nodeOutput", nodeId: "old", path: ["value"] }, next = { kind: "ref", source: "workflowInput", path: ["id"] };
  render(<ReadBindingFields value={binding} onChange={changed} dataSources={[{ label: "Workflow input · id", expression: "{{input.id}}", binding: next, schema: { type: "string" } }]} />);
  expect(screen.getByRole("textbox", { name: "Output value source node" }).value).toBe("old"); expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Output value data source" }), { target: { value: "0" } }); expect(changed).toHaveBeenLastCalledWith(next);
});

test("required contract fields and untouched constraints survive schema edits", () => {
  const changed = jest.fn(); render(<SchemaContractFields schema={{ type: "object", additionalProperties: false, properties: { id: { type: "string", minLength: 1 } }, required: [], maxProperties: 2 }} onChange={changed} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Output contract · id required" }));
  expect(changed).toHaveBeenLastCalledWith({ type: "object", additionalProperties: false, properties: { id: { type: "string", minLength: 1 } }, required: ["id"], maxProperties: 2 });
});

test("object mappings reject reserved field names and preserve unrelated bindings", () => {
  const changed = jest.fn(); render(<ReadBindingFields value={{ kind: "object", fields: { id: { kind: "literal", value: "keep" } } }} onChange={changed} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Output value new field" }), { target: { value: "__proto__" } }); expect(screen.getByRole("button", { name: "Add value field" }).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Output value new field" }), { target: { value: "name" } }); fireEvent.click(screen.getByRole("button", { name: "Add value field" }));
  expect(changed).toHaveBeenLastCalledWith({ kind: "object", fields: { id: { kind: "literal", value: "keep" }, name: { kind: "literal", value: "" } } });
});

test("null and false values remain explicitly typed, not raw JSON", () => {
  function Editor() { const [value, setValue] = useState({ schema: { type: "null" }, value: { kind: "literal", value: null } }); return <ReadValueFields value={value} onChange={setValue} />; }
  const { container } = render(<Editor />); expect(screen.getByText(/Explicit null · not a missing/)).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Return value literal type" }), { target: { value: "boolean" } });
  expect(screen.getByRole("combobox", { name: "Return value" }).value).toBe("false"); expect(container.querySelector("pre")).toBeNull(); expect(container.querySelector("textarea")).toBeNull();
});
