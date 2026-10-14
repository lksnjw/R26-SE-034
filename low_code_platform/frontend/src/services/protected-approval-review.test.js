import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { executionService } from "./execution.service";
import { validProtectedApprovalReview } from "./protected-approval-review";

afterEach(() => jest.restoreAllMocks());
const initial = () => ({ id: "run/one", status: "AWAITING_APPROVAL", runtimeApproval: { profile: "protected-approval/v1", id: "review", version: 1,
  state: "PENDING", reviewHash: `sha256:${"a".repeat(64)}`, nodeId: "send", invocationId: "each/1/nested/0/send",
  iterations: [{ loopId: "each", index: 1 }, { loopId: "nested", index: 0 }], connectionId: "erpbridge-default", capabilityRevision: "reviewed-revision",
  toolName: "Send exact report", remoteToolName: "fixture.send", requesterId: "requester", approverRole: "Manager",
  sourceHash: `sha256:${"b".repeat(64)}`, semanticHash: `sha256:${"c".repeat(64)}`,
  requestedAt: "2026-10-09T10:00:00.000Z", expiresAt: "2026-10-09T10:01:00.000Z", arguments: { recipient: "manager@example.test", body: "Exact item report" },
  unavailable: null, canDecide: true, operationManaged: false, protectedInvocationManaged: true, canResume: false, resumeQueued: false,
  decision: null, closure: null, expiredAt: null } });
const decided = outcome => ({ outcome, actorId: "reviewer", decidedAt: "2026-10-09T10:00:10.000Z" });
const envelope = value => ({ data: { success: true, data: value } });

test.each(["PENDING", "APPROVED", "REJECTED", "CONSUMED", "EXPIRED", "CLOSED"])("exact %s protected review stays compatible without granting effect resumption", async state => {
  const value = initial(), review = value.runtimeApproval;
  review.state = state; review.canDecide = state === "PENDING";
  if (["APPROVED", "CONSUMED", "REJECTED"].includes(state)) { review.decision = decided(state === "REJECTED" ? "REJECTED" : "APPROVED"); review.version++; }
  if (["CONSUMED", "EXPIRED", "CLOSED"].includes(state)) review.version++;
  if (state === "APPROVED") value.status = "BLOCKED";
  if (state === "REJECTED" || state === "EXPIRED") value.status = "FAILED";
  if (state === "CONSUMED") value.status = "DONE";
  if (state === "EXPIRED") review.expiredAt = review.expiresAt;
  if (state === "CLOSED") { value.status = "CANCELLED"; review.closure = { reason: "PROTECTED_APPROVAL_CANCELLED", status: "CANCELLED", closedAt: "2026-10-09T10:00:20.000Z" }; }
  const get = jest.spyOn(apiClient, "get").mockResolvedValue(envelope(value));
  expect(await executionService.getApproval(value.id, "review")).toEqual(value);
  expect(get).toHaveBeenCalledWith("/executions/run%2Fone", { params: { view: "approval", approvalId: "review" } });
  expect(value.runtimeApproval.canResume).toBe(false);
});

test.each(["tuple", "index", "frame-extra", "duplicate-loop", "missing-frames", "node", "source", "semantic", "expiry", "request", "decision", "self", "decision-clock",
  "version", "profile", "managed", "resume", "queued", "inactive-state", "closed-missing", "closure-status", "closure-clock", "ambiguous-terminal", "expiry-clock", "can-decide", "unavailable", "historical-id", "arguments"])("inconsistent %s review locks display without substituting legacy approval authority", async damage => {
  const value = initial(), review = value.runtimeApproval;
  if (damage === "tuple") review.invocationId = "each/0/nested/0/send";
  if (damage === "index") review.iterations[0].index = -1;
  if (damage === "frame-extra") review.iterations[0].approved = true;
  if (damage === "duplicate-loop") review.iterations[1].loopId = "each";
  if (damage === "missing-frames") delete review.iterations;
  if (damage === "node") review.nodeId = "foreign";
  if (damage === "source") review.sourceHash = "not-source";
  if (damage === "semantic") review.semanticHash = "not-semantic";
  if (damage === "expiry") review.expiresAt = review.requestedAt;
  if (damage === "request") review.requestedAt = "not-a-date";
  if (["decision", "self", "decision-clock"].includes(damage)) {
    review.state = "APPROVED"; review.version = 2; review.canDecide = false;
    review.decision = damage === "decision" ? null : decided("APPROVED");
    if (damage === "self") review.decision.actorId = review.requesterId;
    if (damage === "decision-clock") review.decision.decidedAt = review.expiresAt;
  }
  if (damage === "version") review.version++;
  if (damage === "profile") review.profile = "future-approval/v1";
  if (damage === "managed") review.operationManaged = true;
  if (damage === "resume") review.canResume = true;
  if (damage === "queued") review.resumeQueued = true;
  if (damage === "inactive-state") review.state = "DELIVERED";
  if (["closed-missing", "closure-status", "closure-clock", "ambiguous-terminal"].includes(damage)) {
    review.state = "CLOSED"; review.version = 2; review.canDecide = false; value.status = "CANCELLED";
    review.closure = damage === "closed-missing" ? null : { reason: "PROTECTED_APPROVAL_CANCELLED", status: "CANCELLED", closedAt: "2026-10-09T10:00:20.000Z" };
    if (damage === "closure-status") review.closure.status = "FAILED";
    if (damage === "closure-clock") review.closure.closedAt = "2026-10-09T09:59:59.000Z";
    if (damage === "ambiguous-terminal") review.expiredAt = review.expiresAt;
  }
  if (damage === "expiry-clock") { review.state = "EXPIRED"; review.version = 2; review.canDecide = false; review.expiredAt = review.requestedAt; }
  if (damage === "can-decide") value.status = "CANCELLED";
  if (damage === "unavailable") review.unavailable = "Authorization changed";
  if (damage === "historical-id") review.id = "foreign-review";
  if (damage === "arguments") review.arguments = [];
  jest.spyOn(apiClient, "get").mockResolvedValue(envelope(value));
  const post = jest.spyOn(apiClient, "post");
  await expect(executionService.getApproval(value.id, "review")).rejects.toThrow(/Exact transaction review/);
  expect(post).not.toHaveBeenCalled();
});

test("approved then closed history preserves its independent decision and original item", () => {
  const value = initial(), review = value.runtimeApproval;
  Object.assign(review, { state: "CLOSED", version: 3, canDecide: false, decision: decided("APPROVED"),
    closure: { reason: "PROTECTED_APPROVAL_CONTEXT_CHANGED", status: "FAILED", closedAt: "2026-10-09T10:00:20.000Z" } }); value.status = "FAILED";
  expect(validProtectedApprovalReview(review, value.status)).toBe(true);
});
