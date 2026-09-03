/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen, within } from "@testing-library/react";
import ReadFlowTree from "./ReadFlowTree";
afterEach(cleanup);
const action = nodeId => ({ kind: "action", nodeId });
const sequence = (...nodes) => ({ kind: "sequence", nodes });
const flow = sequence({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: sequence(action("yes")), else: sequence(action("no")) }, action("after"));
const steps = ["yes", "no", "after"].map(id => ({ id }));
const renderAction = step => <li key={step.id}><button>{step.id}</button></li>;

test("structured branches are nested and both remain inspectable without claiming execution", () => {
  const { container } = render(<ReadFlowTree flow={flow} steps={steps} renderAction={renderAction} />);
  expect(within(screen.getByRole("region", { name: "gate If yes" })).getByRole("button", { name: "yes" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "gate If no" })).getByRole("button", { name: "no" })).toBeTruthy();
  expect(screen.getByText("Workflow input → enabled must be Yes or No.")).toBeTruthy();
  expect(screen.getByText("No decision recorded for this snapshot")).toBeTruthy();
  expect(container.querySelector("pre")).toBeNull(); expect(screen.queryByText(/Selected/)).toBeNull();
});

test.each(["then", "else"])("only confirmed %s decision highlights one selected path", selected => {
  render(<ReadFlowTree flow={flow} steps={steps} renderAction={renderAction} decisions={{ gate: { status: "DONE", selected } }} />);
  expect(screen.getByText(`${selected === "then" ? "If yes" : "If no"} · Selected`)).toBeTruthy();
  expect(screen.getByText(`${selected === "then" ? "If no" : "If yes"} · Not selected`)).toBeTruthy();
  expect(screen.getByText(/Recorded decision:.*no tool call/)).toBeTruthy();
});

test("failed/unknown predicate is never labelled an automatically selected false branch", () => {
  render(<ReadFlowTree flow={flow} steps={steps} renderAction={renderAction} decisions={{ gate: { status: "FAILED" } }} />);
  expect(screen.getByText("Condition failed · no branch selected")).toBeTruthy(); expect(screen.queryByText(/· Selected/)).toBeNull();
});

test("invalid structural views are labelled declarations, not silently interpreted as an executable chain", () => {
  render(<ReadFlowTree flow={sequence(action("missing"))} steps={steps} renderAction={renderAction} />);
  expect(screen.getByRole("alert").textContent).toContain("not an executable branch layout"); expect(screen.getByRole("button", { name: "yes" })).toBeTruthy();
});

test.each([sequence(null), sequence(action("yes"), action("yes")), sequence(action("yes"))])("malformed, duplicated or incomplete saved views fail visibly without hiding declarations", badFlow => {
  render(<ReadFlowTree flow={badFlow} steps={steps} renderAction={renderAction} />);
  expect(screen.getByRole("alert").textContent).toContain("not an executable branch layout");
  for (const { id } of steps) expect(screen.getByRole("button", { name: id })).toBeTruthy();
});

test("an invalid saved decision cannot invent a selected false branch", () => {
  render(<ReadFlowTree flow={flow} steps={steps} renderAction={renderAction} decisions={{ gate: { status: "DONE", selected: "unknown" } }} />);
  expect(screen.getByText("No decision recorded for this snapshot")).toBeTruthy();
  expect(screen.queryByText(/· Selected/)).toBeNull();
});
