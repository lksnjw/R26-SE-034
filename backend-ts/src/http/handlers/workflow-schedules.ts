import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import { saveWorkflowSchedule, workflowScheduleView } from "../../runner/workflow-schedules.js";
import { HandlerFailure, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import type { RouteDefinition } from "../generated-routes.js";

export const WORKFLOW_SCHEDULE_UNHANDLED = Symbol("workflow-schedule-unhandled");

export async function handleWorkflowScheduleRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const path = `${services.config.apiBasePath}/workflows/:id/schedule`;
  if (route.path !== path) return WORKFLOW_SCHEDULE_UNHANDLED;
  const workflowId = requestParam(request, "id");
  if (route.method === "GET") {
    if (Object.keys(request.query as Record<string, unknown>).length) throw new HandlerFailure(400, "Schedule status accepts no query overrides");
    const view = await services.repository.readAuthoritative(state => workflowScheduleView(state, workflowId, user));
    return reply.send(ok(view, "Authoritative workflow schedule status", null));
  }
  if (route.method === "PUT") {
    const schedule = await saveWorkflowSchedule(services, workflowId, user, request.body);
    return reply.send(ok(schedule, (schedule as { state?: string } | null)?.state === "ACTIVE" ? "Daily schedule activated" : "Daily schedule paused", null));
  }
  return WORKFLOW_SCHEDULE_UNHANDLED;
}
