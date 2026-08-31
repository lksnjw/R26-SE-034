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

test("bounds preview source and step count", () => {
  expect(parseWorkflowPreview("x".repeat(200001)).error).toMatch(/too large/);
  expect(parseWorkflowPreview(`steps:\n${Array.from({ length: 201 }, (_, i) => ` - id: s${i}`).join("\n")}`).error).toMatch(/limit/);
});
