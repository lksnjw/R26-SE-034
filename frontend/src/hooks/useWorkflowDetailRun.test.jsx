/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useWorkflowDetailRun } from "./useWorkflowDetailRun";
import { workflowService } from "../services/workflow.service";
import { executionService } from "../services/execution.service";
import { runAdmissionService } from "../services/run-admission.service";

const receipt = { id: "run-one", status: "PENDING" };
beforeEach(() => {
  jest.spyOn(workflowService, "readiness").mockResolvedValue({ can_attempt_run: true, operation_job_admission: "operation-job/v1" });
  jest.spyOn(executionService, "run").mockResolvedValue(receipt);
  jest.spyOn(executionService, "get").mockResolvedValue(receipt);
  jest.spyOn(crypto, "randomUUID").mockReturnValue("explicit-admission-key");
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const invoke = async result => { await act(async () => { await result.current.run({ query: "departments" }); }); };

test.each([["operation-job/v1", undefined, "async-operation"], [undefined, "read-job-v1", "async-read"]])("uses advertised %s/%s admission with one stable key", async (operation, read, mode) => {
  workflowService.readiness.mockResolvedValue({ can_attempt_run: true, operation_job_admission: operation, read_job_admission: read });
  const changed = jest.fn().mockRejectedValue(new Error("Refresh failed"));
  const { result } = renderHook(() => useWorkflowDetailRun("workflow", changed));
  await invoke(result); await invoke(result);
  expect(executionService.run).toHaveBeenCalledTimes(1);
  expect(executionService.run).toHaveBeenCalledWith("workflow", { query: "departments" }, { mode, idempotencyKey: "explicit-admission-key" });
  expect(result.current.state.result).toEqual(receipt); expect(result.current.state.error).toBeNull();
  expect(changed).toHaveBeenCalledTimes(1);
});
test("rapid clicks cannot overlap preflight or admission", async () => {
  let finish; workflowService.readiness.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useWorkflowDetailRun("workflow"));
  await act(async () => { void result.current.run(); void result.current.run(); });
  expect(workflowService.readiness).toHaveBeenCalledTimes(1); expect(executionService.run).not.toHaveBeenCalled();
  await act(async () => { finish({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }); });
  expect(executionService.run).toHaveBeenCalledTimes(1);
});
test.each([new Error("Connection lost"), { response: { status: 503 } }, { response: { status: 409, data: { meta: { executionId: "run-one" } } } }])("uncertain outcomes stay locked and never retry admission", async cause => {
  executionService.run.mockRejectedValue(cause); executionService.get.mockRejectedValue(new Error("Unavailable"));
  const { result } = renderHook(() => useWorkflowDetailRun("workflow")); await invoke(result); await invoke(result);
  expect(result.current.state.unconfirmed).toBe(true); expect(result.current.state.error).toMatch(/nothing was retried/);
  expect(executionService.run).toHaveBeenCalledTimes(1);
  act(() => result.current.dismiss({ id: "run-one", status: "DONE" }));
  expect(result.current.state.unconfirmed).toBe(true);
});
test("a response carrying an execution ID recovers that exact receipt by GET only", async () => {
  executionService.run.mockRejectedValue({ response: { status: 503, data: { meta: { executionId: "run-one" } } } });
  const { result } = renderHook(() => useWorkflowDetailRun("workflow")); await invoke(result); await invoke(result);
  expect(executionService.get).toHaveBeenCalledWith("run-one"); expect(result.current.state.result).toEqual(receipt);
  expect(executionService.run).toHaveBeenCalledTimes(1);
});
test.each([{ can_attempt_run: false }, { can_attempt_run: true }])("does not admit an unready or unsupported publication", async readiness => {
  workflowService.readiness.mockResolvedValue(readiness);
  const { result } = renderHook(() => useWorkflowDetailRun("workflow")); await invoke(result);
  expect(executionService.run).not.toHaveBeenCalled(); expect(result.current.state.error).toMatch(/canvas/);
  expect(result.current.state.unconfirmed).toBe(false);
});
test("definite preflight/rejection permits a new explicit attempt, not an automatic retry", async () => {
  workflowService.readiness.mockRejectedValueOnce(new Error("Offline"));
  const { result } = renderHook(() => useWorkflowDetailRun("workflow")); await invoke(result);
  expect(executionService.run).not.toHaveBeenCalled();
  executionService.run.mockRejectedValueOnce({ response: { status: 422, data: { message: "Input required" } } }); await invoke(result);
  expect(result.current.state.error).toBe("Input required"); expect(result.current.state.unconfirmed).toBe(false);
  await invoke(result); expect(result.current.state.result).toEqual(receipt); expect(executionService.run).toHaveBeenCalledTimes(2);
});
test("only a matching confirmed terminal receipt releases the run lock", async () => {
  const { result } = renderHook(() => useWorkflowDetailRun("workflow"));
  act(() => result.current.dismiss()); await invoke(result);
  for (const snapshot of [undefined, { id: "other", status: "DONE" }, { ...receipt, status: "RUNNING" }, { ...receipt, status: "RECOVERY_REQUIRED" }]) act(() => result.current.dismiss(snapshot));
  await invoke(result); expect(executionService.run).toHaveBeenCalledTimes(1);
  act(() => result.current.dismiss({ ...receipt, status: "DONE" }));
  expect(result.current.state.result).toBeNull(); await invoke(result); expect(executionService.run).toHaveBeenCalledTimes(2);
});
test("late admission stays with its workflow and cannot replace another route's receipt", async () => {
  let finish; executionService.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ id }) => useWorkflowDetailRun(id), { initialProps: { id: "first" } });
  await act(async () => { void result.current.run(); });
  rerender({ id: "second" }); expect(result.current.state.result).toBeNull(); await invoke(result);
  await act(async () => { finish({ id: "first-run", status: "PENDING" }); });
  expect(result.current.state.result.id).toBe("run-one"); rerender({ id: "first" }); expect(result.current.state.result.id).toBe("first-run");
  await invoke(result); expect(executionService.run).toHaveBeenCalledTimes(2);
});
test("an invalid receipt is uncertain; missing UUID support fails before admission", async () => {
  executionService.run.mockResolvedValue({ id: 7 });
  const first = renderHook(() => useWorkflowDetailRun("workflow")); await invoke(first.result);
  expect(first.result.current.state.unconfirmed).toBe(true); first.unmount();
  crypto.randomUUID.mockImplementation(() => { throw new Error("UUID unavailable"); });
  const second = renderHook(() => useWorkflowDetailRun("workflow")); await invoke(second.result);
  expect(second.result.current.state.unconfirmed).toBe(false); expect(executionService.run).toHaveBeenCalledTimes(1);
});

test("a new cross-tab identity hides the previous local answer while exact recovery is pending", async () => {
  jest.spyOn(runAdmissionService, "pending").mockReturnValue(null);
  jest.spyOn(runAdmissionService, "storageKey").mockReturnValue("same-workflow-scope");
  let finish;
  jest.spyOn(runAdmissionService, "recover").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useWorkflowDetailRun("workflow", undefined, "actor"));
  await invoke(result); expect(result.current.state.result.id).toBe("run-one");
  runAdmissionService.pending.mockReturnValue({ key: "another-explicit-run-key" });
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "same-workflow-scope" })); });
  expect(result.current.state.result).toBeNull(); expect(result.current.recovery.pending).toBe(true);
  await act(async () => { finish({ id: "run-two", workflowId: "workflow", status: "PENDING" }); });
  expect(result.current.state.result.id).toBe("run-two"); expect(executionService.run).toHaveBeenCalledTimes(1);
});
