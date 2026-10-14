/** @jest-environment jsdom */
import React from "react";
import { test, expect, jest, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkflowMiniCanvas from "./WorkflowMiniCanvas";
import WorkflowSourcePreview from "./WorkflowSourcePreview";
import { miniWorkflowGraph, miniNodeEvidence, unselectedMiniNodes } from "./miniWorkflowGraph";

afterEach(cleanup);
const steps = ["read", "yes", "no", "send"].map(id => ({ id, label: id, source: { id, action: `demo.${id}`, description: `Step ${id}` } }));
const action = nodeId => ({ kind: "action", nodeId });
const sequence = (...nodes) => ({ kind: "sequence", nodes });

test("decision arrows retain both declared paths and their shared continuation", () => {
  const graph = miniWorkflowGraph(steps, sequence(action("read"), { id: "check", kind: "if", then: sequence(action("yes")), else: sequence(action("no")) }, action("send")), true);
  expect(graph.error).toBe("");
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: "read", to: "check" }),
    expect.objectContaining({ from: "check", to: "yes", label: "Yes" }),
    expect.objectContaining({ from: "check", to: "no", label: "No" }),
    expect.objectContaining({ from: "yes", to: "send" }),
    expect.objectContaining({ from: "no", to: "send" }),
  ]));
});

test("a returning branch has no edge to a later effect and unavailable structure is not flattened", () => {
  const graph = miniWorkflowGraph([steps[0], steps[3]], sequence({ id: "check", kind: "if", then: sequence(action("read")), else: sequence({ id: "finish", kind: "return" }) }, action("send")), true);
  expect(graph.edges.some(edge => edge.from === "finish")).toBe(false);
  const flow = sequence({ id: "check", kind: "if", then: sequence(action("read")), else: sequence({ id: "finish", kind: "return" }) });
  expect([...unselectedMiniNodes(flow, { check: { status: "DONE", selected: "then" } })]).toEqual(["finish"]);
  expect(unselectedMiniNodes(flow, { check: { status: "FAILED", selected: "then" } }).size).toBe(0);
  expect(miniWorkflowGraph(steps, undefined, true).edges).toEqual([]);
  expect(miniWorkflowGraph(steps, sequence(action("read")), true).error).toBeTruthy();
});

test("101 nodes stay readable and selection renders only one answer", () => {
  const many = Array.from({ length: 101 }, (_, index) => ({ id: `step_${index}`, label: `ERP read ${index + 1}`, source: {} }));
  const onSelect = jest.fn(), answer = jest.fn(step => <li>Answer for {step.label}</li>);
  const props = { simple: true, steps: many, selectedId: "step_100", onSelectCondition: onSelect, renderAction: answer };
  const graph = miniWorkflowGraph(many);
  expect(graph.nodes).toHaveLength(101); expect(graph.edges).toHaveLength(100); expect(graph.width).toBeLessThan(900);
  render(<WorkflowMiniCanvas {...props} />);
  expect(screen.getAllByRole("button", { name: /^Select step/ })).toHaveLength(101);
  expect(screen.getByText("Answer for ERP read 101")).toBeTruthy(); expect(answer).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Find workflow step" }), { target: { value: "ERP read 51" } });
  fireEvent.click(screen.getByRole("button", { name: "ERP read 51", exact: true }));
  expect(onSelect).toHaveBeenLastCalledWith("step_50");
});

test("saved answers outrank a stale running event while failures and exact decisions remain explicit", () => {
  expect(miniNodeEvidence("read", { stepOutputs: { read: { structuredContent: { data: [1, 2] } } } }, [{ nodeId: "read", status: "RUNNING" }]).label).toBe("2 records · View answer");
  expect(miniNodeEvidence("read", undefined, [{ nodeId: "read", status: "AWAITING_APPROVAL" }]).label).toBe("Needs approval");
  expect(miniNodeEvidence("check", undefined, [], { check: { status: "DONE", selected: "else" } }).label).toBe("No path selected");
});

test("supervisor JSON and YAML previews retain the saved workflow fields", () => {
  const source = "name: Demo\nsteps:\n - id: read\n   action: demo.read\n   parameters: {limit: 8}\n";
  render(<WorkflowSourcePreview source={source} />);
  fireEvent.click(screen.getByText("JSON preview & workflow source"));
  expect(JSON.parse(screen.getByLabelText("Workflow JSON").textContent).steps[0].parameters).toEqual({ limit: 8 });
  fireEvent.click(screen.getByRole("button", { name: "Workflow source (YAML)" }));
  expect(screen.getByLabelText("Workflow YAML").textContent).toBe(source);
});
