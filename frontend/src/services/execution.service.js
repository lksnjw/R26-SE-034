import { apiClient } from "../config/axios";
import { formatDuration, formatTokens, unwrap } from "./api";

/*******************************************************************************
 * Function: normalizeExecution
 *
 * Normalizes execution for the execution service module.
 ******************************************************************************/
export function normalizeExecution(execution) {
  return {
    ...execution,
    workflow: execution.workflowName,
    started: execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "—",
    duration: formatDuration(execution.durationMs),
    tokens: formatTokens(execution.tokens?.total || 0),
    cost: `$${Number(execution.costUsd || 0).toFixed(2)}`,
  };
}

export const executionService = {
/*******************************************************************************
 * Function: list
 *
 * Lists the application for the execution service module.
 ******************************************************************************/
  async list(params = {}) {
    const response = await apiClient.get("/executions", { params });
    return (unwrap(response, []) || []).map(normalizeExecution);
  },
/*******************************************************************************
 * Function: listByChatSession
 *
 * Lists by chat session for the execution service module.
 ******************************************************************************/
  async listByChatSession(chatSessionId) {
    return this.list({ chatSessionId });
  },
/*******************************************************************************
 * Function: get
 *
 * Gets the application for the execution service module.
 ******************************************************************************/
  async get(id, options = {}) {
    return normalizeExecution(unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}`, options)));
  },
  async getApproval(id) {
    const value = unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}`, { params: { view: "approval" } }));
    if (value?.id !== id || value?.runtimeApproval?.profile !== "runtime-approval/v1" || !["PENDING", "APPROVED", "REJECTED", "CONSUMED"].includes(value.runtimeApproval.state) ||
        !Number.isSafeInteger(value.runtimeApproval.version) || value.runtimeApproval.version < 1 || !/^sha256:[a-f0-9]{64}$/.test(value.runtimeApproval.reviewHash) ||
        typeof value.runtimeApproval.canDecide !== "boolean" || value.runtimeApproval.canResume !== false || !value.runtimeApproval.arguments || typeof value.runtimeApproval.arguments !== "object" || Array.isArray(value.runtimeApproval.arguments))
      throw new Error("Exact transaction review is unavailable. Reload before deciding.");
    return value;
  },
  async getReconciliation(id) {
    const value = unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}`, { params: { view: "reconciliation" } }));
    const review = value?.operationReconciliation;
    if (value?.id !== id || review?.profile !== "operation-reconciliation/v1" || !["OPEN", "RESOLVED"].includes(review.state) ||
        !Number.isSafeInteger(review.version) || review.version < 1 || !/^sha256:[a-f0-9]{64}$/.test(review.factsHash) ||
        typeof review.canRecord !== "boolean" || review.canResume !== false || review.noReplay !== true || review.basis !== "operator-attestation" ||
        typeof review.intentId !== "string" || !review.intentId || !Array.isArray(review.history) || review.history.length > 100 ||
        !review.arguments || typeof review.arguments !== "object" || Array.isArray(review.arguments))
      throw new Error("Exact uncertain-operation evidence is unavailable. Reload before recording a decision.");
    return value;
  },
  async reconcile(id, command) {
    return unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/reconcile`, command));
  },
/*******************************************************************************
 * Function: getLogs
 *
 * Gets logs for the execution service module.
 ******************************************************************************/
  async getLogs(id) {
    return unwrap(await apiClient.get(`/executions/${id}/logs`), []);
  },
/*******************************************************************************
 * Function: getTimeline
 *
 * Gets timeline for the execution service module.
 ******************************************************************************/
  async getTimeline(id, options = {}) {
    return unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}/timeline`, options), []);
  },
  async getEvents(id, after = 0, options = {}) {
    return unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}/events`, { ...options, params: { after, limit: 100 } }));
  },
  async cancel(id) {
    // 202 confirms a request, not an interrupted SDK transport or terminal run.
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/cancel`, {})));
  },
/*******************************************************************************
 * Function: getHealingReport
 *
 * Gets healing report for the execution service module.
 ******************************************************************************/
  async getHealingReport(id) {
    return unwrap(await apiClient.get(`/executions/${id}/healing-report`));
  },
/*******************************************************************************
 * Function: run
 *
 * Runs the application for the execution service module.
 ******************************************************************************/
  async run(workflowId, input = {}, options = {}) {
    // Transitional synchronous deterministic read execution. This timeout is
    // not retry safety, cancellation, durable jobs or a latency guarantee.
    return normalizeExecution(
      unwrap(await apiClient.post(`/workflows/${workflowId}/run`, { input, ...options }, { timeout: 300000 })),
    );
  },
/*******************************************************************************
 * Function: retry
 *
 * Performs the retry operation on the application for the execution service module.
 ******************************************************************************/
  async retry(id, input = {}) {
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${id}/retry`, { input }, { timeout: 300000 })));
  },
/*******************************************************************************
 * Function: approve
 *
 * Performs the approve operation on the application for the execution service module.
 ******************************************************************************/
  async approve(id, command) {
    if (!command || typeof command !== "object") throw new Error("An exact transaction review is required; a note is not approval.");
    return unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/approve`, command));
  },
/*******************************************************************************
 * Function: reject
 *
 * Performs the reject operation on the application for the execution service module.
 ******************************************************************************/
  async reject(id, command) {
    if (!command || typeof command !== "object") throw new Error("An exact transaction review is required before rejection.");
    return unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/reject`, command));
  },
};
