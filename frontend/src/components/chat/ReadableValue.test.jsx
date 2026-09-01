/** @jest-environment jsdom */
import React from "react";
import { test, expect, afterEach } from "@jest/globals";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ReadableValue, { ReadableResult } from "./ReadableValue";
import MessageMarkdown from "./MessageMarkdown";
afterEach(cleanup);

test("objects become labeled fields, preserving false, zero, null, empty text and nested values", () => {
  const { container } = render(<ReadableValue value={{ invoice_total: 0, delivered: false, recipient: null, note: "", nested: { currencyCode: "LKR" } }} />);
  for (const text of ["Invoice total", "0", "No", "Not set", "Empty text", "Currency Code", "LKR"]) expect(screen.getByText(text)).toBeTruthy();
  expect(container.querySelector("pre")).toBeNull();
});
test("records render a table with heterogeneous fields; omitted columns do not become invented values", () => {
  render(<ReadableValue value={[{ invoice_id: "INV-1", total: 45 }, { invoice_id: "INV-2", paid: true }]} />);
  expect(screen.getByRole("table", { name: "Returned records" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Invoice id" })).toBeTruthy();
  expect(screen.getAllByText("Not provided")).toHaveLength(2);
  expect(screen.getByText("Yes")).toBeTruthy();
});
test("MCP JSON-text and structured results retain annotations and explicit error status", () => {
  const { container } = render(<ReadableResult value={{ isError: true, structuredContent: { partial: true }, content: [{ type: "text", text: '{"invoice_id":"INV-1"}' }, { type: "text", text: "Only a partial answer." }, { type: "image", data: "not-for-display" }] }} />);
  expect(screen.getByText("The tool reported an error.")).toBeTruthy();
  expect(screen.getByText("INV-1")).toBeTruthy();
  expect(screen.getByText("Only a partial answer.")).toBeTruthy();
  expect(screen.getByText(/does not display that content type/)).toBeTruthy();
  expect(container.textContent).not.toContain("not-for-display");
  expect(container.querySelector("pre")).toBeNull();
});
test.each(['{"customer_name":"Acme","total":12}', '```json\n{"customer_name":"Acme","total":12}\n```'])("JSON chat responses become formatted fields: %s", (text) => {
  const { container } = render(<MessageMarkdown text={text} />);
  expect(screen.getByText("Customer name")).toBeTruthy(); expect(screen.getByText("Acme")).toBeTruthy();
  expect(container.querySelector("pre")).toBeNull();
});
test("ordinary prose, malformed JSON and unsafe-looking text stay literal; no data HTML executes", () => {
  const { container } = render(<ReadableResult value={{ content: [{ type: "text", text: "{invalid}" }, { type: "text", text: "<img src=x onerror=alert(1)>" }] }} />);
  expect(screen.getByText("{invalid}")).toBeTruthy();
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
});
test("large collections disclose their preview and can show additional rows", () => {
  render(<ReadableValue value={Array.from({ length: 30 }, (_, index) => ({ id: `record-${index}` }))} />);
  expect(screen.getByText("Showing 25 of 30 records.")).toBeTruthy();
  expect(screen.queryByText("record-29")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more fields and rows" }));
  expect(screen.getByText("record-29")).toBeTruthy();
});
