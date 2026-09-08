import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const deny = () => { throw new Error("The server returned an invalid workflow schedule contract"); };
function schedule(value, workflowId) {
  if (value === null) return null;
  if (!object(value) || value.profile !== "workflow-daily-schedule/v1" || value.workflowId !== workflowId || !id(value.id) ||
      !Number.isSafeInteger(value.workflowVersion) || value.workflowVersion < 1 || !hash(value.workflowHash) || !["ACTIVE", "PAUSED", "BLOCKED"].includes(value.state) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !id(value.timezone) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.localTime) ||
      !id(value.reportingPeriod) || !["SKIP", "FIRE_ONCE"].includes(value.misfirePolicy) || !Number.isSafeInteger(value.misfireGraceSeconds) ||
      !id(value.servicePrincipalId) || !object(value.input) || value.nextRunAt !== null && !date(value.nextRunAt) || !date(value.createdAt) || !date(value.updatedAt) || !hash(value.scheduleHash)) deny();
  return value;
}
function occurrence(value, scheduleId) {
  if (!object(value) || value.profile !== "workflow-schedule-occurrence/v1" || value.scheduleId !== scheduleId || !id(value.id) ||
      !["ADMITTING", "ADMITTED", "SKIPPED", "BLOCKED"].includes(value.state) || !date(value.scheduledFor) || !id(value.localDate) || !id(value.timezone) ||
      !id(value.servicePrincipalId) || !date(value.createdAt) || value.executionId !== undefined && !id(value.executionId) || value.admittedAt !== undefined && !date(value.admittedAt)) deny();
  return value;
}
function view(value, workflowId) {
  if (!object(value) || value.profile !== "workflow-schedule-view/v1" || value.workflowId !== workflowId || typeof value.canManage !== "boolean" ||
      typeof value.explanation !== "string" || !Array.isArray(value.occurrences)) deny();
  const saved = schedule(value.schedule, workflowId), occurrences = value.occurrences.map(item => occurrence(item, saved?.id));
  if (!saved && occurrences.length) deny();
  return { ...value, schedule: saved, occurrences };
}

export const workflowScheduleService = {
  async status(workflowId) { return view(unwrap(await apiClient.get(`/workflows/${encodeURIComponent(workflowId)}/schedule`)), workflowId); },
  async save(workflowId, command) {
    if (!object(command) || command.profile !== "workflow-daily-schedule-command/v1" || command.workflowHash === undefined) deny();
    return schedule(unwrap(await apiClient.put(`/workflows/${encodeURIComponent(workflowId)}/schedule`, command)), workflowId);
  },
};
