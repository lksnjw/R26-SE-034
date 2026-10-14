import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { taskDashboardService } from "./task-dashboard.service";
afterEach(() => jest.restoreAllMocks());
const view = () => ({ profile: "personal-task-dashboard/v1", scope: "personal", generatedAt: "2026-10-08T20:00:00Z", month: "2026-10", timezone: "UTC", today: "2026-10-08",
  counts: { today: 0, ongoing: 0, attention: 0, completedToday: 0 }, dayCounts: {}, events: [], ongoing: [], attention: [], truncated: false });
test("one cancellable read loads the personal dashboard without querying global metrics", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: view() } }), signal = new AbortController().signal;
  expect(await taskDashboardService.load("2026-10", "UTC", signal)).toEqual(view());
  expect(get).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledWith("/dashboard/tasks", { params: { month: "2026-10", timezone: "UTC" }, signal });
});
test.each(["wrong month", "wrong scope", "negative count", "invalid marker", "invalid task"])("malformed %s is not presented as saved data", async damage => {
  const value = view();
  if (damage === "wrong month") value.month = "2026-11";
  if (damage === "wrong scope") value.scope = "all-users";
  if (damage === "negative count") value.counts.today = -1;
  if (damage === "invalid marker") value.dayCounts["2026-10-08"] = { total: 1, important: 2 };
  if (damage === "invalid task") value.events = [{ id: "forged", kind: "run", name: "Report", status: "DONE" }];
  jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: value } });
  await expect(taskDashboardService.load("2026-10", "UTC")).rejects.toThrow(/unavailable/);
});
