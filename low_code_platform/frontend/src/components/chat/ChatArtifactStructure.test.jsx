import { expect, test } from "@jest/globals";
import { readFile } from "node:fs/promises";

test("keeps artifact intent composition separate from presentation responsibilities", async () => {
  const [panel, primitives, retrieval, status, query] = await Promise.all([
    readFile(new URL("./ChatArtifactPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("./ChatArtifactPrimitives.jsx", import.meta.url), "utf8"),
    readFile(new URL("./ChatArtifactRetrieval.jsx", import.meta.url), "utf8"),
    readFile(new URL("./ChatArtifactStatus.jsx", import.meta.url), "utf8"),
    readFile(new URL("./ChatQueryResultPanel.jsx", import.meta.url), "utf8"),
  ]);

  expect(panel.split(/\r?\n/).length).toBeLessThanOrEqual(275);
  expect(primitives.split(/\r?\n/).length).toBeLessThanOrEqual(125);
  expect(retrieval.split(/\r?\n/).length).toBeLessThanOrEqual(200);
  expect(status.split(/\r?\n/).length).toBeLessThanOrEqual(100);
  expect(query.split(/\r?\n/).length).toBeLessThanOrEqual(150);
  for (const owner of ["ChatArtifactPrimitives", "ChatArtifactRetrieval", "ChatArtifactStatus", "ChatQueryResultPanel"]) {
    expect(panel).toContain(`from "./${owner}"`);
  }
  expect(panel).not.toMatch(/function\s+(?:Collapsible|ToolCard|RuleCard|ExampleCard|NextActionBanner|MiniBarChart|QueryResultPanel)\b/);
  expect(query).not.toMatch(/workflowService|saveWorkflowForCanvas|usePermissions/);
  expect(status).not.toMatch(/workflowService|saveWorkflowForCanvas|ReadableValue/);
});
