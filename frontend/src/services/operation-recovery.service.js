import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const text = (value, maximum = 1000) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const requirements = ["current-capability-validation", "fresh-independent-approval", "new-execution-and-intent", "new-idempotency-boundary"];
function deny() { throw new Error("Linked recovery evidence is unavailable. Reload the exact source case."); }
function artifact(value, executionId) {
  if (!exact(value, ["profile", "id", "state", "source", "action", "createdBy", "createdAt", "requirements", "dispatchAuthority", "sourceRunUnchanged", "artifactHash"]) ||
      value.profile !== "operation-recovery-artifact/v1" || !id(value.id) || value.state !== "REVIEW_REQUIRED" || value.dispatchAuthority !== false || value.sourceRunUnchanged !== true || !hash(value.artifactHash) || !date(value.createdAt) ||
      !Array.isArray(value.requirements) || value.requirements.length !== requirements.length || value.requirements.some((item, index) => item !== requirements[index])) deny();
  const source = value.source, action = value.action;
  if (!exact(source, ["executionId", "workflowId", "workflowVersion", "snapshotHash", "compilationHash", "intentId", "nodeId", "invocationId", "reconciliationId", "queryId", "outcome", "reconciliationRecordedAt"]) ||
      source.executionId !== executionId || !id(source.workflowId) || !Number.isSafeInteger(source.workflowVersion) || source.workflowVersion < 1 || !hash(source.snapshotHash) || !hash(source.compilationHash) ||
      ![source.intentId, source.nodeId, source.invocationId, source.reconciliationId, source.queryId].every(id) || source.outcome !== "NOT_APPLIED" || !date(source.reconciliationRecordedAt) ||
      !exact(action, ["toolId", "toolName", "remoteToolName", "effectClass", "connectionId", "connectionBinding", "capabilityId", "capabilityRevision", "admissionVersion", "contractHash", "argumentHash", "arguments"]) ||
      ![action.toolId, action.connectionId, action.capabilityId, action.capabilityRevision].every(id) || !text(action.toolName, 500) || !text(action.remoteToolName) || !text(action.effectClass, 100) || !text(action.connectionBinding) ||
      !Number.isSafeInteger(action.admissionVersion) || action.admissionVersion < 1 || !hash(action.contractHash) || !hash(action.argumentHash) || !action.arguments || typeof action.arguments !== "object" || Array.isArray(action.arguments) ||
      !exact(value.createdBy, ["id", "role"]) || !id(value.createdBy.id) || !id(value.createdBy.role)) deny();
  return value;
}
function history(value, executionId) {
  const eligible = value?.state === "CLOSED_NOT_APPLIED", keys = ["profile", "sourceExecutionId", "intentId", "sourceVersion", "factsHash", "state", "canCreate", "dispatchAuthority", "artifacts", "explanation", ...(eligible ? ["reconciliationId", "queryId"] : [])];
  if (!exact(value, keys) ||
      value.profile !== "operation-recovery-artifact-history/v1" || value.sourceExecutionId !== executionId || !id(value.intentId) || !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1 || !hash(value.factsHash) ||
      !["CASE_OPEN", "EFFECT_OBSERVED", "EVIDENCE_NOT_QUALIFIED", "CLOSED_NOT_APPLIED"].includes(value.state) || typeof value.canCreate !== "boolean" || value.dispatchAuthority !== false || !Array.isArray(value.artifacts) || value.artifacts.length > 1 || typeof value.explanation !== "string" || !value.explanation ||
      value.canCreate && !eligible || !eligible && value.artifacts.length || eligible && ![value.reconciliationId, value.queryId].every(id)) deny();
  const artifacts = value.artifacts.map(item => artifact(item, executionId));
  if (eligible && value.canCreate !== (artifacts.length === 0)) deny();
  return { ...value, artifacts };
}

export const operationRecoveryService = {
  async history(executionId, options = {}) { return history(unwrap(await apiClient.get(`/executions/${encodeURIComponent(executionId)}/recovery-artifacts`, options)), executionId); },
  async create(source, command) {
    if (!source || !exact(command, ["intentId", "sourceVersion", "factsHash", "reconciliationId", "queryId", "idempotencyKey"]) || command.intentId !== source.intentId || command.sourceVersion !== source.sourceVersion || command.factsHash !== source.factsHash ||
        ![command.reconciliationId, command.queryId].every(id) || typeof command.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(command.idempotencyKey)) deny();
    const value = unwrap(await apiClient.post(`/executions/${encodeURIComponent(source.sourceExecutionId)}/recovery-artifacts`, command));
    if (!exact(value, ["artifact", "replayed"]) || typeof value.replayed !== "boolean") deny();
    return { artifact: artifact(value.artifact, source.sourceExecutionId), replayed: value.replayed };
  },
};
