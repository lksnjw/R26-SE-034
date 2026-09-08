import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { operationRecoveryService } from "./operation-recovery.service";

const h = `sha256:${"a".repeat(64)}`;
const artifact = () => ({ profile: "operation-recovery-artifact/v1", id: "recovery-one", state: "REVIEW_REQUIRED",
  source: { executionId: "run/one", workflowId: "flow", workflowVersion: 1, snapshotHash: h, compilationHash: h, intentId: "intent", nodeId: "send", invocationId: "attempt",
    reconciliationId: "resolution", queryId: "query", outcome: "NOT_APPLIED", reconciliationRecordedAt: "2026-10-06T10:00:00.000Z" },
  action: { toolId: "tool", toolName: "Send notice", remoteToolName: "bridge.send", effectClass: "notification", connectionId: "connection", connectionBinding: "binding",
    capabilityId: "capability", capabilityRevision: "revision", admissionVersion: 1, contractHash: h, argumentHash: h, arguments: { recipient: "manager@example.test" } },
  createdBy: { id: "owner", role: "Platform Admin" }, createdAt: "2026-10-06T10:01:00.000Z",
  requirements: ["current-capability-validation", "fresh-independent-approval", "new-execution-and-intent", "new-idempotency-boundary"], dispatchAuthority: false, sourceRunUnchanged: true, artifactHash: h });
const history = (withArtifact = false) => ({ profile: "operation-recovery-artifact-history/v1", sourceExecutionId: "run/one", intentId: "intent", sourceVersion: 2, factsHash: h,
  state: "CLOSED_NOT_APPLIED", reconciliationId: "resolution", queryId: "query", canCreate: !withArtifact, canAdmit: withArtifact, linkedExecution: null,
  dispatchAuthority: false, artifacts: withArtifact ? [artifact()] : [], explanation: "Plan only." });
const envelope = data => ({ data: { success: true, data } });
afterEach(() => jest.restoreAllMocks());

test("history uses encoded authoritative path and accepts only a bounded non-dispatch artifact", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue(envelope(history(true))), signal = new AbortController().signal;
  expect(await operationRecoveryService.history("run/one", { signal })).toEqual(history(true));
  expect(get).toHaveBeenCalledWith("/executions/run%2Fone/recovery-artifacts", { signal });
  get.mockResolvedValue(envelope({ ...history(true), dispatchAuthority: true }));
  await expect(operationRecoveryService.history("run/one")).rejects.toThrow(/Linked recovery evidence/);
});

test("create sends source pins only and rejects browser-authored action or unbound receipts", async () => {
  const source = history(), command = { intentId: source.intentId, sourceVersion: source.sourceVersion, factsHash: source.factsHash,
    reconciliationId: source.reconciliationId, queryId: source.queryId, idempotencyKey: "recovery-request-0001" };
  const post = jest.spyOn(apiClient, "post").mockResolvedValue(envelope({ artifact: artifact(), replayed: false }));
  expect(await operationRecoveryService.create(source, command)).toEqual({ artifact: artifact(), replayed: false });
  expect(post).toHaveBeenCalledWith("/executions/run%2Fone/recovery-artifacts", command);
  await expect(operationRecoveryService.create(source, { ...command, arguments: { recipient: "changed" } })).rejects.toThrow();
  post.mockResolvedValue(envelope({ artifact: { ...artifact(), dispatchAuthority: true }, replayed: false }));
  await expect(operationRecoveryService.create(source, command)).rejects.toThrow();
});

test("admission sends only artifact identity and a new key, then requires a new execution and fresh approval receipt", async () => {
  const source = history(true), command = { artifactHash: artifact().artifactHash, idempotencyKey: "recovery-admission-0001" };
  const receipt = { sourceExecutionId: "run/one", artifactId: "recovery-one", workflowId: "recovery-flow", executionId: "recovery-run", status: "PENDING",
    replayed: false, freshApprovalRequired: true, sourceRunUnchanged: true };
  const post = jest.spyOn(apiClient, "post").mockResolvedValue(envelope(receipt)); expect(await operationRecoveryService.admit(source, artifact(), command)).toEqual(receipt);
  expect(post).toHaveBeenCalledWith("/executions/run%2Fone/recovery-artifacts/recovery-one/admit", command);
  await expect(operationRecoveryService.admit(source, artifact(), { ...command, arguments: {} })).rejects.toThrow();
  post.mockResolvedValue(envelope({ ...receipt, freshApprovalRequired: false })); await expect(operationRecoveryService.admit(source, artifact(), command)).rejects.toThrow();
});

test.each(["CASE_OPEN", "EFFECT_OBSERVED", "EVIDENCE_NOT_QUALIFIED"])("%s remains readable but cannot manufacture recovery authority", async state => {
  const value = { profile: "operation-recovery-artifact-history/v1", sourceExecutionId: "run/one", intentId: "intent", sourceVersion: 2, factsHash: h,
    state, canCreate: false, canAdmit: false, linkedExecution: null, dispatchAuthority: false, artifacts: [], explanation: "Unavailable." };
  jest.spyOn(apiClient, "get").mockResolvedValue(envelope(value)); expect(await operationRecoveryService.history("run/one")).toEqual(value);
});
