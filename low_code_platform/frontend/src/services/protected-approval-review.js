// Presentation consistency only. A browser response is never dispatch authority;
// the server independently authenticates every review and decision.
const bounded = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

export function validProtectedApprovalReview(review, executionStatus) {
  if (review?.profile !== "protected-approval/v1" || review.protectedInvocationManaged !== true || review.operationManaged !== false ||
      review.canResume !== false || review.resumeQueued !== false || !["PENDING", "APPROVED", "REJECTED", "CONSUMED", "EXPIRED", "CLOSED"].includes(review.state) ||
      !review.arguments || typeof review.arguments !== "object" || Array.isArray(review.arguments) || typeof review.canDecide !== "boolean" ||
      !["id", "nodeId", "connectionId", "capabilityRevision", "toolName", "remoteToolName", "requesterId", "approverRole"].every(key => bounded(review[key])) ||
      !hash(review.sourceHash) || !hash(review.semanticHash) || !date(review.requestedAt) || !date(review.expiresAt) ||
      Date.parse(review.expiresAt) <= Date.parse(review.requestedAt) || !Array.isArray(review.iterations) || review.iterations.length > 8 ||
      !bounded(review.invocationId, 1100) || review.unavailable !== null && !bounded(review.unavailable, 2000)) return false;
  const loops = new Set();
  for (const frame of review.iterations) {
    if (!exact(frame, ["loopId", "index"]) || !bounded(frame.loopId) || frame.loopId.includes("/") || loops.has(frame.loopId) ||
        !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index > 99) return false;
    loops.add(frame.loopId);
  }
  if (review.nodeId.includes("/") || review.invocationId !== [...review.iterations.flatMap(frame => [frame.loopId, String(frame.index)]), review.nodeId].join("/")) return false;
  const decision = review.decision, closure = review.closure;
  if (decision !== null && (!exact(decision, ["outcome", "actorId", "decidedAt"]) || !["APPROVED", "REJECTED"].includes(decision.outcome) ||
      !bounded(decision.actorId) || decision.actorId === review.requesterId || !date(decision.decidedAt) ||
      Date.parse(decision.decidedAt) < Date.parse(review.requestedAt) || Date.parse(decision.decidedAt) >= Date.parse(review.expiresAt))) return false;
  if (review.version !== 1 + Number(!!decision) + Number(["CONSUMED", "EXPIRED", "CLOSED"].includes(review.state)) ||
      review.state === "PENDING" && !!decision || ["APPROVED", "CONSUMED"].includes(review.state) && decision?.outcome !== "APPROVED" ||
      review.state === "REJECTED" && decision?.outcome !== "REJECTED" || ["EXPIRED", "CLOSED"].includes(review.state) && decision?.outcome === "REJECTED" ||
      review.canDecide && (review.state !== "PENDING" || executionStatus !== "AWAITING_APPROVAL" || review.unavailable !== null)) return false;
  if (review.state === "CLOSED") {
    if (!exact(closure, ["reason", "status", "closedAt"]) || !["PROTECTED_APPROVAL_CANCELLED", "PROTECTED_APPROVAL_CONTEXT_CHANGED"].includes(closure.reason) ||
        closure.status !== (closure.reason === "PROTECTED_APPROVAL_CANCELLED" ? "CANCELLED" : "FAILED") || executionStatus !== closure.status ||
        !date(closure.closedAt) || Date.parse(closure.closedAt) < Date.parse(decision?.decidedAt ?? review.requestedAt)) return false;
  } else if (closure !== null) return false;
  return review.state === "EXPIRED" ? date(review.expiredAt) && Date.parse(review.expiredAt) >= Date.parse(review.expiresAt) : review.expiredAt === null;
}
