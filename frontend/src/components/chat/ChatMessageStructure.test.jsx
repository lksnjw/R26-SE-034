import { expect, test } from "@jest/globals";
import { readFile } from "node:fs/promises";

test("keeps chat message orchestration separate from visualisation and source provenance", async () => {
  const [message, visualisation] = await Promise.all([
    readFile(new URL("./ChatMessage.jsx", import.meta.url), "utf8"),
    readFile(new URL("./ChatMessageVisualisation.jsx", import.meta.url), "utf8"),
  ]);

  expect(message.split(/\r?\n/).length).toBeLessThanOrEqual(450);
  expect(visualisation.split(/\r?\n/).length).toBeLessThanOrEqual(225);
  expect(message).toContain('from "./ChatMessageVisualisation"');
  expect(message).not.toMatch(/function\s+(?:InlineBarChart|InlineLineChart|InlinePieChart|InlineVisTable|InlineVisualisation|InlineSources)\b/);
  expect(visualisation).toContain('from "./ReadableValue"');
  expect(visualisation).not.toMatch(/workflowService|saveWorkflowForCanvas|PendingGenerationApprovalCard/);
});
