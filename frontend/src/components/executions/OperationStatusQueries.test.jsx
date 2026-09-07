/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationStatusQueries from "./OperationStatusQueries";
import { operationReadbackService } from "../../services/operation-readback.service";
import { statusHistory, statusJob, queuedStatusJob, statusReceipt, statusSource } from "../../services/operation-readback.fixture";
beforeEach(() => {
  jest.spyOn(operationReadbackService, "history").mockResolvedValue(statusHistory());
  jest.spyOn(operationReadbackService, "admit").mockResolvedValue(statusReceipt());
  jest.spyOn(operationReadbackService, "cancel").mockResolvedValue(statusReceipt());
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const open = () => render(<OperationStatusQueries {...statusSource} />);

test("saved observations have readable labels, no JSON or original-action/delivery confirmation", async () => {
  const { container } = open(); await screen.findByText("Not-applied condition observed");
  expect(screen.getByText(/State settled/)).toBeTruthy(); expect(screen.getByText(/original SDK outcome stays unacknowledged/)).toBeTruthy();
  expect(container.querySelector("pre")).toBeNull(); expect(container.textContent).not.toMatch(/"outcome"|"structuredContent"/);
  expect(operationReadbackService.admit).not.toHaveBeenCalled(); expect(operationReadbackService.cancel).not.toHaveBeenCalled();
  expect(operationReadbackService.history).toHaveBeenCalledWith(statusSource.executionId, { intentId: statusSource.intentId, nodeId: statusSource.nodeId }, expect.any(AbortSignal));
});

test("explicit once-only admission uses current case pins and never calls original execution controls", async () => {
  let release; operationReadbackService.admit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  open(); const query = await screen.findByRole("button", { name: "Query current ERP state" }); await waitFor(() => expect(query.disabled).toBe(false));
  fireEvent.click(query); fireEvent.click(query); expect(operationReadbackService.admit).toHaveBeenCalledTimes(1); expect(query.disabled).toBe(true);
  expect(operationReadbackService.admit).toHaveBeenCalledWith(statusSource, { intentId: statusSource.intentId, baseVersion: 1, factsHash: statusHistory().factsHash, idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  release(statusReceipt()); await screen.findByText(/Admission is not an answer/); expect(operationReadbackService.cancel).not.toHaveBeenCalled();
});

test("lost admission acknowledgement stays locked after GET reload; an explicit check reuses exactly the original key", async () => {
  operationReadbackService.admit.mockRejectedValueOnce(new Error("Lost ACK")).mockResolvedValueOnce(statusReceipt(statusJob(), true));
  open(); const query = await screen.findByRole("button", { name: "Query current ERP state" }); await waitFor(() => expect(query.disabled).toBe(false)); fireEvent.click(query);
  await screen.findByText(/acknowledgement is unconfirmed/); expect(query.disabled).toBe(true); expect(operationReadbackService.admit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload status history" }));
  const check = screen.getByRole("button", { name: "Check same query request" }); await waitFor(() => expect(check.disabled).toBe(false));
  expect(query.disabled).toBe(true); expect(operationReadbackService.admit).toHaveBeenCalledTimes(1); fireEvent.click(check);
  await screen.findByText(/Original query request found/); expect(operationReadbackService.admit.mock.calls[1]).toEqual(operationReadbackService.admit.mock.calls[0]);
});

test("query cancellation sends only the exact query ID; request receipt is not transport interruption", async () => {
  const running = { ...queuedStatusJob(), state: "RUNNING", startedAt: statusJob().startedAt, dispatchIntentRecorded: true, queryOutcome: "UNKNOWN" };
  operationReadbackService.history.mockResolvedValue({ ...statusHistory(), canQuery: false, jobs: [running] });
  const { canCancel: _control, ...receipt } = { ...running, cancellationRequested: true }; operationReadbackService.cancel.mockResolvedValue(receipt);
  open(); fireEvent.click(await screen.findByRole("button", { name: "Cancel status query" }));
  await screen.findByText(/in-flight transport may still finish/); expect(operationReadbackService.cancel).toHaveBeenCalledWith(statusSource, running.id);
  expect(operationReadbackService.admit).not.toHaveBeenCalled();
});

test.each(["closed", "offline-capability", "read-only"])("server-denied query authority (%s) never enables dispatch", scenario => {
  operationReadbackService.history.mockResolvedValue({ ...statusHistory(), canQuery: false, explanation: scenario });
  open(); return screen.findByText("Not-applied condition observed").then(() => { expect(screen.getByRole("button", { name: "Query current ERP state" }).disabled).toBe(true); expect(operationReadbackService.admit).not.toHaveBeenCalled(); });
});

test("failed authority reload hides old observations and keeps commands disabled; no empty-history claim", async () => {
  open(); await screen.findByText("Not-applied condition observed");
  operationReadbackService.history.mockRejectedValue({ response: { status: 503, data: { message: "Authoritative storage unavailable" } } });
  fireEvent.click(screen.getByRole("button", { name: "Reload status history" })); await screen.findByRole("alert");
  expect(screen.queryByText("Not-applied condition observed")).toBeNull(); expect(screen.queryByText(/No saved status queries/)).toBeNull();
  expect(screen.getByRole("button", { name: "Query current ERP state" }).disabled).toBe(true); expect(operationReadbackService.admit).not.toHaveBeenCalled();
});

test("an unresolved result and memory storage never imply definitive completion or durability", async () => {
  const job = statusJob(); job.observation.outcome = "UNRESOLVED"; job.observation.settled = false;
  operationReadbackService.history.mockResolvedValue({ ...statusHistory(), memoryOnly: true, jobs: [job] }); open();
  await screen.findByText("Operation state still unresolved"); expect(screen.getByText("No · keep unresolved")).toBeTruthy(); expect(screen.getByText(/not durable across server restart/)).toBeTruthy();
});

test("a denied stale request requires a fresh saved case and explicit reset before a new admission", async () => {
  operationReadbackService.admit.mockRejectedValue({ response: { status: 409 } }); open();
  const query = await screen.findByRole("button", { name: "Query current ERP state" }); await waitFor(() => expect(query.disabled).toBe(false)); fireEvent.click(query);
  const useCase = await screen.findByRole("button", { name: "Use reloaded case" }); await waitFor(() => expect(useCase.disabled).toBe(false));
  expect(query.disabled).toBe(true); fireEvent.click(useCase); await screen.findByText(/Any new query uses the current case revision/);
  expect(query.disabled).toBe(false); expect(operationReadbackService.admit).toHaveBeenCalledTimes(1);
});

test("changing source while an admission is pending discards its late receipt without updating or querying the new run", async () => {
  let release; operationReadbackService.admit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const view = open();
  const query = await screen.findByRole("button", { name: "Query current ERP state" }); await waitFor(() => expect(query.disabled).toBe(false)); fireEvent.click(query);
  operationReadbackService.history.mockResolvedValue({ ...statusHistory(), executionId: "new-run", jobs: [] });
  view.rerender(<OperationStatusQueries executionId="new-run" intentId={statusSource.intentId} nodeId={statusSource.nodeId} />); await screen.findByText(/No saved status queries/);
  release(statusReceipt()); await waitFor(() => expect(screen.queryByText(/Read-only query admitted/)).toBeNull());
  expect(operationReadbackService.admit).toHaveBeenCalledTimes(1);
});

test("bounded history initially shows recent queries, with explicit access to every older observation and no new request", async () => {
  const jobs = Array.from({ length: 100 }, (_, index) => ({ ...statusJob(), id: `query-${index}` }));
  operationReadbackService.history.mockResolvedValue({ ...statusHistory(), canQuery: false, jobs });
  open(); const older = await screen.findByRole("button", { name: "Show older queries (97)" });
  expect(screen.getByRole("list", { name: "Saved status observations" }).tabIndex).toBe(0);
  expect(screen.getAllByText("Not-applied condition observed")).toHaveLength(3);
  fireEvent.click(older); expect(screen.getAllByText("Not-applied condition observed")).toHaveLength(100);
  fireEvent.click(screen.getByRole("button", { name: "Show recent queries" }));
  expect(screen.getAllByText("Not-applied condition observed")).toHaveLength(3);
  expect(operationReadbackService.history).toHaveBeenCalledTimes(1);
  expect(operationReadbackService.admit).not.toHaveBeenCalled();
});

test("an active query outside the recent preview retains its cancellation control", async () => {
  const jobs = [...Array.from({ length: 4 }, (_, index) => ({ ...statusJob(), id: `saved-${index}` })), queuedStatusJob()];
  operationReadbackService.history.mockResolvedValue({ ...statusHistory(), canQuery: false, jobs });
  open(); await screen.findByRole("button", { name: "Cancel status query" });
  expect(screen.getAllByText("Not-applied condition observed")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Show older queries (1)" })).toBeTruthy();
  expect(operationReadbackService.cancel).not.toHaveBeenCalled();
});

test("changed qualified history refreshes the containing run once; unchanged reloads and failed reads do not", async () => {
  const onHistoryChanged = jest.fn(); render(<OperationStatusQueries {...statusSource} onHistoryChanged={onHistoryChanged} />);
  await screen.findByText("Not-applied condition observed"); expect(onHistoryChanged).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload status history" })); await screen.findByText("Not-applied condition observed");
  expect(onHistoryChanged).toHaveBeenCalledTimes(1);
  operationReadbackService.history.mockResolvedValue({ ...statusHistory(), jobs: [{ ...statusJob(), id: "another-query" }] });
  fireEvent.click(screen.getByRole("button", { name: "Reload status history" }));
  await waitFor(() => expect(onHistoryChanged).toHaveBeenCalledTimes(2));
  operationReadbackService.history.mockRejectedValue({ response: { status: 403 } });
  fireEvent.click(screen.getByRole("button", { name: "Reload status history" })); await screen.findByRole("alert");
  expect(onHistoryChanged).toHaveBeenCalledTimes(2); expect(operationReadbackService.admit).not.toHaveBeenCalled(); expect(operationReadbackService.cancel).not.toHaveBeenCalled();
});
