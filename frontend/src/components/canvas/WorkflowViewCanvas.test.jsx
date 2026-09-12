/** @jest-environment jsdom */

import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

jest.unstable_mockModule("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: "arrow-closed" },
  MiniMap: () => null,
  ReactFlow: ({ children }) => React.createElement("div", null, children),
  useEdgesState: (initial) => [initial, jest.fn(), jest.fn()],
  useNodesState: (initial) => [initial, jest.fn(), jest.fn()],
}));

const { ViewNode } = await import("./WorkflowViewCanvas.jsx");

afterEach(cleanup);

test("node details format nested parameters and MCP output without raw JSON", () => {
  const { container } = render(<ViewNode data={{
    label: "Invoice report",
    action: "finance.invoice.read",
    parameters: {
      report_options: { include_orders: true, currency_code: "LKR" },
      recipients: [{ name: "Manager", channel: "email" }],
    },
    executionStatus: "success",
    executionOutput: {
      content: [{ type: "text", text: '{"invoice_id":"INV-1","total":1250}' }],
    },
  }} />);

  fireEvent.click(screen.getByRole("button", { name: "Show details" }));

  for (const text of ["Report options", "Include orders", "Yes", "Currency code", "LKR", "Manager", "Invoice id", "INV-1", "1250"]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  expect(container.textContent).not.toContain("[object Object]");
  expect(container.textContent).not.toContain('{"invoice_id"');
  expect(container.querySelector("pre")).toBeNull();
});
