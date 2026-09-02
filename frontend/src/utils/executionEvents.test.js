import { expect, test } from "@jest/globals";
import { reconcileExecutionEvents, executionEventLabel } from "./executionEvents";
const event = (sequence, extra = {}) => ({ version: 1, executionId: "run", sequence, timestamp: "2026-10-05T00:00:00Z", type: "node.completed", ...extra });
const page = (events, extra = {}) => ({ events, cursor: events.at(-1)?.sequence ?? 0, lastSequence: events.at(-1)?.sequence ?? 0, hasMore: false, status: "DONE", profile: "read-progress-v1", ...extra });

test("contiguous journal replay deduplicates identical overlap without invented outputs", () => {
  const first = reconcileExecutionEvents([], 0, page([event(1)], { lastSequence: 2, hasMore: true }), "run");
  const next = reconcileExecutionEvents(first.events, 1, page([event(1), event(2)]), "run");
  expect(next.events.map((item) => item.sequence)).toEqual([1, 2]);
  expect(next.cursor).toBe(2);
  expect(next.events[1].output).toBeUndefined();
  expect(executionEventLabel(event(2))).toBe("Node answer saved");
});
test.each([
  page([event(2)]), page([event(1, { executionId: "foreign" })]), page([event(1, { version: 2 })]),
  page([event(1)], { cursor: 2 }), page([event(1)], { lastSequence: 2 }),
  page([], { lastSequence: 1, hasMore: true }), page([event(1)], { profile: "invented" }),
  page([event(1)], { profile: "legacy-no-journal" }),
])("gaps, foreign/unsupported events and inconsistent cursors reject rather than guess", (value) => {
  expect(() => reconcileExecutionEvents([], 0, value, "run")).toThrow();
});
test("conflicting duplicate evidence rejects", () => {
  expect(() => reconcileExecutionEvents([event(1)], 1, page([event(1, { type: "node.failed" })]), "run")).toThrow(/conflicting/);
});
test("legacy empty journals and unchanged cursors remain truthful", () => {
  expect(reconcileExecutionEvents([], 0, page([], { profile: "legacy-no-journal" }), "run")).toEqual({ events: [], cursor: 0 });
  expect(reconcileExecutionEvents([event(1)], 1, page([], { cursor: 1, lastSequence: 1 }), "run").cursor).toBe(1);
  expect(executionEventLabel({ type: "future.event" })).toBe("Unrecognized run event");
});
