import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDefinition } from "../generated-routes.js";
import { ok } from "../../models/schemas.js";
import { activeChatStatus, chatJobQueue, supportsChatJobs } from "../../agent/chat-jobs.js";
import { assertActorAuthority } from "./model-selection.js";
import { HandlerFailure, queryRecord, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import { chatTaskAdmissionAvailable } from "../../agent/chat-task-outbox.js";
import { projectChatProgress, projectSessionOperations } from "../../agent/chat-progress.js";
import { progressInteger } from "./execution-events.js";

const ACTIVE_CHAT_STATUSES = new Set(["QUEUED", "RUNNING"]);

export const CHAT_OPERATION_UNHANDLED = Symbol("chat-operation-unhandled");
export async function handleChatOperationRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices) {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/chat/capabilities` && route.method === "GET") {
    await services.repository.read(state => {
      const permissions = assertActorAuthority(state, user);
      if (!permissions.some(value => ["chat:use", "workflow:write"].includes(value))) throw new HandlerFailure(403, "Chat authority is not available");
    });
    const supported = supportsChatJobs(services) && chatTaskAdmissionAvailable(services.repository);
    return reply.send(ok({ profile: "chat-admission-v1", asyncChat: supported, nodeProposals: supported, requestRevisions: supported, localDraftEdits: true }, "Chat admission capabilities; not provider or ERP readiness", null));
  }
  if (route.path === `${base}/chat/sessions/:id/operations`) {
    const values = await services.repository.read(state => projectSessionOperations(state, user, requestParam(request, "id")));
    return reply.send(ok(values, "Saved chat operations loaded", null));
  }
  if (route.path === `${base}/chat/operations/:id` && route.method === "GET") {
    const query = queryRecord(request);
    if (Object.keys(query).some(key => !["after", "waitMs"].includes(key))) throw new HandlerFailure(400, "Unsupported chat progress query");
    const after = query.after ?? "0";
    const waitMs = query.waitMs === undefined ? 0 : progressInteger(query.waitMs, 0, 25_000);
    const operationId = requestParam(request, "id"), startedAt = Date.now();
    let result = await services.repository.readAuthoritative(state => projectChatProgress(state, user, operationId, after));
    let waited = false;
    if (waitMs > 0 && result.events.length === 0 && !result.hasMore && ACTIVE_CHAT_STATUSES.has(result.operation.status)) {
      waited = true;
      const fingerprint = `${result.operation.lastSequence}:${result.operation.status}:${result.operation.stage}`;
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true; clearTimeout(timer); unsubscribe(); request.raw.off("aborted", finish); reply.raw.off("close", disconnected); resolve();
        };
        const disconnected = () => { if (!reply.raw.writableEnded) finish(); };
        const changed = (state: Parameters<Parameters<typeof services.repository.read>[0]>[0]) => {
          try {
            const page = projectChatProgress(state, user, operationId, after);
            return `${page.operation.lastSequence}:${page.operation.status}:${page.operation.stage}` !== fingerprint;
          } catch { return true; }
        };
        const timer = setTimeout(finish, waitMs);
        const unsubscribe = services.repository.observeCommits({ committed: state => { if (changed(state)) finish(); }, unavailable: finish });
        request.raw.once("aborted", finish); reply.raw.once("close", disconnected);
        void services.repository.read(changed).then(value => { if (value) finish(); }, finish);
      });
      result = await services.repository.readAuthoritative(state => projectChatProgress(state, user, operationId, after));
    }
    return reply.send(ok({ ...result, waited, waitedMs: waited ? Date.now() - startedAt : 0 }, waited ? "Chat progress long poll" : "Chat operation progress loaded", null));
  }
  if (route.path === `${base}/chat/operations/:id/cancel`) {
    const operation = await chatJobQueue(services).cancel(requestParam(request, "id"), user);
    return reply.status(activeChatStatus(operation.status) ? 202 : 200).send(ok(operation, "Cancellation requested; remote rollback is not implied", null));
  }
  return CHAT_OPERATION_UNHANDLED;
}
