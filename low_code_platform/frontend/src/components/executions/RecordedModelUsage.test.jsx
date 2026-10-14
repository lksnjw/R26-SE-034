/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen, within } from "@testing-library/react";
import RecordedModelUsage from "./RecordedModelUsage";
import ExecutionTable from "./ExecutionTable";
import { MemoryRouter } from "react-router-dom";
import { normalizeExecution } from "../../services/execution.service";
afterEach(cleanup);

test("renders exact input/output/total with an explicit not-billing explanation", () => {
  const view = render(<RecordedModelUsage counts={{ input: 1100, output: 700, total: 1800 }} />);
  const region = screen.getByRole("region", { name: "Recorded model usage" });
  expect(within(region).getByText("1,100")).toBeTruthy(); expect(within(region).getByText("700")).toBeTruthy(); expect(within(region).getByText("1,800")).toBeTruthy();
  expect(within(region).getByText(/not a billing total/)).toBeTruthy();
  expect(view.container.querySelector("pre")).toBeNull();
});
test("missing and malformed counters do not turn into zero; actual zero stays visible", () => {
  const view = render(<RecordedModelUsage />); expect(screen.getAllByText("Not reported")).toHaveLength(3);
  view.rerender(<RecordedModelUsage counts={{ input: "private", output: 0, total: 0 }} />); expect(screen.getAllByText("Not reported")).toHaveLength(3); expect(screen.queryByText("private")).toBeNull();
  view.rerender(<RecordedModelUsage counts={{ input: 0, output: 0, total: 0 }} />); expect(screen.getAllByText("0")).toHaveLength(3);
});
test("list differentiates a recorded zero from missing usage", () => {
  render(<MemoryRouter><ExecutionTable executions={[normalizeExecution({ id: "known", tokens: { input: 0, output: 0, total: 0 } }), normalizeExecution({ id: "missing" })]} /></MemoryRouter>);
  expect(screen.getByRole("columnheader", { name: "Recorded tokens" })).toBeTruthy();
  expect(screen.getByText("0").getAttribute("title")).toContain("not a billing total"); expect(screen.getByText("Not reported")).toBeTruthy();
});
