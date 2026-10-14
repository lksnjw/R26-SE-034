/** @jest-environment jsdom */

import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";

jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
const { NextActionBanner, QueryResultPanel } = await import("./ChatArtifactPanel");

afterEach(cleanup);

test("validated candidate does not claim publication or execution readiness", () => {
  render(<NextActionBanner nextAction="execute" />);
  expect(screen.getByText("Candidate Validated")).toBeTruthy();
  expect(screen.getByText(/Publication, current readiness and any required approval/)).toBeTruthy();
  expect(screen.queryByText(/Ready to Execute/i)).toBeNull();
});

test.each([
  [undefined, "Preparation stopped before a complete answer was produced."],
  ["LIMIT_REACHED", "Preparation reached a configured bound."],
  ["PROVIDER_FAILED", "configured model provider failed"],
  ["CANCELLED", "Preparation was cancelled."],
])("early query stop uses the authoritative stop reason: %s", (stopReason, expected) => {
  render(<QueryResultPanel artifact={{ intent: "QUERY", boundHit: true, stopReason, sources: [] }} />);
  expect(screen.getByText(new RegExp(expected))).toBeTruthy();
  if (stopReason !== "LIMIT_REACHED") expect(screen.queryByText(/iteration or token limit/i)).toBeNull();
});
