/** @jest-environment jsdom */
import { jest, expect, test, beforeEach, afterEach } from "@jest/globals";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useExecutionMonitor } from "./useExecutionMonitor";
import { executionService } from "../services/execution.service";
const event = (sequence, type = "node.completed", id = "run") => ({ version: 1, executionId: id, sequence, timestamp: "2026-10-05T00:00:00Z", type });
const page = (events, status = "RUNNING", extra = {}) => ({ events, cursor: events.at(-1)?.sequence ?? 0, lastSequence: events.at(-1)?.sequence ?? 0, hasMore: false, status, profile: "read-progress-v1", ...extra });
const snapshot = (sequence, status = "RUNNING", id = "run") => ({ id, status, readProgress: { profile: "read-progress-v1", lastSequence: sequence }, stepOutputs: { first: { value: "saved answer" } } });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tick = async (ms = 2000) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, "random").mockReturnValue(0.5);
  jest.spyOn(executionService, "getEvents").mockResolvedValue(page([event(1, "run.started")]));
  jest.spyOn(executionService, "get").mockResolvedValue(snapshot(1));
  jest.spyOn(executionService, "getTimeline").mockResolvedValue([{ nodeId: "first", status: "DONE" }]);
});
afterEach(() => { cleanup(); jest.useRealTimers(); jest.restoreAllMocks(); });

test("polls sequenced changes, keeps real answers and stops after confirmed terminal snapshot", async () => {
  executionService.getEvents.mockResolvedValueOnce(page([event(1, "run.started")])).mockResolvedValueOnce(page([], "RUNNING", { cursor: 1, lastSequence: 1 })).mockResolvedValueOnce(page([event(2, "run.completed")], "CANCELLED"));
  executionService.get.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2, "CANCELLED"));
  const { result } = renderHook(() => useExecutionMonitor("run")); await flush();
  expect(result.current.cursor).toBe(1);
  expect(result.current.execution.stepOutputs.first.value).toBe("saved answer");
  await tick(); expect(executionService.get).toHaveBeenCalledTimes(1); // unchanged journal: no payload reload
  await tick(); expect(result.current.execution.status).toBe("CANCELLED"); expect(result.current.events).toHaveLength(2);
  await tick(20000); expect(executionService.getEvents).toHaveBeenCalledTimes(3);
});
test("a held HTTP read does not overlap polling and cleanup aborts reads, not execution", async () => {
  let finish;
  executionService.getEvents.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result, unmount } = renderHook(() => useExecutionMonitor("run")); await flush(); await tick(20000);
  expect(executionService.getEvents).toHaveBeenCalledTimes(1);
  const signal = executionService.getEvents.mock.calls[0][2].signal;
  unmount(); expect(signal.aborted).toBe(true);
  finish(page([event(1)])); await flush();
  expect(result.current.execution).toBeNull();
});
test("a sequence gap retains explicitly stale answers; manual refresh replays from zero", async () => {
  executionService.getEvents.mockResolvedValueOnce(page([event(1)])).mockResolvedValueOnce(page([event(3)]));
  const { result } = renderHook(() => useExecutionMonitor("run")); await flush(); await tick();
  expect(result.current.error).toMatch(/sequence gap/); expect(result.current.cursor).toBe(1);
  expect(result.current.execution.stepOutputs.first.value).toBe("saved answer");
  executionService.getEvents.mockResolvedValue(page([event(1), event(2), event(3)], "DONE"));
  executionService.get.mockResolvedValue(snapshot(3, "DONE"));
  act(() => result.current.refresh()); await flush();
  expect(result.current.error).toBe(""); expect(result.current.cursor).toBe(3);
  expect(executionService.getEvents.mock.calls.at(-1)[1]).toBe(0);
});
test("account revocation hides saved data and stops polling", async () => {
  executionService.getEvents.mockResolvedValueOnce(page([event(1)])).mockRejectedValue({ response: { status: 404 } });
  const { result } = renderHook(() => useExecutionMonitor("run")); await flush(); await tick();
  expect(result.current.denied).toBe(true); expect(result.current.execution).toBeNull(); expect(result.current.events).toEqual([]);
  await tick(20000); expect(executionService.getEvents).toHaveBeenCalledTimes(2);
});
test("read failures keep reconnecting beyond three failures without claiming a terminal run", async () => {
  executionService.getEvents.mockRejectedValue(new Error("Network unavailable"));
  const { result } = renderHook(() => useExecutionMonitor("run")); await flush(); await tick(2000); await tick(4000); await tick(40000);
  expect(executionService.getEvents.mock.calls.length).toBeGreaterThan(3);
  expect(result.current.execution).toBeNull(); expect(result.current.error).toBe("Network unavailable");
  expect(result.current.reconnecting).toBe(true);
  executionService.getEvents.mockResolvedValue(page([event(1, "run.completed")], "DONE"));
  executionService.get.mockResolvedValue(snapshot(1, "DONE"));
  await tick(30000); expect(result.current.execution.status).toBe("DONE"); expect(result.current.reconnecting).toBe(false);
});

test("online reconnect is immediate, non-overlapping and never revives denied monitoring", async () => {
  executionService.getEvents.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(page([event(1)]));
  const { result } = renderHook(() => useExecutionMonitor("run")); await flush();
  act(() => window.dispatchEvent(new Event("online"))); await flush();
  expect(result.current.error).toBe(""); expect(executionService.getEvents).toHaveBeenCalledTimes(2);
  executionService.getEvents.mockRejectedValue({ response: { status: 403 } });
  await tick(); const deniedCalls = executionService.getEvents.mock.calls.length;
  act(() => window.dispatchEvent(new Event("online"))); await flush(); await tick(60000);
  expect(result.current.denied).toBe(true); expect(executionService.getEvents).toHaveBeenCalledTimes(deniedCalls);
});

test("sequence gaps resync automatically without replaying the operation", async () => {
  executionService.getEvents.mockResolvedValueOnce(page([event(1)])).mockResolvedValueOnce(page([event(3)])).mockResolvedValueOnce(page([event(1), event(2), event(3)], "DONE"));
  executionService.get.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(3, "DONE"));
  const { result } = renderHook(() => useExecutionMonitor("run")); await flush(); await tick();
  expect(result.current.error).toMatch(/sequence gap/);
  expect(result.current.execution.stepOutputs.first.value).toBe("saved answer");
  await tick(); expect(executionService.getEvents.mock.calls.at(-1)[1]).toBe(0);
  expect(result.current.events.map((item) => item.sequence)).toEqual([1, 2, 3]); expect(result.current.error).toBe("");
});
test("switching execution hides the old account/run frame and ignores a late response", async () => {
  let late;
  executionService.getEvents.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; })).mockResolvedValue(page([event(1, "run.completed", "other")], "DONE"));
  executionService.get.mockResolvedValue(snapshot(1, "DONE", "other"));
  const { result, rerender } = renderHook(({ id }) => useExecutionMonitor(id), { initialProps: { id: "run" } }); await flush();
  rerender({ id: "other" }); await flush(); late(page([event(1)])); await flush();
  expect(result.current.execution.id).toBe("other"); expect(result.current.events[0].executionId).toBe("other");
});

test("a terminal snapshot newer than the journal page still drains missing terminal events", async () => {
  executionService.getEvents.mockResolvedValueOnce(page([event(1)])).mockResolvedValueOnce(page([event(2, "run.completed")], "DONE"));
  executionService.get.mockResolvedValue(snapshot(2, "DONE"));
  const { result } = renderHook(() => useExecutionMonitor("run")); await flush(); await tick(1);
  expect(result.current.events.map((item) => item.sequence)).toEqual([1, 2]);
  expect(result.current.execution.status).toBe("DONE");
  await tick(20000); expect(executionService.getEvents).toHaveBeenCalledTimes(2);
});

test("a journal temporarily behind a terminal snapshot does not hot-loop empty pages", async () => {
  executionService.getEvents.mockResolvedValueOnce(page([event(1)])).mockResolvedValue(page([], "RUNNING", { cursor: 1, lastSequence: 1 }));
  executionService.get.mockResolvedValue(snapshot(2, "DONE"));
  renderHook(() => useExecutionMonitor("run")); await flush(); await tick(1);
  expect(executionService.getEvents).toHaveBeenCalledTimes(2);
  await tick(1000); expect(executionService.getEvents).toHaveBeenCalledTimes(2);
  await tick(1000); expect(executionService.getEvents).toHaveBeenCalledTimes(3);
});
