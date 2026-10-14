import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDefinition } from "../generated-routes.js";
import { appendExecutionEvent, assertCurrentRunController } from "../../runner/read-checkpoints.js";
import { appendAudit, HandlerFailure, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import { ok } from "../../models/schemas.js";
import { publicExecution } from "../../redact/public-model-usage.js";
import { recordOperationReconciliation } from "../../runner/operation-reconciliation.js";
import { operationReadbackHistory, operationReadbackQueue } from "../../runner/operation-readback-jobs.js";
import { admitOperationRecovery, createOperationRecoveryArtifact, operationRecoveryArtifactView } from "../../runner/operation-recovery-artifacts.js";
import { requestTraceId } from "../../trace/request-trace.js";
import { reportPageResolutionView, resolveReportPage } from "../../runner/report-page-resolution.js";
import { handleExecutionEvents } from "./execution-events.js";
import { settleProtectedApprovalWait } from "../../runner/protected-approval-wait.js";
import { restoreProtectedJob, sealProtectedCursor } from "../../runner/protected-job-state.js";

export const EXECUTION_CONTROL_UNHANDLED = Symbol("execution-control-unhandled");

export async function handleExecutionControlRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const path = `${services.config.apiBasePath}/executions/:id`;
  if (route.path === `${path}/report-page-resolutions` && route.method === "GET") {
    if (Object.keys(request.query as Record<string, unknown>).length) throw new HandlerFailure(400, "Report-page resolution accepts no query overrides");
    let view;
    try { view = await services.repository.readAuthoritative(state => reportPageResolutionView(state, requestParam(request, "id"), user.id)); }
    catch (error) {
      try { services.repository.assertAuthority(); }
      catch { throw new HandlerFailure(503, "Report-page resolution is unavailable until authoritative storage is recovered. No page evidence is confirmed."); }
      throw error;
    }
    return reply.send(ok(view, "Exact uncertain report-page evidence; no page replay or effect authority", null));
  }
  if (route.path === `${path}/report-page-resolutions` && route.method === "POST") {
    const result = await resolveReportPage(services.repository, requestParam(request, "id"), user, request.body);
    return reply.status(result.resumeQueued ? 202 : 200).send(ok(result, result.resumeQueued ?
      "Captured page validated; continuation queued without replaying the uncertain page" :
      "Uncertain report occurrence abandoned; no page replay or effect dispatch", null));
  }
  if (route.path === `${path}/recovery-artifacts/:artifactId/admit` && route.method === "POST") {
    const receipt = await admitOperationRecovery(services, requestParam(request, "id"), requestParam(request, "artifactId"), user, request.body, requestTraceId(request));
    return reply.status(202).send(ok(receipt, receipt.replayed ? "Existing separate recovery execution found; no additional run admitted" : "Separate recovery execution queued; fresh independent approval is required", null));
  }
  if (route.path === `${path}/recovery-artifacts` && route.method === "GET") {
    if (Object.keys(request.query as Record<string, unknown>).length) throw new HandlerFailure(400, "Recovery artifact history accepts no query overrides");
    let history;
    try { history = await services.repository.readAuthoritative(state => operationRecoveryArtifactView(state, requestParam(request, "id"), user.id)); }
    catch (error) {
      try { services.repository.assertAuthority(); }
      catch { throw new HandlerFailure(503, "Recovery artifact history is unavailable until authoritative storage is recovered"); }
      throw error;
    }
    return reply.send(ok(history, "Immutable linked recovery plans; no dispatch authority", null));
  }
  if (route.path === `${path}/recovery-artifacts` && route.method === "POST") {
    const receipt = await createOperationRecoveryArtifact(services.repository, requestParam(request, "id"), user, request.body);
    return reply.status(receipt.replayed ? 200 : 201).send(ok(receipt, "Recovery plan saved; no execution, resume or replay", null));
  }
  if (route.path === `${path}/readbacks` && route.method === "GET") {
    if (Object.keys(request.query as Record<string, unknown>).length) throw new HandlerFailure(400, "Status query history accepts no query overrides");
    let history;
    try { history = await services.repository.readAuthoritative(state => operationReadbackHistory(state, services, requestParam(request, "id"), user.id)); }
    catch (error) {
      try { services.repository.assertAuthority(); }
      catch { throw new HandlerFailure(503, "Status query history is unavailable until authoritative storage is recovered. No evidence is confirmed."); }
      throw error;
    }
    return reply.send(ok(history, "Reviewed status queries; no original resend, resolution or resume", null));
  }
  if (route.path === `${path}/readbacks` && route.method === "POST") {
    const receipt = await operationReadbackQueue(services).admit(requestParam(request, "id"), user, request.body);
    return reply.status(202).send(ok(receipt, "Read-only status query admitted; the original action remains uncertain", null));
  }
  if (route.path === `${path}/readbacks/:queryId/cancel` && route.method === "POST") {
    if (request.body !== undefined && (typeof request.body !== "object" || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length)) throw new HandlerFailure(400, "Query cancellation accepts an empty body");
    const receipt = await operationReadbackQueue(services).cancel(requestParam(request, "id"), requestParam(request, "queryId"), user);
    return reply.status(receipt.state === "RUNNING" ? 202 : 200).send(ok(receipt, "Query cancellation only; no original effect replay or resume", null));
  }
  if (route.path === `${path}/reconcile` && route.method === "POST") {
    const receipt = await recordOperationReconciliation(services.repository, requestParam(request, "id"), user, request.body);
    return reply.send(ok(receipt, "External evidence recorded; no execution, resume or replay", null));
  }
  if (route.path === `${path}/events` && route.method === "GET") {
    return handleExecutionEvents(request, reply, user, services);
  }
  if (route.path !== `${path}/cancel` || route.method !== "POST") return EXECUTION_CONTROL_UNHANDLED;
  if (request.body !== undefined && (typeof request.body !== "object" || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length > 0)) throw new HandlerFailure(400, "Cancellation accepts an empty body");
  const item = await services.repository.mutate((state) => {
    const execution = state.executions[requestParam(request, "id")];
    if (!execution) throw new HandlerFailure(404, "Execution not found");
    let actor;
    try { actor = assertCurrentRunController(state, execution, user.id); }
    catch { throw new HandlerFailure(404, "Execution not controllable by the current user"); }
    if (execution.status === "CANCELLED") return structuredClone(execution);
    const operation = execution.workflowSnapshot?.executionProfile === "sequential-operation-v1" && execution.operationSecret?.profile === "operation-job/v1";
    const protectedJob = execution.protectedJobSecret;
    if (!["RUNNING", "PENDING", ...(operation ? ["AWAITING_APPROVAL"] : []), ...(protectedJob?.state === "WAITING" ? ["AWAITING_APPROVAL", "BLOCKED"] : [])].includes(execution.status)) throw new HandlerFailure(409, "Execution is not running; cancellation cannot change a terminal outcome");
    if (execution.readProgress?.profile !== "read-progress-v1") throw new HandlerFailure(501, "This legacy execution has no safe cancellation boundary");
    if (!execution.readProgress.cancellation) {
      execution.readProgress.cancellation = { requestedAt: new Date().toISOString(), requestedBy: actor };
      appendExecutionEvent(state, execution, "run.cancel_requested", { requestedBy: actor.id });
      appendAudit(state, { ...user, ...actor }, "execution.cancel_requested", "execution", execution.id, null, { status: "CANCELLATION_REQUESTED", transportInterrupted: false }, request);
    }
    if (protectedJob?.state === "WAITING") {
      settleProtectedApprovalWait(state, services, execution.id);
    } else if (protectedJob?.state === "QUEUED") {
      const saved = restoreProtectedJob(state, services, execution.id), pending = Object.values(saved.ledger.snapshot().intents)
        .filter(intent => intent.sequence === saved.machine.snapshot().sequence), entered = pending.some(intent => ["DISPATCH_INTENT", "UNKNOWN"].includes(intent.state));
      for (const intent of pending) if (intent.state === "DISPATCH_INTENT") saved.ledger.unknown(saved.machine, intent.key, intent.epoch);
      execution.protectedInvocationSecret = saved.ledger.snapshot(); protectedJob.state = entered ? "RECOVERY_REQUIRED" : "FINISHED"; delete protectedJob.lease;
      execution.status = entered ? "RECOVERY_REQUIRED" : "CANCELLED"; execution.completedAt = new Date().toISOString();
      execution.durationMs = Math.max(0, Date.parse(execution.completedAt) - Date.parse(execution.startedAt));
      execution.agentSummary = entered ? "Cancellation preserved an unconfirmed invocation. It was not replayed; reconciliation is required." : "Protected queued run cancelled before further dispatch. Earlier confirmed results remain saved.";
      sealProtectedCursor(services, state, execution, saved.machine);
      appendExecutionEvent(state, execution, entered ? "run.recovery_required" : "run.completed", { status: execution.status });
    } else if (operation && ["PENDING", "AWAITING_APPROVAL"].includes(execution.status)) {
      if (!["QUEUED", "WAITING"].includes(execution.operationSecret!.state)) throw new HandlerFailure(409, "Operation has no cancellable queue or approval wait");
      execution.operationSecret!.state = "FINISHED"; delete execution.operationSecret!.lease;
      execution.status = "CANCELLED"; execution.completedAt = new Date().toISOString(); execution.durationMs = Math.max(0, Date.parse(execution.completedAt) - Date.parse(execution.startedAt));
      delete execution.pendingApproval;
      for (const attempt of Object.values(execution.readProgress.attempts)) if (attempt.status === "PREPARING") { attempt.status = "CANCELLED"; attempt.completedAt = execution.completedAt;
        const entry = state.timelines[execution.id]?.find(entry => entry.attemptId === attempt.id); if (entry) { entry.status = "CANCELLED"; entry.completedAt = execution.completedAt; entry.outcome = "NOT_DISPATCHED"; }
      }
      execution.agentSummary = "Operation cancelled before a new dispatch. Previous acknowledged results remain saved.";
      appendExecutionEvent(state, execution, "run.completed", { status: "CANCELLED", outcome: "NOT_DISPATCHED" });
    } else if (execution.status === "PENDING") {
      const job = state.readJobs[execution.id];
      if (job?.state !== "QUEUED") throw new HandlerFailure(409, "Pending run has no cancellable queued job");
      job.state = "FINISHED"; job.finishedAt = new Date().toISOString(); delete job.inputCiphertext;
      execution.status = "CANCELLED"; execution.completedAt = job.finishedAt; execution.durationMs = Math.max(0, Date.parse(job.finishedAt) - Date.parse(execution.startedAt));
      execution.agentSummary = "Queued read job cancelled before worker dispatch. No ERP read was started.";
      appendExecutionEvent(state, execution, "run.completed", { status: "CANCELLED", outcome: "NOT_DISPATCHED" });
    }
    return structuredClone(execution);
  });
  return reply.status(item.status === "CANCELLED" ? 200 : 202).send(ok(publicExecution(item), item.status === "CANCELLED" ? "Execution already cancelled" : "Cancellation requested. An in-flight operation may already have taken effect; no further calls will start after cancellation is observed.", { transportInterrupted: false }));
}
