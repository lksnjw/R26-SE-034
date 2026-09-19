/** @jest-environment jsdom */
import React, { useState } from "react";
import { test, expect, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ModelInputFields from "./ModelInputFields";
import AnalysisNodeInspector from "./AnalysisNodeInspector";
import AgentNodeInspector from "./AgentNodeInspector";

afterEach(cleanup);
const invoices = "{{invoices.structuredContent.rows}}", orders = "{{orders.structuredContent.rows}}";
function Harness({ initial = invoices }) {
  const [value, setValue] = useState(initial);
  return <><ModelInputFields value={value} onChange={setValue} label="Analysis input" sources={[
    { expression: invoices, label: "Invoices · rows", binding: { source: "nodeOutput" } },
    { expression: orders, label: "Orders · rows", binding: { source: "nodeOutput" } },
    { expression: "{{input.secret}}", label: "Not a model source", binding: { source: "workflowInput" } },
  ]} /><output aria-label="Test input">{typeof value === "string" ? value : Object.entries(value).map(([name, ref]) => `${name}=${ref}`).join("|")}</output></>;
}
test("named form preserves the first source and adds editable labeled sources without raw JSON", () => {
  const view = render(<Harness />); fireEvent.change(screen.getByLabelText("Analysis input shape"), { target: { value: "named" } });
  expect(screen.getByLabelText("Analysis input source 1").value).toBe(invoices);
  fireEvent.change(screen.getByLabelText("Analysis input source name 1"), { target: { value: "invoices" } });
  fireEvent.click(screen.getByRole("button", { name: "Add named source" }));
  fireEvent.change(screen.getByLabelText("Analysis input source name 2"), { target: { value: "orders" } });
  fireEvent.change(screen.getByLabelText("Analysis input source 2"), { target: { value: orders } });
  expect(screen.getByLabelText("Test input").textContent).toBe(`invoices=${invoices}|orders=${orders}`);
  expect(view.container.querySelector("pre")).toBeNull(); expect(view.container.querySelector('option[value="{{input.secret}}"]')).toBeNull();
  expect(screen.getByRole("option", { name: "One source" }).disabled).toBe(true);
});
test("duplicate and unsafe names never overwrite or drop a source", () => {
  render(<Harness initial={{ invoices, orders }} />);
  for (const name of ["invoices", "constructor", "__proto__", "invoice report", ""]) {
    fireEvent.change(screen.getByLabelText("Analysis input source name 2"), { target: { value: name } });
    expect(screen.getByRole("alert").textContent).toContain("unique name");
    expect(screen.getByLabelText("Test input").textContent).toBe(`invoices=${invoices}|orders=${orders}`);
  }
});
test("remove is explicit, retains a last source and allows a deliberate single-source conversion", () => {
  render(<Harness initial={{ invoices, orders }} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove analysis input source 2" }));
  expect(screen.getByLabelText("Test input").textContent).toBe(`invoices=${invoices}`);
  expect(screen.getByRole("button", { name: "Remove analysis input source 1" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Analysis input shape"), { target: { value: "single" } });
  expect(screen.getByLabelText("Analysis input").value).toBe(invoices);
});
test("source count is bounded at eight and empty references require input", () => {
  render(<Harness initial={{ invoices }} />);
  for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole("button", { name: "Add named source" }));
  expect(screen.getByRole("button", { name: "Add named source" }).disabled).toBe(true);
  expect(screen.getByLabelText("Analysis input source 8").checkValidity()).toBe(false);
});
test.each(["analysis", "agent"])("read-only %s shows named input as formatted fields without rendering an object as React children", kind => {
  const Component = kind === "analysis" ? AnalysisNodeInspector : AgentNodeInspector;
  const view = render(<Component node={{ id: "joint", source: { input: { invoices, orders }, instruction: "Compare confirmed reports", allowed_actions: ["report.read"] } }} canEdit={false} />);
  expect(view.container.textContent).toContain("Invoices"); expect(view.container.textContent).toContain("Orders");
  expect(view.container.querySelector("pre")).toBeNull(); expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull();
});
