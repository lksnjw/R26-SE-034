/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { dump } from "js-yaml";

jest.unstable_mockModule("@xyflow/react", () => ({
  MarkerType: { ArrowClosed: "arrow-closed" },
}));

const {
  saveWorkflowForCanvas,
  takeWorkflowForCanvas,
  workflowCreationPayload,
  workflowYamlToCanvas,
} = await import("./workflowCanvas.utils");

afterEach(() => localStorage.clear());

test("chat origin survives the canvas handoff and enters the workflow creation payload", () => {
  const pending = {
    yaml: "name: linked\ntrigger:\n  type: manual\nsteps: []\n",
    candidateId: "candidate-1",
    canExecute: true,
    chatSessionId: "chat-1",
    chatMessageId: "msg-1",
    traceId: "4dfac97d-52c4-4f29-b09b-e2f60f7c89dc",
  };
  saveWorkflowForCanvas(pending);

  const received = takeWorkflowForCanvas();
  const canvas = workflowYamlToCanvas(received.yaml, received);
  const payload = workflowCreationPayload(canvas.workflow, received.yaml);

  expect(payload).toMatchObject({
    yaml: pending.yaml,
    chatSessionId: "chat-1",
    chatMessageId: "msg-1",
    traceId: "4dfac97d-52c4-4f29-b09b-e2f60f7c89dc",
  });
  expect(takeWorkflowForCanvas()).toBeNull();
});

test("ordinary canvas workflows do not gain chat correlation fields", () => {
  expect(
    workflowCreationPayload(
      { name: "Manual", description: "Created directly" },
      "name: manual",
    ),
  ).toEqual({
    name: "Manual",
    description: "Created directly",
    yaml: "name: manual",
  });
});

const structuredBlueprint = {
  name: "Explicit branches",
  trigger: { type: "manual" },
  steps: [
    { id: "lookup", action: "demo.echo", parameters: {} },
    { id: "yesPath", action: "demo.echo", parameters: {} },
    { id: "noPath", action: "demo.echo", parameters: {} },
    { id: "finish", action: "demo.echo", parameters: {} },
  ],
  metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: { kind: "sequence", nodes: [
    { kind: "action", nodeId: "lookup" },
    { kind: "if", id: "available", predicate: { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["available"] }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "yesPath" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "noPath" }] } },
    { kind: "action", nodeId: "finish" },
  ] } } },
};

test("explicit control flow renders condition branches and merge edges without flattening", () => {
  const canvas = workflowYamlToCanvas(dump(structuredBlueprint));
  expect(canvas.workflow.canvasProfile).toBe("structured-control-flow/v1");
  expect(canvas.nodes.map((node) => node.id)).toEqual(["lookup", "available", "yesPath", "noPath", "finish"]);
  expect(canvas.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "lookup", target: "available" }),
    expect.objectContaining({ source: "available", target: "yesPath", label: "Yes" }),
    expect.objectContaining({ source: "available", target: "noPath", label: "No" }),
    expect.objectContaining({ source: "yesPath", target: "finish" }),
    expect.objectContaining({ source: "noPath", target: "finish" }),
  ]));
  expect(canvas.nodes.find((node) => node.id === "available").data).toMatchObject({ action: "Condition", structural: true, nodeTypeLabel: "Decision" });
});

test("invalid explicit ownership is quarantined instead of redrawn as a chain", () => {
  const invalid = JSON.parse(JSON.stringify(structuredBlueprint));
  invalid.metadata.controlFlow.root.nodes[1].else.nodes = [];
  expect(() => workflowYamlToCanvas(dump(invalid))).toThrow("cannot be represented safely");
});

test("bounded collections and typed returns render as explicit structural nodes", () => {
  const canvas = workflowYamlToCanvas(dump({
    name: "Collection",
    trigger: { type: "manual" },
    steps: [
      { id: "list", action: "demo.echo", parameters: {} },
      { id: "item", action: "demo.echo", parameters: {} },
    ],
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [
      { kind: "action", nodeId: "list" },
      { kind: "foreach", id: "each", items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "list", path: ["items"] } }, maxItems: 5, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "item" }] }, collect: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [] } } },
      { kind: "return", id: "result", output: { schema: { type: "string" }, value: { kind: "literal", value: "done" } } },
    ] } } },
  }));
  expect(canvas.nodes.find((node) => node.id === "each").data).toMatchObject({ action: "Bounded collection", nodeTypeLabel: "Collection" });
  expect(canvas.nodes.find((node) => node.id === "result").data).toMatchObject({ action: "Typed workflow return", nodeTypeLabel: "Return" });
  expect(canvas.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "each", target: "item", label: "Each item" }),
    expect.objectContaining({ source: "item", target: "result", label: "Collection complete" }),
  ]));
});

test("a generated 101-step ERP workflow projects every editable node without truncation", () => {
  const steps = Array.from({ length: 101 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return { id: `scale_${ordinal}`, action: `qa_scale_read_${ordinal}`, description: `Scale ERP read ${ordinal}`, parameters: {} };
  });
  const canvas = workflowYamlToCanvas(dump({ name: "Large ERP workflow", trigger: { type: "manual" }, steps }));
  expect(canvas.nodes).toHaveLength(101); expect(canvas.edges).toHaveLength(100);
  expect(canvas.nodes[0]).toMatchObject({ id: "scale_001", data: { action: "qa_scale_read_001" } });
  expect(canvas.nodes[100]).toMatchObject({ id: "scale_101", data: { action: "qa_scale_read_101" } });
  expect(new Set(canvas.nodes.map(node => node.id)).size).toBe(101);
  expect(canvas.edges[99]).toMatchObject({ source: "scale_100", target: "scale_101" });
});
