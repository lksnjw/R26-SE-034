/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRunAdmissionRecovery } from "./useRunAdmissionRecovery";
import { runAdmissionService, RUN_ADMISSION_CHANGED } from "../services/run-admission.service";
import { executionService } from "../services/execution.service";

const run = { id: "original", workflowId: "flow", status: "DONE", tokens: { input: 2, output: 2, total: 4 } };
beforeEach(() => {
  jest.spyOn(runAdmissionService, "pending").mockReturnValue({ key: "original-command-key" });
  jest.spyOn(runAdmissionService, "recover").mockResolvedValue(run);
  jest.spyOn(runAdmissionService, "release").mockResolvedValue(true);
  jest.spyOn(runAdmissionService, "storageKey").mockReturnValue("scope");
  jest.spyOn(executionService, "run");
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
test("remount restores the exact original run with no new admission", async () => {
  const first = renderHook(() => useRunAdmissionRecovery("flow", "actor"));
  await waitFor(() => expect(first.result.current.run?.id).toBe("original")); first.unmount();
  const second = renderHook(() => useRunAdmissionRecovery("flow", "actor"));
  await waitFor(() => expect(second.result.current.run?.recordedUsage?.total).toBe(4));
  expect(runAdmissionService.recover).toHaveBeenCalledTimes(2); expect(executionService.run).not.toHaveBeenCalled();
});
test("unknown receipt stays locked; a manual read-only refresh can recover it", async () => {
  runAdmissionService.recover.mockRejectedValueOnce(new Error("Receipt not found; outcome unconfirmed"));
  const { result } = renderHook(() => useRunAdmissionRecovery("flow", "actor"));
  await waitFor(() => expect(result.current.error).toMatch(/unconfirmed/)); expect(result.current.pending).toBe(true);
  await act(async () => { await result.current.refresh(); }); expect(result.current.run.id).toBe("original"); expect(executionService.run).not.toHaveBeenCalled();
});
test("late account/workflow recovery cannot reveal the previous run in the new scope", async () => {
  let finish; runAdmissionService.recover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...run, id: "new-account-run" });
  const { result, rerender } = renderHook(({ actor, workflow }) => useRunAdmissionRecovery(workflow, actor), { initialProps: { actor: "first", workflow: "flow" } });
  rerender({ actor: "second", workflow: "other" }); await waitFor(() => expect(result.current.run?.id).toBe("new-account-run"));
  await act(async () => { finish(run); }); expect(result.current.run.id).toBe("new-account-run"); expect(executionService.run).not.toHaveBeenCalled();
});
test("same-tab and cross-tab identity notifications recover only the matching scope", async () => {
  const { result } = renderHook(() => useRunAdmissionRecovery("flow", "actor")); await waitFor(() => expect(result.current.run).not.toBeNull());
  await act(async () => { window.dispatchEvent(new CustomEvent(RUN_ADMISSION_CHANGED, { detail: "scope" })); });
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "scope" })); });
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "another-account" })); });
  expect(runAdmissionService.recover).toHaveBeenCalledTimes(3); expect(executionService.run).not.toHaveBeenCalled();
});
test("authorization loss hides answers and retains the original request lock", async () => {
  runAdmissionService.recover.mockRejectedValue({ response: { status: 403 }, message: "Access revoked" });
  const { result } = renderHook(() => useRunAdmissionRecovery("flow", "actor")); await waitFor(() => expect(result.current.denied).toBe(true));
  expect(result.current.run).toBeNull(); expect(result.current.pending).toBe(true);
});
test("failed terminal review cannot clear a request; successful explicit review clears the panel", async () => {
  const { result } = renderHook(() => useRunAdmissionRecovery("flow", "actor")); await waitFor(() => expect(result.current.run).not.toBeNull());
  runAdmissionService.release.mockResolvedValueOnce(false);
  await act(async () => { expect(await result.current.release(run)).toBe(false); }); expect(result.current.pending).toBe(true);
  runAdmissionService.pending.mockReturnValue(null);
  await act(async () => { expect(await result.current.release(run)).toBe(true); }); expect(result.current.pending).toBe(false); expect(result.current.run).toBeNull(); expect(executionService.run).not.toHaveBeenCalled();
});
