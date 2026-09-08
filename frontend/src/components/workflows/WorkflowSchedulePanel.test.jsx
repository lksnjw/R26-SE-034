/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WorkflowSchedulePanel from "./WorkflowSchedulePanel";
import { workflowScheduleService } from "../../services/workflow-schedule.service";
import { workflowService } from "../../services/workflow.service";

const h = `sha256:${"a".repeat(64)}`, readiness = { published: true, publishedVersion: 2, contentHash: h, executionProfile: "sequential-operation-v1",
  compilation: { state: "CURRENT" }, authoring: { inputSchema: { type: "object", properties: { report: { type: "string" } }, required: ["report"], additionalProperties: false } } };
const empty = { profile: "workflow-schedule-view/v1", workflowId: "flow", schedule: null, occurrences: [], canManage: true, explanation: "No active schedule is confirmed." };
const saved = { profile: "workflow-daily-schedule/v1", id: "schedule-flow", workflowId: "flow", workflowVersion: 2, workflowHash: h, state: "ACTIVE", revision: 1,
  timezone: "Asia/Colombo", localTime: "09:00", reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 900,
  servicePrincipalId: "owner", input: { report: "invoices" }, nextRunAt: "2026-10-07T03:30:00.000Z", createdBy: { id: "owner", name: "Owner" },
  createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z", scheduleHash: h };
beforeEach(() => { jest.spyOn(workflowScheduleService, "status").mockResolvedValue(empty); jest.spyOn(workflowScheduleService, "save").mockResolvedValue(saved);
  jest.spyOn(workflowService, "readiness").mockResolvedValue(readiness); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test("activates a readable daily schedule with explicit timezone, principal, period and schema-generated inputs", async () => {
  workflowScheduleService.status.mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...empty, schedule: saved, explanation: "Active and durable." });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText("No active schedule is confirmed.");
  fireEvent.change(screen.getByLabelText("Schedule timezone"), { target: { value: "Asia/Colombo" } });
  fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "previous-calendar-day" } });
  fireEvent.click(screen.getByRole("button", { name: "Set report" }));
  fireEvent.change(screen.getByLabelText("Occurrence inputs · report"), { target: { value: "invoices" } });
  fireEvent.click(screen.getByRole("button", { name: "Activate daily schedule" }));
  await screen.findByText(/Daily schedule active/); expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({
    profile: "workflow-daily-schedule-command/v1", workflowVersion: 2, workflowHash: h, enabled: true, timezone: "Asia/Colombo",
    servicePrincipalId: "owner", reportingPeriod: "previous-calendar-day", input: { report: "invoices" } }));
  expect(document.querySelector("pre")).toBeNull();
});

test("lost save acknowledgement locks controls until authoritative reload", async () => {
  workflowScheduleService.save.mockRejectedValueOnce(new Error("lost acknowledgement")); render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  const activate = await screen.findByRole("button", { name: "Activate daily schedule" }); fireEvent.click(activate);
  await screen.findByText(/outcome is unconfirmed/); expect(screen.getByRole("button", { name: "Activate daily schedule" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload status" })); await screen.findByText(/Authoritative schedule reloaded/);
  expect(workflowScheduleService.save).toHaveBeenCalledTimes(1);
});

test("does not offer activation for an unpublished or unsupported workflow", async () => {
  workflowService.readiness.mockResolvedValue({ ...readiness, published: false, executionProfile: "sequential-read-v1" });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText(/Legacy trigger text is not an active schedule/);
  expect(screen.getByRole("button", { name: "Activate daily schedule" })).toBeDisabled(); expect(workflowScheduleService.save).not.toHaveBeenCalled();
});
