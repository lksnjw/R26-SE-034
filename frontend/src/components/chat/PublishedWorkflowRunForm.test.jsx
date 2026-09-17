/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PublishedWorkflowRunForm from "./PublishedWorkflowRunForm";
afterEach(cleanup);

test("read-and-model publication has truthful read-only wording and keeps controls gated", () => {
  const run = jest.fn();
  render(<PublishedWorkflowRunForm record={{ executionProfile: "sequential-operation-v1", effectProfile: "read-only", operation_job_admission: "operation-job/v1" }} runInput={{}} onInput={jest.fn()} onRun={run} submitting disabled unconfirmed />);
  expect(screen.getByText("Run published read-and-model workflow")).toBeTruthy();
  expect(screen.getByText(/no ERP write or notification is part/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Results require saved acknowledgements");
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Run published version" })); expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: /outcome unconfirmed/ }).getAttribute("href")).toBe("/executions");
});

test.each(["contains-effects", "unknown", undefined])("non-read-only operation %s retains independent approval wording", effectProfile => {
  render(<PublishedWorkflowRunForm record={{ executionProfile: "sequential-operation-v1", effectProfile }} runInput={{}} onInput={jest.fn()} onRun={jest.fn()} />);
  expect(screen.getByText("Run published operation workflow")).toBeTruthy();
  expect(screen.getByText(/Every write waits for independent exact approval/)).toBeTruthy();
  expect(screen.queryByText(/no ERP write or notification is part/)).toBeNull();
});
