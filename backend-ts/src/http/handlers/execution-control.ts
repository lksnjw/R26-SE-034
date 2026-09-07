import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDefinition } from "../generated-routes.js";
import { canReadExecution } from "../execution-scope.js";
import { appendExecutionEvent, assertCurrentRunController } from "../../runner/read-checkpoints.js";
import { appendAudit, HandlerFailure, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import { ok } from "../../models/schemas.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import { recordOperationReconciliation } from "../../runner/operation-reconciliation.js";
import { operationReadbackHistory, operationReadbackQueue } from "../../runner/operation-readback-jobs.js";

export const EXECUTION_CONTROL_UNHANDLED = Symbol("execution-control-unhandled");

export async function handleExecutionControlRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const path = `${services.config.apiBasePath}/executions/:id`;
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
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some((key) => !["after", "limit"].includes(key))) throw new HandlerFailure(400, "Unsupported event query");
    const after = query.after === undefined ? 0 : integer(query.after, 0, Number.MAX_SAFE_INTEGER);
    const limit = query.limit === undefined ? 100 : integer(query.limit, 1, 100);
    const page = await services.repository.read((state) => {
      const item = state.executions[requestParam(request, "id")];
      const stored = state.users[user.id];
      const role = stored && state.roles[stored.roleId];
      const permissions = stored ? [...(role?.permissions ?? []), ...stored.permissionOverrides] : [];
      if (!stored || stored.status.toLowerCase() !== "active" || !permissions.some((key) => ["workflow:read", "execution:read_own"].includes(key)) || !item || !canReadExecution({ id: user.id, permissions }, item)) throw new HandlerFailure(404, "Execution not found");
      const events = state.executionEvents[item.id] ?? [];
      const lastSequence = events.at(-1)?.sequence ?? 0;
      if (after > lastSequence) throw new HandlerFailure(400, "Event cursor is ahead of this execution");
      const batch = events.filter((event) => event.sequence > after).slice(0, limit);
      return { events: withoutSecretFields(structuredClone(batch)), cursor: batch.at(-1)?.sequence ?? after, lastSequence, hasMore: batch.length > 0 && batch.at(-1)!.sequence < lastSequence,
        status: item.status, profile: item.readProgress?.profile ?? "legacy-no-journal" };
    });
    return reply.send(ok(page, "Execution event replay", null));
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
    if (!["RUNNING", "PENDING", ...(operation ? ["AWAITING_APPROVAL"] : [])].includes(execution.status)) throw new HandlerFailure(409, "Execution is not running; cancellation cannot change a terminal outcome");
    if (execution.readProgress?.profile !== "read-progress-v1") throw new HandlerFailure(501, "This legacy execution has no safe cancellation boundary");
    if (!execution.readProgress.cancellation) {
      execution.readProgress.cancellation = { requestedAt: new Date().toISOString(), requestedBy: actor };
      appendExecutionEvent(state, execution, "run.cancel_requested", { requestedBy: actor.id });
      appendAudit(state, { ...user, ...actor }, "execution.cancel_requested", "execution", execution.id, null, { status: "CANCELLATION_REQUESTED", transportInterrupted: false }, request);
    }
    if (operation && ["PENDING", "AWAITING_APPROVAL"].includes(execution.status)) {
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
  return reply.status(item.status === "CANCELLED" ? 200 : 202).send(ok(withoutSecretFields(item), item.status === "CANCELLED" ? "Execution already cancelled" : "Cancellation requested. An in-flight operation may already have taken effect; no further calls will start after cancellation is observed.", { transportInterrupted: false }));
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new HandlerFailure(400, "Invalid event cursor or limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new HandlerFailure(400, "Invalid event cursor or limit");
  return parsed;
}
