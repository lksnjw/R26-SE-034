import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { operationReadbackService, validateStatusHistory, validateStatusQuery } from "./operation-readback.service";
import { statusHistory, statusJob, statusReceipt, statusSource } from "./operation-readback.fixture";
afterEach(() => jest.restoreAllMocks());

test("history uses an encoded scoped GET and checks exact run, intent and node without exposing raw business results", async () => {
  const value = statusHistory(), signal = new AbortController().signal, get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: value } });
  expect(await operationReadbackService.history(statusSource.executionId, statusSource, signal)).toEqual(value);
  expect(get).toHaveBeenCalledWith("/executions/run%2Fone/readbacks", { signal });
  expect(() => validateStatusHistory(value, "other-run")).toThrow();
  expect(() => validateStatusHistory(value, statusSource.executionId, { intentId: "other-intent" })).toThrow();
  expect(() => validateStatusHistory(value, statusSource.executionId, { nodeId: "other-node" })).toThrow();
});

test.each(["profile", "intent", "node", "revision", "facts", "duplicate", "private-result", "cancel-grant", "size", "resume", "delivery", "pending-ready"])("history rejects %s inconsistency before displaying trusted observations", scenario => {
  const value = statusHistory();
  if (scenario === "profile") value.profile = "other";
  if (scenario === "intent") value.jobs[0].intentId = "another";
  if (scenario === "node") value.jobs[0].nodeId = "another";
  if (scenario === "revision") value.baseVersion = 0;
  if (scenario === "facts") value.factsHash = "fake";
  if (scenario === "duplicate") value.jobs.push(statusJob());
  if (scenario === "private-result") value.jobs[0].result = { state: "APPLIED" };
  if (scenario === "cancel-grant") value.jobs[0].canCancel = true;
  if (scenario === "size") value.jobs = Array.from({ length: 101 }, (_, index) => ({ ...statusJob(), id: `query-${index}` }));
  if (scenario === "resume") value.canResume = true;
  if (scenario === "delivery") value.jobs[0].observation.deliveryVerified = true;
  if (scenario === "pending-ready") value.jobs[0] = { ...statusJob(), state: "RUNNING", completedAt: null, observation: null, queryOutcome: "UNKNOWN" };
  expect(() => validateStatusHistory(value, statusSource.executionId)).toThrow(/Exact status-query evidence/);
});

test.each(["unsettled-definitive", "unconfirmed-answer", "future-observation", "time-order", "failed-observation", "wrong-error", "cancelled-dispatch", "extra-observation"])("job rejects %s evidence rather than inventing successful original execution", scenario => {
  const value = statusJob();
  if (scenario === "unsettled-definitive") value.observation.settled = false;
  if (scenario === "unconfirmed-answer") value.queryOutcome = "UNKNOWN";
  if (scenario === "future-observation") value.observation.observedAt = "2026-10-06T11:00:00.000Z";
  if (scenario === "time-order") value.completedAt = "2026-10-06T09:00:00.000Z";
  if (scenario === "failed-observation") value.state = "FAILED";
  if (scenario === "wrong-error") { value.state = "RECOVERY_REQUIRED"; value.observation = null; value.failure = "READBACK_CANCELLED"; value.queryOutcome = "UNKNOWN"; }
  if (scenario === "cancelled-dispatch") { value.state = "CANCELLED"; value.observation = null; value.failure = "READBACK_CANCELLED"; value.queryOutcome = "UNKNOWN"; }
  if (scenario === "extra-observation") value.observation.result = { sent: true };
  expect(() => validateStatusQuery(value, statusSource, { history: true })).toThrow();
});

test("strict admission sends no role/argument/result and validates source-bound acknowledgement; cancellation is query-only", async () => {
  const command = { intentId: statusSource.intentId, baseVersion: 1, factsHash: statusHistory().factsHash, idempotencyKey: "query-original-key-0001" };
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { success: true, data: statusReceipt() } });
  expect(await operationReadbackService.admit(statusSource, command)).toEqual(statusReceipt()); expect(post).toHaveBeenCalledWith("/executions/run%2Fone/readbacks", command);
  await expect(operationReadbackService.admit(statusSource, { ...command, result: {} })).rejects.toThrow(); expect(post).toHaveBeenCalledTimes(1);
  post.mockResolvedValue({ data: { success: true, data: { ...statusReceipt(), executionId: "other-run" } } });
  await expect(operationReadbackService.admit(statusSource, command)).rejects.toThrow();
  const { canCancel: _control, ...cancelled } = { ...statusJob(), id: "query/one", state: "CANCELLED", observation: null, queryOutcome: "NOT_DISPATCHED", startedAt: null, dispatchIntentRecorded: false, failure: "READBACK_CANCELLED", cancellationRequested: true };
  post.mockResolvedValue({ data: { success: true, data: cancelled } }); expect(await operationReadbackService.cancel(statusSource, "query/one")).toEqual(cancelled);
  expect(post).toHaveBeenLastCalledWith("/executions/run%2Fone/readbacks/query%2Fone/cancel", {});
  await expect(operationReadbackService.cancel(statusSource, "other-query")).rejects.toThrow();
});
