/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WorkflowSchedulePanel from "./WorkflowSchedulePanel";
import { workflowScheduleService } from "../../services/workflow-schedule.service";
import { workflowService } from "../../services/workflow.service";

const h = `sha256:${"a".repeat(64)}`, binding = { profile: "workflow-report-window-input-binding/v1", startAtInput: "reportStartAt", endAtInput: "reportEndAt" };
const readiness = { published: true, publishedVersion: 2, contentHash: h, executionProfile: "sequential-operation-v1", compilation: { state: "CURRENT" },
  authoring: { inputSchema: { type: "object", properties: { report: { type: "string" }, reportStartAt: { type: "string" }, reportEndAt: { type: "string" } },
    required: ["report", "reportStartAt", "reportEndAt"], additionalProperties: false } } };
const empty = { profile: "workflow-schedule-view/v1", workflowId: "flow", schedule: null, occurrences: [], canManage: true, explanation: "No active schedule is confirmed." };
const saved = { profile: "workflow-daily-schedule/v1", id: "schedule-flow", workflowId: "flow", workflowVersion: 2, workflowHash: h, state: "ACTIVE", revision: 1,
  timezone: "Asia/Colombo", localTime: "09:00", reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 900,
  servicePrincipalId: "owner", input: { report: "invoices" }, reportWindowBinding: binding, nextRunAt: "2026-10-07T03:30:00.000Z", createdBy: { id: "owner", name: "Owner" },
  createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z", scheduleHash: h };
const occurrence = { profile: "workflow-schedule-occurrence/v1", id: "occurrence-one", scheduleId: "schedule-flow", scheduleRevision: 1,
  workflowId: "flow", workflowVersion: 2, workflowHash: h, scheduledFor: "2026-10-07T03:30:00.000Z", localDate: "2026-10-07", timezone: "Asia/Colombo",
  reportWindow: { profile: "workflow-report-window/v1", reportingPeriod: "previous-calendar-day", timezone: "Asia/Colombo", localDate: "2026-10-06",
    startAt: "2026-10-05T18:30:00.000Z", endAt: "2026-10-06T18:30:00.000Z" }, servicePrincipalId: "owner", state: "ADMITTED",
  createdAt: "2026-10-07T03:30:00.000Z", executionId: "run-one", admittedAt: "2026-10-07T03:30:01.000Z" };
beforeEach(() => { jest.spyOn(workflowScheduleService, "status").mockResolvedValue(empty); jest.spyOn(workflowScheduleService, "save").mockResolvedValue(saved);
  jest.spyOn(workflowService, "readiness").mockResolvedValue(readiness); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const selectWindowBinding = () => {
  fireEvent.change(screen.getByLabelText("Report start boundary input"), { target: { value: "reportStartAt" } });
  fireEvent.change(screen.getByLabelText("Report end boundary input"), { target: { value: "reportEndAt" } });
};

test("activates a readable daily schedule with explicit timezone, principal, period and schema-generated inputs", async () => {
  workflowScheduleService.status.mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...empty, schedule: saved, explanation: "Active and durable." });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText("No active schedule is confirmed.");
  fireEvent.change(screen.getByLabelText("Schedule timezone"), { target: { value: "Asia/Colombo" } });
  fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "previous-calendar-day" } });
  selectWindowBinding();
  fireEvent.click(screen.getByRole("button", { name: "Set report" }));
  fireEvent.change(screen.getByLabelText("Occurrence inputs · report"), { target: { value: "invoices" } });
  fireEvent.click(screen.getByRole("button", { name: "Activate daily schedule" }));
  await screen.findByText(/Daily schedule active/); expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({
    profile: "workflow-calendar-schedule-command/v2", cadence: "daily", workflowVersion: 2, workflowHash: h, enabled: true, timezone: "Asia/Colombo",
    servicePrincipalId: "owner", reportingPeriod: "previous-calendar-day", input: { report: "invoices" }, reportWindowBinding: binding }));
  expect(screen.queryByLabelText("Occurrence inputs · reportStartAt")).toBeNull();
  expect(document.querySelector("pre")).toBeNull();
});

test("lost save acknowledgement locks controls until authoritative reload", async () => {
  workflowScheduleService.save.mockRejectedValueOnce(new Error("lost acknowledgement")); render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  const activate = await screen.findByRole("button", { name: "Activate daily schedule" }); selectWindowBinding(); fireEvent.click(activate);
  await screen.findByText(/outcome is unconfirmed/); expect(screen.getByRole("button", { name: "Activate daily schedule" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload status" })); await screen.findByText(/Authoritative schedule reloaded/);
  expect(workflowScheduleService.save).toHaveBeenCalledTimes(1);
});

test("does not offer activation for an unpublished or unsupported workflow", async () => {
  workflowService.readiness.mockResolvedValue({ ...readiness, published: false, executionProfile: "sequential-read-v1" });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText(/Legacy trigger text is not an active schedule/);
  expect(screen.getByRole("button", { name: "Activate daily schedule" })).toBeDisabled(); expect(workflowScheduleService.save).not.toHaveBeenCalled();
});

test("a legacy active schedule without a window binding can still be paused", async () => {
  const legacy = { ...saved, reportWindowBinding: null };
  workflowScheduleService.status.mockResolvedValue({ ...empty, schedule: legacy, explanation: "Legacy schedule requires a new revision." });
  workflowScheduleService.save.mockResolvedValue({ ...legacy, state: "PAUSED", revision: 2, nextRunAt: null });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause schedule" }));
  await screen.findByText(/Schedule paused/);
  expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({ enabled: false, reportWindowBinding: null }));
});

test("shows the immutable local report day and exact UTC boundaries for an occurrence", async () => {
  workflowScheduleService.status.mockResolvedValue({ ...empty, schedule: saved, occurrences: [occurrence], explanation: "Active and durable." });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  expect(await screen.findByText(/Report period 2026-10-06/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open execution" }).getAttribute("href")).toBe("/executions/run-one");
});

test("activates a weekly calendar with an explicit local weekday and matching report period", async () => {
  const weekly = { ...saved, profile: "workflow-calendar-schedule/v2", cadence: "weekly", dayOfWeek: 3, reportingPeriod: "previous-calendar-week" };
  workflowScheduleService.status.mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...empty, schedule: weekly, explanation: "Active and durable." });
  workflowScheduleService.save.mockResolvedValue(weekly);
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText("No active schedule is confirmed.");
  fireEvent.change(screen.getByLabelText("Schedule cadence"), { target: { value: "weekly" } });
  fireEvent.change(screen.getByLabelText("Weekly local weekday"), { target: { value: "3" } });
  expect(screen.getByLabelText("Reporting period")).toHaveValue("previous-calendar-week");
  selectWindowBinding(); fireEvent.click(screen.getByRole("button", { name: "Activate weekly schedule" }));
  await screen.findByText(/Weekly schedule active/);
  expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({ profile: "workflow-calendar-schedule-command/v2",
    cadence: "weekly", dayOfWeek: 3, reportingPeriod: "previous-calendar-week" }));
});

test("requires a safe monthly day and derives the previous-month report period", async () => {
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText("No active schedule is confirmed.");
  fireEvent.change(screen.getByLabelText("Schedule cadence"), { target: { value: "monthly" } });
  selectWindowBinding();
  const day = screen.getByLabelText("Monthly local day"), activate = screen.getByRole("button", { name: "Activate monthly schedule" });
  expect(screen.getByLabelText("Reporting period")).toHaveValue("previous-calendar-month");
  fireEvent.change(day, { target: { value: "29" } }); expect(activate).toBeDisabled();
  fireEvent.change(day, { target: { value: "15" } }); expect(activate).toBeEnabled(); fireEvent.click(activate);
  await screen.findByText(/Monthly schedule active/);
  expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({ cadence: "monthly", dayOfMonth: 15,
    reportingPeriod: "previous-calendar-month" }));
});
