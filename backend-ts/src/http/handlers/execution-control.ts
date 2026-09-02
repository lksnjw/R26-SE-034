import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDefinition } from "../generated-routes.js";
import { canReadExecution } from "../execution-scope.js";
import { appendExecutionEvent, assertCurrentRunController } from "../../runner/read-checkpoints.js";
import { appendAudit, HandlerFailure, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import { ok } from "../../models/schemas.js";
import { withoutSecretFields } from "../../redact/secrets.js";

export const EXECUTION_CONTROL_UNHANDLED = Symbol("execution-control-unhandled");

export async function handleExecutionControlRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const path = `${services.config.apiBasePath}/executions/:id`;
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
    if (!["RUNNING", "PENDING"].includes(execution.status)) throw new HandlerFailure(409, "Execution is not running; cancellation cannot change a terminal outcome");
    if (execution.readProgress?.profile !== "read-progress-v1") throw new HandlerFailure(501, "This legacy execution has no safe cancellation boundary");
    if (!execution.readProgress.cancellation) {
      execution.readProgress.cancellation = { requestedAt: new Date().toISOString(), requestedBy: actor };
      appendExecutionEvent(state, execution, "run.cancel_requested", { requestedBy: actor.id });
      appendAudit(state, { ...user, ...actor }, "execution.cancel_requested", "execution", execution.id, null, { status: "CANCELLATION_REQUESTED", transportInterrupted: false }, request);
    }
    if (execution.status === "PENDING") {
      const job = state.readJobs[execution.id];
      if (job?.state !== "QUEUED") throw new HandlerFailure(409, "Pending run has no cancellable queued job");
      job.state = "FINISHED"; job.finishedAt = new Date().toISOString(); delete job.inputCiphertext;
      execution.status = "CANCELLED"; execution.completedAt = job.finishedAt; execution.durationMs = Math.max(0, Date.parse(job.finishedAt) - Date.parse(execution.startedAt));
      execution.agentSummary = "Queued read job cancelled before worker dispatch. No ERP read was started.";
      appendExecutionEvent(state, execution, "run.completed", { status: "CANCELLED", outcome: "NOT_DISPATCHED" });
    }
    return structuredClone(execution);
  });
  return reply.status(item.status === "CANCELLED" ? 200 : 202).send(ok(item, item.status === "CANCELLED" ? "Execution already cancelled" : "Cancellation requested. Any in-flight read must finish; no further calls will start after the request is observed.", { transportInterrupted: false }));
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new HandlerFailure(400, "Invalid event cursor or limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new HandlerFailure(400, "Invalid event cursor or limit");
  return parsed;
}
