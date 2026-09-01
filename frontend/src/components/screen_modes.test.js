import { expect, test } from "@jest/globals";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BuilderModeControls from "./canvas/BuilderModeControls.js";
import WorkflowActionControls from "./workflows/WorkflowActionControls.js";

test("canvas read-only mode hides deploy and run controls", () => {
  const clientMarkup = renderToStaticMarkup(React.createElement(BuilderModeControls, { readOnly: true }));
  expect(clientMarkup).toContain("Read-only preview");
  expect(clientMarkup).not.toContain("<button");

  const adminMarkup = renderToStaticMarkup(React.createElement(BuilderModeControls, { readOnly: false }));
  expect(adminMarkup).toContain("Review &amp; publish draft");
  expect(adminMarkup).toContain("Run published workflow");
});

test("client workflow actions render Run without export", () => {
  const clientMarkup = renderToStaticMarkup(React.createElement(WorkflowActionControls, { canRun: true, canExport: false }));
  expect(clientMarkup).toContain("Run");
  expect(clientMarkup).not.toContain("Export YAML");

  const adminMarkup = renderToStaticMarkup(React.createElement(WorkflowActionControls, { canRun: true, canExport: true }));
  expect(adminMarkup).toContain("Run");
  expect(adminMarkup).toContain("Export YAML");
});
