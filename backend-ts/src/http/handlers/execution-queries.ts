import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { fail, ok } from "../../models/schemas.js";
import { publicExecution } from "../../redact/public-model-usage.js";
import { executionReviewInbox } from "../../runner/execution-review-inbox.js";
import { operationReconciliationView, hasOperationReconciliation } from "../../runner/operation-reconciliation.js";
import { hasReportPageResolution } from "../../runner/report-page-resolution.js";
import { runtimeApprovalAdministration, runtimeApprovalView } from "../../runner/runtime-approvals.js";
import { buildTraceChain } from "../trace-chain.js";
import { canReadExecution, visibleExecutions } from "../execution-scope.js";
import type { RouteDefinition } from "../generated-routes.js";
import { isTraceId } from "../../trace/request-trace.js";
import { HandlerFailure, isRecord, requestParam, stringValue, type CurrentUser, type HandlerServices } from "./common.js";

export const EXECUTION_QUERY_UNHANDLED = Symbol("execution-query-unhandled");

/** Owns read-only execution lists, details, review inbox and approval policy views. */
export async function handleExecutionQueryRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof EXECUTION_QUERY_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/executions` && route.method === "GET") return listExecutions(request, reply, user, services);
  if (route.path === `${base}/execution-reviews` && route.method === "GET") return reviewInbox(request, reply, user, services);
  if (route.path === `${base}/settings/runtime-approval-policy` && route.method === "GET") return approvalPolicy(request, reply, user, services);
  if (route.path === `${base}/executions/:id` && route.method === "GET") return getExecution(request, reply, user, services);
  return EXECUTION_QUERY_UNHANDLED;
}

async function listExecutions(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const state = await services.repository.snapshot();
  const query = request.query as Record<string, unknown>;
  const traceId = stringValue(query.traceId).trim();
  if (traceId !== "") {
    if (!isTraceId(traceId)) return reply.status(400).send(fail("Invalid trace ID", null));
    const chain = buildTraceChain(state, user, traceId);
    return reply.send(ok(chain, "OK", { traceId, count: chain.length }));
  }
  const chatSessionId = stringValue(query.chatSessionId).trim();
  const all = Object.values(state.executions).filter((item) => chatSessionId === "" || item.chatSessionId === chatSessionId);
  const visible = visibleExecutions(user, all);
  return reply.send(ok(visible.map(publicExecution), "OK", {
    page: 1, limit: 20, total: visible.length, totalPages: visible.length === 0 ? 0 : 1,
  }));
}

async function reviewInbox(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  let page;
  try { page = await services.repository.readAuthoritative((state) => executionReviewInbox(state, user, request.query, services.config.jwtSecret)); }
  catch (error) {
    try { services.repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "The review inbox is unavailable until authoritative storage is recovered. No tasks or actions are confirmed."); }
    throw error;
  }
  return reply.send(ok(page, "Current minimum review tasks; no decision or dispatch authority", null));
}

async function approvalPolicy(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  if (!isRecord(request.query) || Object.keys(request.query).length) throw new HandlerFailure(400, "Approval settings do not accept query overrides");
  let view;
  try { view = await services.repository.readAuthoritative((state) => runtimeApprovalAdministration(state, user)); }
  catch (error) {
    try { services.repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "Approval settings are unavailable until authoritative storage is recovered. No policy is confirmed."); }
    throw error;
  }
  return reply.send(ok({ ...view, memoryOnly: services.repository.persistence === null }, "Current exact approval policy; no execution authority", null));
}

async function getExecution(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const query = isRecord(request.query) ? request.query : {};
  if (query.view === "reconciliation") {
    if (Object.keys(query).some((key) => key !== "view")) throw new HandlerFailure(400, "Unsupported reconciliation review query");
    const review = await services.repository.readAuthoritative((state) => operationReconciliationView(state, id, user.id));
    return reply.send(ok(review, "Exact uncertain operation evidence only; no dispatch authority", null));
  }
  if (query.view === "approval") {
    if (Object.keys(query).some((key) => !["view", "approvalId"].includes(key)) ||
        query.approvalId !== undefined && !z.string().min(1).max(256).safeParse(query.approvalId).success)
      throw new HandlerFailure(400, "Unsupported approval review query");
    const review = await services.repository.readAuthoritative((state) => runtimeApprovalView(state, id, user.id, query.approvalId as string | undefined));
    return reply.send(ok(review, "Exact transaction review only; approval does not execute", null));
  }
  if (!user.permissions.some((key) => ["workflow:read", "execution:read_own"].includes(key)))
    return reply.status(404).send(fail("Execution not found", null));
  const item = await services.repository.read((state) => state.executions[id] ?? null);
  if (item === null || !canReadExecution(user, item))
    return reply.status(404).send(fail("Execution not found", null));
  return reply.send(ok(publicExecution({ ...item,
    ...(item.runtimeApprovalSecret ? { hasRuntimeApproval: true } : {}),
    ...(hasOperationReconciliation(item) ? { hasOperationReconciliation: true } : {}),
    ...(hasReportPageResolution(item) ? { hasReportPageResolution: true } : {}),
  }), "OK", null));
}
