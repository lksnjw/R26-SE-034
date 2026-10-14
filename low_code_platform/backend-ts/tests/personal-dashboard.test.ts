import { expect, test } from "vitest";
import { Repository, type Execution, type WorkflowSchedule } from "../src/repository/store.js";
import type { Workflow } from "../src/models/schemas.js";
import type { CurrentUser } from "../src/http/handlers/common.js";
import { personalDashboard } from "../src/http/personal-dashboard.js";

const now = new Date("2026-10-08T20:00:00Z");
const actor = (permissions = ["workflow:read_own", "execution:read_own"]) => ({ id: "me", permissions } as CurrentUser);
const run = (id: string, status = "RUNNING", owner = "me", startedAt = now.toISOString()) => ({ id, status, workflowId: "flow", workflowName: "Daily invoice report", startedBy: { id: owner, name: owner },
  startedAt, completedAt: status === "DONE" ? now.toISOString() : null, stepOutputs: { secret: "private ERP answer" }, runtimeApprovalSecret: { credentials: "hidden" } } as unknown as Execution);
async function state() {
  const state = await new Repository(null).snapshot();
  state.workflows = { flow: { id: "flow", name: "Daily invoice report", owner: { id: "me", name: "Me" }, assignedUserIds: [] } as unknown as Workflow };
  state.executions = {}; state.schedules = {}; state.scheduleOccurrences = {};
  return state;
}
const schedule = (state: "ACTIVE" | "PAUSED" | "BLOCKED" = "ACTIVE") => ({ id: "schedule-flow", workflowId: "flow", revision: 1, state, nextRunAt: "2026-10-09T01:00:00Z", timezone: "Asia/Colombo", cadence: "daily",
  servicePrincipalId: "service", createdBy: { id: "me", name: "Me" }, input: { password: "private" }, lastError: "private connector exception" } as unknown as WorkflowSchedule);

test.each(["UTC", "Asia/Colombo"])("personal tasks use %s dates, not browser/UTC assumptions", async timezone => {
  const s = await state(); s.executions.one = run("one");
  const view = personalDashboard(s, actor(), "2026-10", timezone, now), date = timezone === "UTC" ? "2026-10-08" : "2026-10-09";
  expect(view.today).toBe(date); expect(view.events[0]!.date).toBe(date); expect(view.dayCounts[date]).toEqual({ total: 1, important: 0 });
});
test("even an administrator sees personal runs, never another user's ERP answers", async () => {
  const s = await state(); s.executions.mine = run("mine"); s.executions.other = run("other", "AWAITING_APPROVAL", "other");
  const view = personalDashboard(s, actor(["workflow:read"]), "2026-10", "UTC", now);
  expect(view.counts).toMatchObject({ today: 1, ongoing: 1, attention: 0 }); expect(view.events.map(value => value.id)).toEqual(["run:mine"]);
  expect(JSON.stringify(view)).not.toMatch(/private ERP|credentials|stepOutputs|runtimeApprovalSecret|startedBy/);
});
test("workflow-read-own alone cannot disclose personal execution records", async () => {
  const s = await state(); s.executions.mine = run("mine"); expect(personalDashboard(s, actor(["workflow:read_own"]), "2026-10", "UTC", now).events).toEqual([]);
});
test("execution-only access never offers a workflow link or schedule", async () => {
  const s = await state(); s.executions.mine = run("mine"); s.schedules.one = schedule();
  const view = personalDashboard(s, actor(["execution:read_own"]), "2026-10", "UTC", now); expect(view.events).toHaveLength(1); expect(view.events[0]!.workflowId).toBeNull();
});
test("ongoing and attention are separate; a completed task is not still running", async () => {
  const s = await state(); for (const status of ["RUNNING", "PENDING", "DONE", "AWAITING_APPROVAL", "RECOVERY_REQUIRED", "UNKNOWN"]) s.executions[status] = run(status, status);
  const view = personalDashboard(s, actor(), "2026-10", "UTC", now);
  expect(view.counts).toEqual({ today: 6, ongoing: 2, attention: 3, completedToday: 1 }); expect(view.dayCounts["2026-10-08"]).toEqual({ total: 6, important: 3 });
});
test("completion is counted on completedAt, and today metrics do not disappear when browsing another month", async () => {
  const s = await state(); s.executions.old = run("old", "DONE", "me", "2026-09-30T01:00:00Z"); s.executions.mine = run("mine");
  const view = personalDashboard(s, actor(), "2026-11", "UTC", now);
  expect(view.counts).toEqual({ today: 1, ongoing: 1, attention: 0, completedToday: 1 }); expect(view.events).toEqual([]); expect(view.ongoing).toHaveLength(1);
});
test("only the confirmed next schedule date is marked, never all assumed future daily runs", async () => {
  const s = await state(); s.schedules.one = schedule();
  const view = personalDashboard(s, actor(), "2026-10", "UTC", now);
  expect(Object.keys(view.dayCounts)).toEqual(["2026-10-09"]); expect(view.events[0]).toMatchObject({ kind: "schedule", status: "ACTIVE", executionId: null });
  expect(JSON.stringify(view)).not.toMatch(/password|private connector|servicePrincipal|input/);
});
test("paused schedules are not upcoming; blocked schedules remain in the attention list without a fabricated date", async () => {
  const s = await state(); s.schedules.paused = schedule("PAUSED"); s.schedules.blocked = { ...schedule("BLOCKED"), id: "blocked" };
  const view = personalDashboard(s, actor(), "2026-10", "UTC", now);
  expect(view.events).toEqual([]); expect(view.attention).toMatchObject([{ kind: "schedule", at: null, date: null, important: true }]);
});
test("an admitted occurrence with a visible run is counted once; other people's execution IDs are not linked", async () => {
  const s = await state(); s.schedules.one = schedule("PAUSED"); s.executions.mine = run("mine");
  for (const id of ["mine", "other"]) s.scheduleOccurrences[id] = { profile: "workflow-schedule-occurrence/v1", id, scheduleId: "schedule-flow", executionId: id, scheduledFor: now.toISOString(), state: "ADMITTED" } as any;
  const view = personalDashboard(s, actor(), "2026-10", "UTC", now);
  expect(view.counts.today).toBe(2); expect(view.events.map(task => task.id)).toEqual(["occurrence:other", "run:mine"]);
  expect(view.events[0]!.executionId).toBeNull();
});
test("unrelated schedules and occurrence names are hidden even with broad workflow-read", async () => {
  const s = await state(); s.workflows.flow!.owner.id = "other"; s.schedules.one = { ...schedule(), createdBy: { id: "other", name: "Other" } };
  expect(personalDashboard(s, actor(["workflow:read"]), "2026-10", "UTC", now).events).toEqual([]);
});
test("a claimed next occurrence is not counted twice while admission waits; different revisions remain distinct", async () => {
  const s = await state(); s.schedules.one = schedule();
  s.scheduleOccurrences.one = { profile: "workflow-schedule-occurrence/v1", id: "one", scheduleId: "schedule-flow", scheduleRevision: 1, scheduledFor: s.schedules.one.nextRunAt!, state: "ADMITTING" } as any;
  const view = personalDashboard(s, actor(), "2026-10", "UTC", now); expect(view.events).toHaveLength(1); expect(view.events[0]!.kind).toBe("occurrence");
  s.schedules.one.revision = 2; expect(personalDashboard(s, actor(), "2026-10", "UTC", now).events).toHaveLength(2);
});
test("large lists clip explicitly without lowering the exact calendar/task counts", async () => {
  const s = await state(); for (let index = 0; index < 510; index++) s.executions[String(index)] = run(String(index));
  const view = personalDashboard(s, actor(), "2026-10", "UTC", now);
  expect(view.truncated).toBe(true); expect(view.events).toHaveLength(500); expect(view.ongoing).toHaveLength(100); expect(view.dayCounts[view.today]!.total).toBe(510); expect(view.counts.ongoing).toBe(510);
});
