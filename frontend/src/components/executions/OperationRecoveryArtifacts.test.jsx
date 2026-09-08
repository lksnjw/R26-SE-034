/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OperationRecoveryArtifacts from "./OperationRecoveryArtifacts";
import { operationRecoveryService } from "../../services/operation-recovery.service";

const h = `sha256:${"a".repeat(64)}`, source = { profile: "operation-recovery-artifact-history/v1", sourceExecutionId: "run", intentId: "intent", sourceVersion: 2, factsHash: h,
  state: "CLOSED_NOT_APPLIED", reconciliationId: "resolution", queryId: "query", canCreate: true, canAdmit: false, linkedExecution: null, dispatchAuthority: false, artifacts: [], explanation: "A reviewed not-applied observation can be planned safely." };
const saved = { profile: "operation-recovery-artifact/v1", id: "recovery", state: "REVIEW_REQUIRED", source: { executionId: "run", workflowId: "flow", workflowVersion: 1, snapshotHash: h, compilationHash: h,
  intentId: "intent", nodeId: "send", invocationId: "attempt", reconciliationId: "resolution", queryId: "query", outcome: "NOT_APPLIED", reconciliationRecordedAt: "2026-10-06T10:00:00.000Z" },
  action: { toolId: "tool", toolName: "Send manager report", remoteToolName: "bridge.send", effectClass: "notification", connectionId: "connection", connectionBinding: "binding", capabilityId: "capability",
    capabilityRevision: "revision", admissionVersion: 1, contractHash: h, argumentHash: h, arguments: { recipient: "manager@example.test", subject: "Daily invoices" } },
  createdBy: { id: "owner", role: "Platform Admin" }, createdAt: "2026-10-06T10:01:00.000Z", requirements: ["current-capability-validation", "fresh-independent-approval", "new-execution-and-intent", "new-idempotency-boundary"],
  dispatchAuthority: false, sourceRunUnchanged: true, artifactHash: h };
beforeEach(() => { jest.spyOn(operationRecoveryService, "history").mockResolvedValue(source); jest.spyOn(operationRecoveryService, "create").mockResolvedValue({ artifact: saved, replayed: false });
  jest.spyOn(operationRecoveryService, "admit").mockResolvedValue({ sourceExecutionId: "run", artifactId: "recovery", workflowId: "recovery-flow", executionId: "recovery-run", status: "PENDING", replayed: false, freshApprovalRequired: true, sourceRunUnchanged: true });
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: jest.fn(() => "recovery-request-0001") }); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test("requires explicit plan-only consent and sends no action, outcome or dispatch fields", async () => {
  operationRecoveryService.history.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, canCreate: false, canAdmit: true, artifacts: [saved] });
  const { container } = render(<OperationRecoveryArtifacts executionId="run" />); const create = await screen.findByRole("button", { name: "Create linked recovery plan" });
  expect(create).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(create);
  await screen.findByText(/Immutable recovery plan saved/); expect(operationRecoveryService.create).toHaveBeenCalledWith(source, {
    intentId: "intent", sourceVersion: 2, factsHash: h, reconciliationId: "resolution", queryId: "query", idempotencyKey: "recovery-request-0001" });
  const sent = operationRecoveryService.create.mock.calls[0][1]; expect(sent).not.toHaveProperty("action"); expect(sent).not.toHaveProperty("arguments"); expect(sent).not.toHaveProperty("outcome");
  await screen.findByText("Send manager report"); expect(screen.getByText("manager@example.test")).toBeTruthy(); expect(container.querySelector("pre")).toBeNull();
  expect(screen.getByText(/No dispatch authority/)).toBeTruthy();
});

test("unknown acknowledgement locks creation until authoritative reload and never auto-retries", async () => {
  operationRecoveryService.create.mockRejectedValueOnce(new Error("lost ACK")); render(<OperationRecoveryArtifacts executionId="run" />);
  const create = await screen.findByRole("button", { name: "Create linked recovery plan" }); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(create);
  await screen.findByText(/acknowledgement is unknown/); expect(operationRecoveryService.create).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Create linked recovery plan" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Reload recovery history" }));
  await screen.findByText(/Authoritative recovery history reloaded/); expect(operationRecoveryService.create).toHaveBeenCalledTimes(1);
});

test("ineligible evidence explains the block without showing a recovery action", async () => {
  operationRecoveryService.history.mockResolvedValue({ ...source, state: "EFFECT_OBSERVED", canCreate: false, canAdmit: false, artifacts: [], explanation: "The effect was observed, so replacement is blocked.", reconciliationId: undefined, queryId: undefined });
  render(<OperationRecoveryArtifacts executionId="run" />); await screen.findByText(/effect was observed/);
  expect(screen.queryByRole("button", { name: "Create linked recovery plan" })).toBeNull(); expect(operationRecoveryService.create).not.toHaveBeenCalled();
});

test("a saved plan needs separate consent before queuing a fresh-approval execution", async () => {
  const ready = { ...source, canCreate: false, canAdmit: true, artifacts: [saved] }, linked = { ...ready, canAdmit: false,
    linkedExecution: { executionId: "recovery-run", workflowId: "recovery-flow", status: "AWAITING_APPROVAL", startedAt: "2026-10-06T10:02:00.000Z" } };
  operationRecoveryService.history.mockResolvedValueOnce(ready).mockResolvedValueOnce(linked); const { container } = render(<OperationRecoveryArtifacts executionId="run" />);
  const queue = await screen.findByRole("button", { name: "Queue separate recovery execution" }); expect(queue).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(queue);
  await screen.findByText(/Separate recovery execution queued/); expect(operationRecoveryService.admit).toHaveBeenCalledWith(ready, saved, { artifactHash: h, idempotencyKey: "recovery-request-0001" });
  expect(await screen.findByText(/Separate recovery execution · AWAITING_APPROVAL/)).toBeTruthy(); expect(screen.getByRole("link", { name: /Open recovery execution/ }).getAttribute("href")).toBe("/executions/recovery-run");
  expect(container.querySelector("pre")).toBeNull();
});
