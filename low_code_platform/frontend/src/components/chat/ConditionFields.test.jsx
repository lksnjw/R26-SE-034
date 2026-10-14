/** @jest-environment jsdom */
import React, { useState } from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, test, expect } from "@jest/globals";
import ConditionFields from "./ConditionFields";
afterEach(cleanup);
const source = { label: "Workflow input · enabled", expression: "{{input.enabled}}", schema: { type: "boolean" }, binding: { kind: "ref", source: "workflowInput", path: ["enabled"] } };
function Form({ initial = { kind: "literal", value: true }, sources = [source] }) {
  const [value, setValue] = useState(initial);
  return <><ConditionFields value={value} onChange={setValue} dataSources={sources} /><output aria-label="Current predicate">{JSON.stringify(value)}</output></>;
}
test("Yes/No remain actual booleans and only explicit choice changes them", () => {
  render(<Form />); expect(JSON.parse(screen.getByLabelText("Current predicate").textContent).value).toBe(true);
  fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "false" } });
  expect(JSON.parse(screen.getByLabelText("Current predicate").textContent)).toEqual({ kind: "literal", value: false });
});
test("readable boolean source selection saves the structured binding without fetching an answer", () => {
  render(<Form sources={[source, { ...source, label: "Wrong string", schema: { type: "string" } }]} />);
  fireEvent.change(screen.getByLabelText("Condition input mode"), { target: { value: "data" } });
  expect(screen.getByLabelText("Condition data source").textContent).toContain("Workflow input · enabled"); expect(screen.queryByText(/Wrong string/)).toBeNull();
  expect(JSON.parse(screen.getByLabelText("Current predicate").textContent)).toEqual(source.binding);
});
test("unknown references stay intact and can be explicitly repaired with fields, not JSON", () => {
  render(<Form initial={{ kind: "ref", source: "nodeOutput", nodeId: "old", path: ["structuredContent", "ready"] }} />);
  expect(screen.getByLabelText("Condition source node").value).toBe("old");
  expect(screen.getByLabelText("Condition field path").value).toBe("structuredContent.ready");
  fireEvent.change(screen.getByLabelText("Condition source node"), { target: { value: "lookup" } });
  expect(JSON.parse(screen.getByLabelText("Current predicate").textContent)).toEqual({ kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "ready"] });
  expect(screen.getByText(/preserved, not confirmed/)).toBeTruthy();
});
