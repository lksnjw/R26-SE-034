import { expect, test } from "@jest/globals";
import { parseWorkflowPreview, workflowArtifacts } from "./workflowPreview";

test("parses nested parameters without flattening control flow", () => {
  const preview = parseWorkflowPreview("name: Invoice report\nsteps:\n  - id: fetch\n    action: erp.list\n    params:\n      filters:\n        status: open\n  - id: decide\n    kind: condition\n    then:\n      - id: send\n        action: email.send\n");
  expect(preview.error).toBe("");
  expect(preview.steps).toHaveLength(2);
  expect(preview.steps[0].source.params.filters.status).toBe("open");
  expect(preview.steps[1].source.then[0].id).toBe("send");
});

test("rejects malformed YAML and duplicate IDs", () => {
  expect(parseWorkflowPreview("steps: [").error).toMatch(/Cannot preview/);
  expect(parseWorkflowPreview("steps:\n - id: same\n - id: same").error).toMatch(/Duplicate/);
  expect(parseWorkflowPreview("nodes: []").error).toMatch(/no supported steps/);
});

test("keeps previous workflow drafts when a query answer arrives", () => {
  const artifact = { selected_workflow_yaml: "steps: []", intent: "WORKFLOW" };
  expect(workflowArtifacts([{ id: "draft", artifacts: artifact }, { id: "answer", artifacts: { intent: "QUERY" } }])).toEqual([{ key: "draft", artifact }]);
});

test("keeps durable saved-workflow references from node requests and proposals", () => {
  expect(workflowArtifacts([
    { id: "request", artifacts: { intent: "NODE_EDIT_REQUEST", workflowId: "report", nodeId: "read" } },
    { id: "proposal", artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal: { workflowId: "report", nodeId: "read" } } },
  ])).toEqual([
    { key: "request", artifact: { intent: "NODE_EDIT_REQUEST", workflowId: "report", nodeId: "read" } },
    { key: "proposal", artifact: { intent: "NODE_PATCH_PROPOSAL", workflowId: "report", proposal: { workflowId: "report", nodeId: "read" } } },
  ]);
});

test("bounds preview source and step count", () => {
  expect(parseWorkflowPreview("x".repeat(200001)).error).toMatch(/too large/);
  expect(parseWorkflowPreview(`steps:\n${Array.from({ length: 201 }, (_, i) => ` - id: s${i}`).join("\n")}`).error).toMatch(/limit/);
});
