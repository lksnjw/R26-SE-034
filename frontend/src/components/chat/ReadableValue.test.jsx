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
test("inline image and audio require explicit disclosure, with no autoplay or remote fetch", () => {
  const { container } = render(<ReadableResult value={{ content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }, { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" }] }} />);
  expect(container.querySelector("img,audio")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show image attachment" }));
  expect(screen.getByAltText("Tool-returned image attachment").getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
  fireEvent.click(screen.getByRole("button", { name: "Show audio attachment" }));
  const audio = container.querySelector("audio"); expect(audio.controls).toBe(true); expect(audio.autoplay).toBe(false); expect(audio.preload).toBe("none");
});
test("resources are readable references or literal data, never HTML, remote links, blob text or secrets in URLs", () => {
  const { container } = render(<ReadableResult value={{ content: [
    { type: "resource_link", name: "Invoice report", uri: "https://u:private@example.test/report?token=private#private", description: "Saved report", mimeType: "application/pdf", size: 42 },
    { type: "resource", resource: { uri: "erp://invoice/1", mimeType: "application/json", text: '{"invoice_id":"INV-1"}' } },
    { type: "resource", resource: { uri: "erp://report/1", blob: "SECRETBASE64==", mimeType: "text/html" } },
    { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
  ] }} />);
  expect(screen.getByText("Invoice report")).toBeTruthy(); expect(screen.getByText("INV-1")).toBeTruthy();
  expect(screen.getByText("https://example.test/report")).toBeTruthy();
  expect(container.textContent).not.toMatch(/SECRETBASE64|private|PHN2Zz4=/);
  expect(container.querySelector("a,img,iframe,svg,object")).toBeNull();
});
test("bridge error category and suggested wait explain a saved failure without automatic retry", () => {
  render(<ReadableResult value={{ content: [], isError: true, _meta: { "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1250 } } }} />);
  expect(screen.getByText("Error category · Rate limit")).toBeTruthy(); expect(screen.getByText(/Nothing will be retried automatically/)).toBeTruthy(); expect(screen.getByText("Suggested wait · 1.25 seconds")).toBeTruthy();
});
test("additional content blocks can be exposed without truncating the saved result", () => {
  render(<ReadableResult value={{ content: Array.from({ length: 30 }, (_, i) => ({ type: "text", text: `Returned block ${i}` })) }} />);
  expect(screen.queryByText("Returned block 29")).toBeNull(); expect(screen.getByText("Showing 25 of 30 content blocks.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show more tool content" })); expect(screen.getByText("Returned block 29")).toBeTruthy();
});
test("dispatch provenance is labeled as an engine request binding, not proof of delivery", () => {
  render(<ReadableResult value={{ content: [], structuredContent: { id: "INV-1" }, _meta: { "io.workflow-engine/dispatch": { remoteName: "read.rev_MS4wLjA", resourceVersion: "1.0.0", resourceDigest: "a".repeat(64) } } }} />);
  expect(screen.getByText("Reviewed dispatch binding")).toBeTruthy(); expect(screen.getByText("read.rev_MS4wLjA")).toBeTruthy(); expect(screen.getByText(/not a server-signed delivery/)).toBeTruthy();
});
