import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const deny = () => { throw new Error("The server returned an invalid workflow schedule contract"); };
const periods = { daily: "previous-calendar-day", weekly: "previous-calendar-week", monthly: "previous-calendar-month" };
const validCadence = value => ["daily", "weekly", "monthly"].includes(value);
const validRecurrence = value => value.profile === "workflow-daily-schedule/v1" ? value.reportingPeriod === "previous-calendar-day" :
  value.profile === "workflow-calendar-schedule/v2" && validCadence(value.cadence) && value.reportingPeriod === periods[value.cadence] &&
  (value.cadence === "weekly" ? Number.isSafeInteger(value.dayOfWeek) && value.dayOfWeek >= 1 && value.dayOfWeek <= 7 && value.dayOfMonth === undefined : value.dayOfWeek === undefined) &&
  (value.cadence === "monthly" ? Number.isSafeInteger(value.dayOfMonth) && value.dayOfMonth >= 1 && value.dayOfMonth <= 28 && value.dayOfWeek === undefined : value.dayOfMonth === undefined);
const reportWindowBinding = value => object(value) && value.profile === "workflow-report-window-input-binding/v1" && id(value.startAtInput) && id(value.endAtInput) && value.startAtInput !== value.endAtInput;
function schedule(value, workflowId) {
  if (value === null) return null;
  if (!object(value) || !validRecurrence(value) || value.workflowId !== workflowId || !id(value.id) ||
      !Number.isSafeInteger(value.workflowVersion) || value.workflowVersion < 1 || !hash(value.workflowHash) || !["ACTIVE", "PAUSED", "BLOCKED"].includes(value.state) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !id(value.timezone) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.localTime) ||
      !["SKIP", "FIRE_ONCE"].includes(value.misfirePolicy) || !Number.isSafeInteger(value.misfireGraceSeconds) ||
      !id(value.servicePrincipalId) || !object(value.input) || value.nextRunAt !== null && !date(value.nextRunAt) || !date(value.createdAt) || !date(value.updatedAt) || !hash(value.scheduleHash) ||
      value.reportWindowBinding !== null && !reportWindowBinding(value.reportWindowBinding)) deny();
  return value;
}
function occurrence(value, saved) {
  const window = value?.reportWindow;
  const multiDayWindow = window?.reportingPeriod === "previous-calendar-week" || window?.reportingPeriod === "previous-calendar-month";
  if (!object(value) || value.profile !== "workflow-schedule-occurrence/v1" || value.scheduleId !== saved?.id || !id(value.id) ||
      !["ADMITTING", "ADMITTED", "SKIPPED", "BLOCKED"].includes(value.state) || !date(value.scheduledFor) || !id(value.localDate) || !id(value.timezone) ||
      !id(value.servicePrincipalId) || !date(value.createdAt) || value.executionId !== undefined && !id(value.executionId) || value.admittedAt !== undefined && !date(value.admittedAt) ||
      window !== null && (!object(window) || window.profile !== "workflow-report-window/v1" || window.reportingPeriod !== saved?.reportingPeriod || window.timezone !== value.timezone ||
      !/^\d{4}-\d{2}-\d{2}$/.test(window.localDate) || multiDayWindow !== /^\d{4}-\d{2}-\d{2}$/.test(window.localEndDate || "") ||
      !date(window.startAt) || !date(window.endAt) || Date.parse(window.startAt) >= Date.parse(window.endAt))) deny();
  return value;
}
function view(value, workflowId) {
  if (!object(value) || value.profile !== "workflow-schedule-view/v1" || value.workflowId !== workflowId || typeof value.canManage !== "boolean" ||
      typeof value.explanation !== "string" || !Array.isArray(value.occurrences)) deny();
  const saved = schedule(value.schedule, workflowId), occurrences = value.occurrences.map(item => occurrence(item, saved));
  if (!saved && occurrences.length) deny();
  return { ...value, schedule: saved, occurrences };
}

export const workflowScheduleService = {
  async status(workflowId) { return view(unwrap(await apiClient.get(`/workflows/${encodeURIComponent(workflowId)}/schedule`)), workflowId); },
  async save(workflowId, command) {
    const legacy = command?.profile === "workflow-daily-schedule-command/v1" && command.reportingPeriod === "previous-calendar-day";
    const calendar = command?.profile === "workflow-calendar-schedule-command/v2" && validCadence(command.cadence) && command.reportingPeriod === periods[command.cadence] &&
      (command.cadence === "weekly" ? Number.isSafeInteger(command.dayOfWeek) && command.dayOfWeek >= 1 && command.dayOfWeek <= 7 && command.dayOfMonth === undefined : command.dayOfWeek === undefined) &&
      (command.cadence === "monthly" ? Number.isSafeInteger(command.dayOfMonth) && command.dayOfMonth >= 1 && command.dayOfMonth <= 28 && command.dayOfWeek === undefined : command.dayOfMonth === undefined);
    if (!object(command) || !legacy && !calendar || command.workflowHash === undefined || command.enabled && !reportWindowBinding(command.reportWindowBinding)) deny();
    return schedule(unwrap(await apiClient.put(`/workflows/${encodeURIComponent(workflowId)}/schedule`, command)), workflowId);
  },
};
