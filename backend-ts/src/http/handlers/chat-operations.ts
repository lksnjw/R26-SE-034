import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDefinition } from "../generated-routes.js";
import { ok } from "../../models/schemas.js";
import { activeChatStatus, authorizeChatOperation, chatJobQueue, publicChatOperation, supportsChatJobs } from "../../agent/chat-jobs.js";
import { assertActorAuthority, assertChatAuthority } from "./model-selection.js";
import { HandlerFailure, queryRecord, requestParam, type CurrentUser, type HandlerServices } from "./common.js";

export const CHAT_OPERATION_UNHANDLED = Symbol("chat-operation-unhandled");
export async function handleChatOperationRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices) {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/chat/capabilities` && route.method === "GET") {
    await services.repository.read(state => {
      const permissions = assertActorAuthority(state, user);
      if (!permissions.some(value => ["chat:use", "workflow:write"].includes(value))) throw new HandlerFailure(403, "Chat authority is not available");
    });
    const supported = supportsChatJobs(services);
    return reply.send(ok({ profile: "chat-admission-v1", asyncChat: supported, nodeProposals: supported, localDraftEdits: true }, "Chat admission capabilities; not provider or ERP readiness", null));
  }
  if (route.path === `${base}/chat/sessions/:id/operations`) {
    const values = await services.repository.read(state => {
      const sessionId = requestParam(request, "id"); assertChatAuthority(state, user, sessionId);
      return Object.values(state.chatOperations).filter(op => op.sessionId === sessionId && op.actorId === user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
        .filter(op => { try { authorizeChatOperation(state, op, user); return true; } catch { return false; } })
        .map(op => { const value = publicChatOperation(op); return { ...value, attempts: value.attempts.map(({ output: _output, ...attempt }) => attempt) }; });
    });
    return reply.send(ok(values, "Saved chat operations loaded", null));
  }
  if (route.path === `${base}/chat/operations/:id` && route.method === "GET") {
    const after = queryRecord(request).after ?? "0";
    if (!/^\d+$/.test(String(after)) || !Number.isSafeInteger(Number(after))) throw new HandlerFailure(400, "Invalid chat event cursor");
    const result = await services.repository.read(state => {
      const op = authorizeChatOperation(state, state.chatOperations[requestParam(request, "id")], user);
      const cursor = Number(after), entries = state.chatOperationEvents[op.id] ?? [];
      if (cursor > op.lastSequence || entries.some((event, index) => event.sequence !== index + 1 || event.version !== 1 || event.operationId !== op.id || event.sessionId !== op.sessionId || !Number.isFinite(Date.parse(event.timestamp)) || typeof event.stage !== "string" || typeof event.type !== "string") || entries.length !== op.lastSequence)
        throw new HandlerFailure(409, "Chat event sequence gap; reload from zero", { code: "CHAT_EVENT_GAP" });
      const events = entries.filter(entry => entry.sequence > cursor).slice(0, 100);
      const nextCursor = events.at(-1)?.sequence ?? cursor;
      return { operation: publicChatOperation(op), events, nextCursor, hasMore: nextCursor < op.lastSequence };
    });
    return reply.send(ok(result, "Chat operation progress loaded", null));
  }
  if (route.path === `${base}/chat/operations/:id/cancel`) {
    const operation = await chatJobQueue(services).cancel(requestParam(request, "id"), user);
    return reply.status(activeChatStatus(operation.status) ? 202 : 200).send(ok(operation, "Cancellation requested; remote rollback is not implied", null));
  }
  return CHAT_OPERATION_UNHANDLED;
}
