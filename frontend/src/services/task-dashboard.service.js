import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const taskDashboardService = {
  async load(month, timezone, signal) {
    const value = unwrap(await apiClient.get("/dashboard/tasks", { params: { month, timezone }, signal }));
    const count = value => Number.isSafeInteger(value) && value >= 0;
    const task = value => typeof value?.id === "string" && ["run", "schedule", "occurrence"].includes(value.kind) && typeof value.name === "string" &&
      typeof value.status === "string" && typeof value.important === "boolean" && (value.at === null || typeof value.at === "string" && Number.isFinite(Date.parse(value.at))) &&
      (value.date === null || /^\d{4}-\d{2}-\d{2}$/.test(value.date)) && [value.workflowId, value.executionId].every(value => value === null || typeof value === "string" && value.length > 0);
    if (value?.profile !== "personal-task-dashboard/v1" || value.scope !== "personal" || value.month !== month || value.timezone !== timezone ||
        !Number.isFinite(Date.parse(value.generatedAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(value.today) || typeof value.truncated !== "boolean" ||
        !value.counts || !["today", "ongoing", "attention", "completedToday"].every(key => count(value.counts[key])) ||
        !value.dayCounts || typeof value.dayCounts !== "object" || Array.isArray(value.dayCounts) || Object.entries(value.dayCounts).some(([date, counts]) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(month) || !count(counts?.total) || !count(counts?.important) || counts.important > counts.total) ||
        !["events", "ongoing", "attention"].every(key => Array.isArray(value[key]) && value[key].every(task)))
      throw new Error("Saved dashboard tasks are unavailable. Reload to confirm their current state.");
    return value;
  },
};
