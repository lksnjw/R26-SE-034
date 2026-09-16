/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import ReadFlowTree from "./ReadFlowTree";
afterEach(cleanup);
const action = nodeId => ({ kind: "action", nodeId });
const sequence = (...nodes) => ({ kind: "sequence", nodes });
const flow = sequence({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: sequence(action("yes")), else: sequence(action("no")) }, action("after"));
const steps = ["yes", "no", "after"].map(id => ({ id }));
const renderAction = step => <li key={step.id}><button>{step.id}</button></li>;

test("decision nodes have a distinct diamond, literal meaning and keyboard-selectable chat scope", () => {
  const select = jest.fn(), literalFlow = JSON.parse(JSON.stringify(flow));
  literalFlow.nodes[0].predicate = { kind: "literal", value: false };
  render(<ReadFlowTree flow={literalFlow} steps={steps} renderAction={renderAction} onSelectCondition={select} selectedId="gate" />);
  expect(screen.getByTestId("decision-node-icon").getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByText("Literal condition · always chooses No.")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Select condition gate" });
  expect(button.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(button); expect(select).toHaveBeenCalledWith("gate");
  expect(screen.getByText("No decision recorded for this snapshot")).toBeTruthy();
});

const collection = maxItems => sequence({ kind: "foreach", id: "each", maxItems, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [] } }, collect: { schema: { type: "string" }, value: { kind: "literal", value: "" } }, body: flow });
test("collections remain nested and selectable without inventing real iteration answers", () => {
  const select = jest.fn(); render(<ReadFlowTree flow={collection(3)} steps={steps} renderAction={renderAction} onSelectCondition={select} values={{ each: { kind: "collection", status: "DONE" } }} valueOutputs={{ each: { value: "forged receipt" } }} />);
  expect(within(screen.getByRole("region", { name: "each collection body" })).getByRole("region", { name: "gate If yes" })).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Select collection each" })); expect(select).toHaveBeenCalledWith("each");
  expect(screen.getByText(/No matching saved item evidence/)).toBeTruthy(); expect(screen.queryByText("forged receipt")).toBeNull();
});
test.each([0, 101, 1.5])("invalid collection budget %s falls back to visibly unconfirmed declarations", maximum => {
  render(<ReadFlowTree flow={collection(maximum)} steps={steps} renderAction={renderAction} />); expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.queryByRole("region", { name: "Collection each" })).toBeNull();
});

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

test("typed branch values and false returns are separate from condition decisions and ERP answers", () => {
  const typed = JSON.parse(JSON.stringify(flow)); typed.nodes[0].merge = { schema: { type: "string" } };
  typed.nodes.push({ kind: "return", id: "answer", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  render(<ReadFlowTree flow={typed} steps={steps} renderAction={renderAction} values={{ gate: { kind: "merge", status: "DONE" }, answer: { kind: "return", status: "DONE" } }} valueOutputs={{ gate: { value: "selected value" }, answer: { value: false } }} />);
  expect(screen.getByText("selected value")).toBeTruthy(); expect(within(screen.getByRole("region", { name: "Return answer" })).getByText("No")).toBeTruthy();
  expect(screen.getByText("Saved selected-branch value · no tool call")).toBeTruthy(); expect(screen.getByText("No decision recorded for this snapshot")).toBeTruthy();
});

test("unconfirmed value payloads never become saved returns", () => {
  render(<ReadFlowTree flow={sequence(...flow.nodes, { kind: "return", id: "answer", output: { schema: { type: "null" }, value: { kind: "literal", value: null } } })} steps={steps} renderAction={renderAction} valueOutputs={{ answer: { value: "unconfirmed" } }} />);
  expect(screen.getByText("No return recorded for this snapshot")).toBeTruthy(); expect(screen.queryByText("unconfirmed")).toBeNull();
});
