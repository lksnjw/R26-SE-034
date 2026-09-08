import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const states = ["QUEUED", "RUNNING", "ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"];
const failures = ["READBACK_BLOCKED_BEFORE_DISPATCH", "READBACK_INTERRUPTED", "READBACK_RESULT_UNQUALIFIED", "READBACK_CANCELLED"];
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const deny = () => { const error = new Error("Exact status-query evidence is unavailable. Reload saved history; do not assume the original action succeeded."); error.code = "STATUS_QUERY_EVIDENCE_UNAVAILABLE"; throw error; };
const jobKeys = ["id", "executionId", "intentId", "nodeId", "state", "createdAt", "startedAt", "completedAt", "actorId", "basis", "dispatchIntentRecorded", "queryOutcome", "observation", "failure", "cancellationRequested", "canResolve", "canResume", "noReplay", "deliveryVerified"];

export function validateStatusQuery(value, source, { receipt = false, history = false } = {}) {
  if (!exact(value, [...jobKeys, ...(receipt ? ["replayed"] : []), ...(history ? ["canCancel"] : [])]) || !id(value.id) || value.executionId !== source.executionId ||
      value.intentId !== source.intentId || value.nodeId !== source.nodeId || !id(value.actorId) || !states.includes(value.state) || !date(value.createdAt) ||
      value.startedAt !== null && !date(value.startedAt) || value.completedAt !== null && !date(value.completedAt) || value.basis !== "queried-operation-state" ||
      typeof value.dispatchIntentRecorded !== "boolean" || typeof value.cancellationRequested !== "boolean" || typeof value.canResolve !== "boolean" ||
      value.canResolve && (value.state !== "ANSWERED" || !value.observation?.settled || value.observation.outcome === "UNRESOLVED") ||
      value.canResume !== false || value.noReplay !== true || value.deliveryVerified !== false ||
      history && (typeof value.canCancel !== "boolean" || value.canCancel && !["QUEUED", "RUNNING"].includes(value.state)) || receipt && typeof value.replayed !== "boolean") deny();
  const terminal = !["QUEUED", "RUNNING"].includes(value.state);
  if (terminal !== !!value.completedAt || value.state === "RUNNING" && !value.startedAt || value.dispatchIntentRecorded && !value.startedAt ||
      value.startedAt && Date.parse(value.startedAt) < Date.parse(value.createdAt) || value.completedAt && Date.parse(value.completedAt) < Date.parse(value.startedAt || value.createdAt)) deny();
  if (value.state === "ANSWERED") {
    const result = value.observation;
    if (!exact(result, ["profile", "outcome", "observedAt", "settled", "evidenceMeaning", "canResume", "noReplay", "deliveryVerified"]) || result.profile !== "operation-readback-evaluation/v1" ||
        !["APPLIED", "NOT_APPLIED", "UNRESOLVED"].includes(result.outcome) || !date(result.observedAt) || typeof result.settled !== "boolean" ||
        !result.settled && result.outcome !== "UNRESOLVED" || result.evidenceMeaning !== "operation-state" || result.canResume !== false || result.noReplay !== true || result.deliveryVerified !== false ||
        !value.dispatchIntentRecorded || value.queryOutcome !== "ANSWER_CONFIRMED" || value.failure !== null || Date.parse(result.observedAt) > Date.parse(value.completedAt) + 30000) deny();
  } else {
    if (value.observation !== null || (terminal ? !failures.includes(value.failure) : value.failure !== null)) deny();
    const outcome = value.failure === "READBACK_RESULT_UNQUALIFIED" ? "UNQUALIFIED_RESULT" : value.dispatchIntentRecorded ? "UNKNOWN" : "NOT_DISPATCHED";
    if (value.queryOutcome !== outcome || value.state === "RECOVERY_REQUIRED" && (!value.dispatchIntentRecorded || value.failure !== "READBACK_INTERRUPTED") ||
        value.state === "CANCELLED" && (value.dispatchIntentRecorded || value.failure !== "READBACK_CANCELLED" || !value.cancellationRequested) ||
        value.state === "QUEUED" && (value.startedAt || value.dispatchIntentRecorded || value.cancellationRequested) ||
        value.failure === "READBACK_RESULT_UNQUALIFIED" && (value.state !== "FAILED" || !value.dispatchIntentRecorded)) deny();
  }
  return value;
}

export function validateStatusHistory(value, executionId, expected = {}) {
  if (!exact(value, ["profile", "executionId", "intentId", "nodeId", "baseVersion", "factsHash", "canQuery", "memoryOnly", "jobs", "canResume", "noReplay", "deliveryVerified", "explanation"]) ||
      value.profile !== "operation-readback-history/v1" || value.executionId !== executionId || !id(value.intentId) || !id(value.nodeId) ||
      expected.intentId && value.intentId !== expected.intentId || expected.nodeId && value.nodeId !== expected.nodeId ||
      !Number.isSafeInteger(value.baseVersion) || value.baseVersion < 1 || !hash(value.factsHash) || typeof value.canQuery !== "boolean" || typeof value.memoryOnly !== "boolean" ||
      value.canResume !== false || value.noReplay !== true || value.deliveryVerified !== false || !Array.isArray(value.jobs) || value.jobs.length > 100 ||
      typeof value.explanation !== "string" || !value.explanation || value.explanation.length > 2000) deny();
  const ids = new Set();
  for (const job of value.jobs) { validateStatusQuery(job, value, { history: true }); if (ids.has(job.id)) deny(); ids.add(job.id); }
  if (value.canQuery && (value.jobs.length >= 100 || value.jobs.some(job => ["QUEUED", "RUNNING"].includes(job.state)))) deny();
  return value;
}

const path = executionId => `/executions/${encodeURIComponent(executionId)}/readbacks`;
export const operationReadbackService = {
  async history(executionId, expected = {}, signal) {
    return validateStatusHistory(unwrap(await apiClient.get(path(executionId), { signal })), executionId, expected);
  },
  async admit(source, command) {
    if (!exact(command, ["intentId", "baseVersion", "factsHash", "idempotencyKey"]) || command.intentId !== source.intentId || !Number.isSafeInteger(command.baseVersion) || command.baseVersion < 1 ||
        !hash(command.factsHash) || typeof command.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(command.idempotencyKey)) deny();
    return validateStatusQuery(unwrap(await apiClient.post(path(source.executionId), command)), source, { receipt: true });
  },
  async cancel(source, queryId) {
    const result = validateStatusQuery(unwrap(await apiClient.post(`${path(source.executionId)}/${encodeURIComponent(queryId)}/cancel`, {})), source);
    if (result.id !== queryId) deny();
    return result;
  },
};
