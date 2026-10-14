/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IterationNodeEvidence from "./IterationNodeEvidence";
import { projectIterationEvidence } from "../../utils/iterationEvidence";
import { iterationFixture } from "../../utils/iterationEvidence.fixture";
afterEach(cleanup);
function fixture(count = 2) { const s = iterationFixture(count); return projectIterationEvidence(s.execution, s.timeline, s.context); }
test("item answers are lazy, readable and distinct next to the same source node", () => {
  const { container } = render(<IterationNodeEvidence model={fixture()} nodeId="lookup" />);
  expect(screen.getByText("each · item 1 · Read")).toBeTruthy(); expect(screen.getByText("each · item 2 · Read")).toBeTruthy(); expect(screen.queryByText("Answer 1")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Saved item answer" })[0]); expect(screen.getByText("Answer 1")).toBeTruthy(); expect(screen.queryByText("Answer 2")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Saved item answer" })[1]); expect(screen.getByText("Answer 2")).toBeTruthy(); expect(container.querySelector("pre")).toBeNull();
});
test("pagination bounds rendered item rows without losing later saved answers", () => {
  render(<IterationNodeEvidence model={fixture(60)} nodeId="lookup" />); expect(screen.getAllByRole("button", { name: "Saved item answer" })).toHaveLength(25);
  fireEvent.click(screen.getByRole("button", { name: "Next items" })); expect(screen.getByText("26–50 of 60")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next items" })); expect(screen.getAllByRole("button", { name: "Saved item answer" })).toHaveLength(10); expect(screen.getByText("each · item 60 · Read")).toBeTruthy();
});
test("unknown and unmatched rows never display supplied output as an answer", () => {
  const model = fixture(); Object.assign(model.nodes.lookup.rows[0], { status: "UNKNOWN", confirmed: true, output: undefined }); Object.assign(model.nodes.lookup.rows[1], { status: "UNCONFIRMED", confirmed: false, output: "untrusted" });
  render(<IterationNodeEvidence model={model} nodeId="lookup" />); expect(screen.queryByRole("button", { name: "Saved item answer" })).toBeNull(); expect(screen.queryByText("untrusted")).toBeNull(); expect(screen.getByText(/may have reached ERP/)).toBeTruthy();
});
test("empty confirmed aggregates are readable and are not missing answers", () => {
  render(<IterationNodeEvidence model={fixture(0)} nodeId="each" />); expect(screen.getByText("0 of 0 typed item values saved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Saved collection aggregate" })); expect(screen.getByText("No items")).toBeTruthy();
});
