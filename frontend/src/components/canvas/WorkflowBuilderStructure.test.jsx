/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { render, screen } from "@testing-library/react";
import React from "react";
import { ExecutionResultPanel } from "./WorkflowBuilderPanels.jsx";

test("keeps builder orchestration separate from catalog, projection, and presentation components", async () => {
  const [canvas, catalog, panels, projection] = await Promise.all([
    readFile(new URL("./WorkflowBuilderCanvas.jsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkflowBuilderCatalog.jsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkflowBuilderPanels.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../utils/structuredCanvasProjection.js", import.meta.url), "utf8"),
  ]);
  expect(canvas.split(/\r?\n/).length).toBeLessThanOrEqual(500);
  expect(catalog.split(/\r?\n/).length).toBeLessThanOrEqual(225);
  expect(panels.split(/\r?\n/).length).toBeLessThanOrEqual(225);
  expect(projection.split(/\r?\n/).length).toBeLessThanOrEqual(150);
  expect(canvas).toContain('from "./WorkflowBuilderCatalog"');
  expect(canvas).toContain('from "./WorkflowBuilderPanels"');
  expect(canvas).not.toMatch(/function\s+projectStructuredControlFlow\b/);
  expect(canvas).not.toMatch(/function\s+(?:WorkflowToolNode|BuilderSidebar|ExecutionResultPanel|BuilderHeader|BuilderLoadState)\b/);
});

test("renders structured execution output as readable fields without raw JSON", () => {
  const { container } = render(
    <ExecutionResultPanel
      result={{
        execution: {
          id: "run-readable",
          status: "DONE",
          finalOutput: {
            invoice_number: "INV-1042",
            customer: { name: "Acme Lanka", active: true },
          },
        },
        timeline: [],
      }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("invoice number")).not.toBeNull();
  expect(screen.getByText("INV-1042")).not.toBeNull();
  expect(screen.getByText("customer")).not.toBeNull();
  expect(screen.getByText("Acme Lanka")).not.toBeNull();
  expect(container.querySelector("pre")).toBeNull();
});
