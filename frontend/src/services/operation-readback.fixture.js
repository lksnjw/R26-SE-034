export const statusSource = { executionId: "run/one", intentId: "intent-one", nodeId: "send" };
export const statusJob = () => ({ id: "query-one", ...statusSource, state: "ANSWERED", createdAt: "2026-10-06T10:00:00.000Z", startedAt: "2026-10-06T10:00:01.000Z",
  completedAt: "2026-10-06T10:00:03.000Z", actorId: "owner", basis: "queried-operation-state", dispatchIntentRecorded: true, queryOutcome: "ANSWER_CONFIRMED",
  observation: { profile: "operation-readback-evaluation/v1", outcome: "NOT_APPLIED", observedAt: "2026-10-06T10:00:02.000Z", settled: true, evidenceMeaning: "operation-state", canResume: false, noReplay: true, deliveryVerified: false },
  failure: null, cancellationRequested: false, canResume: false, noReplay: true, deliveryVerified: false, canCancel: false });
export const statusHistory = () => ({ profile: "operation-readback-history/v1", ...statusSource, baseVersion: 1, factsHash: `sha256:${"a".repeat(64)}`, canQuery: true, memoryOnly: false,
  jobs: [statusJob()], canResume: false, noReplay: true, deliveryVerified: false, explanation: "Operation-state evidence only; no original resend, closure, resume or verified delivery." });
export const queuedStatusJob = () => ({ ...statusJob(), state: "QUEUED", startedAt: null, completedAt: null, dispatchIntentRecorded: false, queryOutcome: "NOT_DISPATCHED", observation: null, canCancel: true });
export function statusReceipt(job = queuedStatusJob(), replayed = false) { const { canCancel: _control, ...receipt } = job; return { ...receipt, replayed }; }
