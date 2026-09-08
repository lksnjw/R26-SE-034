import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { workflowScheduleService } from "./workflow-schedule.service";

const h = `sha256:${"a".repeat(64)}`, envelope = data => ({ data: { success: true, data } });
const saved = () => ({ profile: "workflow-daily-schedule/v1", id: "schedule-flow/one", workflowId: "flow/one", workflowVersion: 2, workflowHash: h,
  state: "ACTIVE", revision: 1, timezone: "Asia/Colombo", localTime: "09:00", reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP",
  misfireGraceSeconds: 900, servicePrincipalId: "service-user", input: {}, nextRunAt: "2026-10-07T03:30:00.000Z", createdBy: { id: "owner", name: "Owner" },
  createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z", scheduleHash: h });
const view = () => ({ profile: "workflow-schedule-view/v1", workflowId: "flow/one", schedule: saved(), occurrences: [{ profile: "workflow-schedule-occurrence/v1",
  id: "occurrence-one", scheduleId: "schedule-flow/one", scheduleRevision: 1, workflowId: "flow/one", workflowVersion: 2, workflowHash: h,
  scheduledFor: "2026-10-07T03:30:00.000Z", localDate: "2026-10-07", timezone: "Asia/Colombo", servicePrincipalId: "service-user", state: "ADMITTED",
  reportWindow: { profile: "workflow-report-window/v1", reportingPeriod: "previous-calendar-day", timezone: "Asia/Colombo", localDate: "2026-10-06",
    startAt: "2026-10-05T18:30:00.000Z", endAt: "2026-10-06T18:30:00.000Z" },
  createdAt: "2026-10-07T03:30:00.000Z", executionId: "run-one", admittedAt: "2026-10-07T03:30:01.000Z" }],
  canManage: true, explanation: "Durable schedule." });
afterEach(() => jest.restoreAllMocks());

test("loads encoded authoritative schedule and validates readable occurrence identity", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue(envelope(view()));
  expect(await workflowScheduleService.status("flow/one")).toEqual(view()); expect(get).toHaveBeenCalledWith("/workflows/flow%2Fone/schedule");
  const legacy = { ...view(), occurrences: [{ ...view().occurrences[0], reportWindow: null }] };
  get.mockResolvedValue(envelope(legacy)); expect(await workflowScheduleService.status("flow/one")).toEqual(legacy);
  get.mockResolvedValue(envelope({ ...view(), occurrences: [{ ...view().occurrences[0], scheduleId: "other" }] }));
  await expect(workflowScheduleService.status("flow/one")).rejects.toThrow(/invalid workflow schedule/);
  get.mockResolvedValue(envelope({ ...view(), occurrences: [{ ...view().occurrences[0], reportWindow: { ...view().occurrences[0].reportWindow, timezone: "UTC" } }] }));
  await expect(workflowScheduleService.status("flow/one")).rejects.toThrow(/invalid workflow schedule/);
});

test("saves only the explicit schedule command and rejects malformed server state", async () => {
  const command = { profile: "workflow-daily-schedule-command/v1", baseRevision: 0, workflowVersion: 2, workflowHash: h, enabled: true,
    timezone: "Asia/Colombo", localTime: "09:00", reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 900,
    servicePrincipalId: "service-user", input: {} };
  const put = jest.spyOn(apiClient, "put").mockResolvedValue(envelope(saved())); expect(await workflowScheduleService.save("flow/one", command)).toEqual(saved());
  expect(put).toHaveBeenCalledWith("/workflows/flow%2Fone/schedule", command);
  put.mockResolvedValue(envelope({ ...saved(), nextRunAt: "not-a-date" })); await expect(workflowScheduleService.save("flow/one", command)).rejects.toThrow();
});
