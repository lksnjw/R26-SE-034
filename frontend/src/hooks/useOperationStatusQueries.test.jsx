/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useOperationStatusQueries } from "./useOperationStatusQueries";
import { operationReadbackService } from "../services/operation-readback.service";
import { statusHistory, queuedStatusJob, statusSource } from "../services/operation-readback.fixture";
const pending = () => ({ ...statusHistory(), canQuery: false, jobs: [queuedStatusJob()] });
beforeEach(() => {
  jest.useFakeTimers(); jest.spyOn(operationReadbackService, "history").mockResolvedValue(statusHistory());
  jest.spyOn(operationReadbackService, "admit"); jest.spyOn(operationReadbackService, "cancel");
});
afterEach(() => { cleanup(); jest.useRealTimers(); jest.restoreAllMocks(); });
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async ms => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); }); };

test("pending queries poll GET only, and terminal history stops the timer", async () => {
  operationReadbackService.history.mockResolvedValueOnce(pending()).mockResolvedValueOnce(statusHistory());
  const view = renderHook(() => useOperationStatusQueries(statusSource.executionId)); await settle(); expect(view.result.current.history.jobs[0].state).toBe("QUEUED");
  await advance(2000); expect(view.result.current.history.jobs[0].state).toBe("ANSWERED"); await advance(30000);
  expect(operationReadbackService.history).toHaveBeenCalledTimes(2); expect(operationReadbackService.admit).not.toHaveBeenCalled(); expect(operationReadbackService.cancel).not.toHaveBeenCalled();
});
test("in-flight reads never overlap and cleanup aborts only the HTTP read", async () => {
  let release; operationReadbackService.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = renderHook(() => useOperationStatusQueries(statusSource.executionId)); await advance(30000); expect(operationReadbackService.history).toHaveBeenCalledTimes(1);
  const signal = operationReadbackService.history.mock.calls[0][2]; view.unmount(); expect(signal.aborted).toBe(true);
  release(pending()); await settle(); await advance(30000); expect(operationReadbackService.history).toHaveBeenCalledTimes(1); expect(operationReadbackService.cancel).not.toHaveBeenCalled();
});
test("an unavailable authoritative read hides prior evidence and backs off without retrying mutations", async () => {
  operationReadbackService.history.mockResolvedValueOnce(pending()).mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValueOnce(statusHistory());
  const view = renderHook(() => useOperationStatusQueries(statusSource.executionId)); await settle(); await advance(2000);
  expect(view.result.current.history).toBeNull(); expect(view.result.current.error).toMatch(/unavailable/); await advance(4000);
  expect(view.result.current.history.jobs[0].state).toBe("ANSWERED"); expect(operationReadbackService.admit).not.toHaveBeenCalled();
});
test.each([401, 403, 404])("authorization failure %s hides evidence and stops automatic polling", async status => {
  operationReadbackService.history.mockResolvedValueOnce(pending()).mockRejectedValueOnce({ response: { status } });
  const view = renderHook(() => useOperationStatusQueries(statusSource.executionId)); await settle(); await advance(2000); await advance(30000);
  expect(view.result.current.history).toBeNull(); expect(view.result.current.denied).toBe(true); expect(operationReadbackService.history).toHaveBeenCalledTimes(2);
});
test("a malformed response stops automatic retry; explicit refresh can recover exact history", async () => {
  operationReadbackService.history.mockRejectedValueOnce(Object.assign(new Error("Invalid exact history"), { code: "STATUS_QUERY_EVIDENCE_UNAVAILABLE" }));
  const view = renderHook(() => useOperationStatusQueries(statusSource.executionId)); await settle(); await advance(30000); expect(operationReadbackService.history).toHaveBeenCalledTimes(1);
  act(() => view.result.current.refresh()); expect(view.result.current.history).toBeNull(); await settle(); expect(view.result.current.history).toEqual(statusHistory());
});
test("source changes discard late old history, and online rechecks even terminal history without dispatch", async () => {
  let release; operationReadbackService.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const next = { ...statusHistory(), executionId: "new-run", jobs: [] }; operationReadbackService.history.mockResolvedValue(next);
  const view = renderHook(({ id }) => useOperationStatusQueries(id), { initialProps: { id: statusSource.executionId } }); view.rerender({ id: "new-run" }); await settle();
  release(statusHistory()); await settle(); expect(view.result.current.history.executionId).toBe("new-run");
  await act(async () => { window.dispatchEvent(new Event("online")); await Promise.resolve(); }); expect(operationReadbackService.history).toHaveBeenCalledTimes(3);
  expect(operationReadbackService.admit).not.toHaveBeenCalled(); expect(operationReadbackService.cancel).not.toHaveBeenCalled();
});
