import type { FastifyReply, FastifyRequest } from "fastify";
import { activeChatStatus } from "../../agent/chat-jobs.js";
import { chatRequestSourceHash } from "../../agent/chat-request-revisions.js";
import { ok } from "../../models/schemas.js";
import { assertChatAuthority, requestedModel, selectProvider } from "./model-selection.js";
import { bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, numberValue, paginate, queryRecord, requestParam, stringValue } from "./common.js";

/*******************************************************************************
 * Function: chatSummary
 *
 * Returns chat metadata without the messages array.
 ******************************************************************************/
export function chatSummary(chat: { messages: unknown[] } & Record<string, unknown>): Record<string, unknown> { const { messages: _messages, ...summary } = chat; return summary; }
// The frontend only ever reads `artifacts.retrieval` off the LAST message
// that has one (see useChat.js: `[...messages].reverse().find(...)`) — so
// carrying the full tool/rule/example retrieval payload (up to ~100 tool
// records) on every older workflow-generation message in a session is pure
// waste. A chat with several such messages balloons past what Azure's
// ingress will reliably relay in one response (silent truncation ->
// net::ERR_HTTP2_PROTOCOL_ERROR client-side). Strip it from everything but
// the newest occurrence before returning the full session.
/*******************************************************************************
 * Function: trimRedundantRetrieval
 *
 * Removes retrieval entries already represented by validation artifacts.
 ******************************************************************************/
function trimRedundantRetrieval(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let lastRetrievalIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const artifacts = messages[i]!.artifacts;
    if (isRecord(artifacts) && artifacts.retrieval !== undefined) { lastRetrievalIndex = i; break; }
  }
  return messages.map((message, index) => {
    const artifacts = message.artifacts;
    if (!isRecord(artifacts) || artifacts.retrieval === undefined || index === lastRetrievalIndex) return message;
    const { retrieval: _retrieval, ...rest } = artifacts;
    return { ...message, artifacts: rest };
  });
}
/*******************************************************************************
 * Function: listChats
 *
 * Returns chat sessions visible to the current user.
 ******************************************************************************/
export async function listChats(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const chats = await services.repository.read((state) => Object.values(state.chats).filter((item) => user.permissions.includes("workflow:read") || item.ownerId === user.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => chatSummary(item))); const page = paginate(chats, request); return reply.send(ok(page.items, "OK", page.meta)); }
/*******************************************************************************
 * Function: createChat
 *
 * Creates a chat session owned by the current user.
 ******************************************************************************/
export async function createChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const body = request.body === undefined ? {} : bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const chat = await services.repository.mutate((state) => { const id = nextID(state, "chat"); const timestamp = now(); const value = { id, ownerId: user.id, title: stringValue(body.title).trim() === "" ? "New conversation" : stringValue(body.title), createdAt: timestamp, updatedAt: timestamp, messageCount: 0, messages: [] }; state.chats[id] = value; return value; }); return reply.status(201).send(ok(chatSummary(chat), "Chat session created", null)); }
/*******************************************************************************
 * Function: getChat
 *
 * Returns a chat session when it is visible to the current user. Messages
 * are paginated — without a real limit, a long conversation's full history
 * (with all its workflow-generation artifacts) can push a single response
 * past platform-level proxy buffer limits and get silently truncated in
 * transit. Defaults to the most recent `limit` messages; pass `before=<id>`
 * to page further back in history.
 ******************************************************************************/
export async function getChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const chat = await services.repository.read((state) => {
    const value = state.chats[requestParam(request, "id")];
    if (value === undefined || (!user.permissions.includes("workflow:read") && value.ownerId !== user.id)) return null;
    const copy = structuredClone(value);
    copy.messages = copy.messages.map(message => {
      const operation = state.chatOperations[stringValue(message.operationId)];
      return message.role === "user" && value.ownerId === user.id && operation?.actorId === user.id && operation.sessionId === value.id && operation.userMessageId === message.id && operation.revisionContextCiphertext
        ? { ...message, revisionSource: { messageId: message.id, sourceHash: chatRequestSourceHash(message), nodeContext: operation.nodeContext ?? null } }
        : message;
    });
    for (const message of copy.messages) {
      if (!isRecord(message.artifacts) || !isRecord(message.artifacts.emailDelivery)) continue;
      const executionId = stringValue(message.artifacts.emailDelivery.executionId), execution = state.executions[executionId];
      if (execution) message.artifacts.emailDelivery = { ...message.artifacts.emailDelivery, status: execution.status,
        bridgeDispatched: Object.values(execution.operationSecret?.intents ?? {}).some(intent => ["DISPATCH_INTENT", "ACKNOWLEDGED", "UNKNOWN"].includes(intent.state)),
        deliveryVerified: false };
    }
    return copy;
  });
  if (chat === null) throw new HandlerFailure(404, "Chat session not found");

  const latestEmailDraftMessages = new Map<string, unknown>();
  for (const message of chat.messages) if (isRecord(message.artifacts) && isRecord(message.artifacts.emailDraft)) latestEmailDraftMessages.set(stringValue(message.artifacts.emailDraft.id), message.id);
  const allMessages = trimRedundantRetrieval(chat.messages as Array<Record<string, unknown>>).map((message) => {
    if (!isRecord(message.artifacts) || !isRecord(message.artifacts.emailDraft)) return message;
    return { ...message, artifacts: { ...message.artifacts, emailDraftSuperseded: latestEmailDraftMessages.get(stringValue(message.artifacts.emailDraft.id)) !== message.id } };
  });
  const query = queryRecord(request);
  const limit = Math.max(1, Math.min(200, Math.trunc(numberValue(query.limit, 30))));
  const beforeId = typeof query.before === "string" ? query.before : "";

  let endIndex = allMessages.length;
  if (beforeId !== "") {
    const idx = allMessages.findIndex((m) => m.id === beforeId);
    if (idx !== -1) endIndex = idx;
  }
  const startIndex = Math.max(0, endIndex - limit);
  const pageMessages = allMessages.slice(startIndex, endIndex);

  const trimmed = {
    ...chat,
    messages: pageMessages,
    hasMoreMessages: startIndex > 0,
    totalMessageCount: allMessages.length,
  };
  return reply.send(ok(trimmed, "OK", null));
}
/*******************************************************************************
 * Function: updateChat
 *
 * Updates a visible chat session from the request body.
 ******************************************************************************/
export async function updateChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const provider = Object.hasOwn(body, "selectedModel") ? selectProvider(services, requestedModel(body.selectedModel)) : undefined;
  const chat = await services.repository.mutate((state) => {
    const value = assertChatAuthority(state, user, requestParam(request, "id"));
    if (Object.hasOwn(body, "title")) value.title = stringValue(body.title);
    if (provider?.binding) value.selectedModel = provider.binding.model;
    value.updatedAt = now(); return structuredClone(value);
  });
  return reply.send(ok(chatSummary(chat), "Chat session updated", null));
}
/*******************************************************************************
 * Function: deleteChat
 *
 * Deletes a chat session after checking the user's authority.
 ******************************************************************************/
export async function deleteChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { await services.repository.mutate((state) => { const value = state.chats[requestParam(request, "id")]; if (value === undefined || (!user.permissions.includes("workflow:write") && value.ownerId !== user.id)) throw new HandlerFailure(404, "Chat session not found");
  if (Object.values(state.chatOperations).some(op => op.sessionId === value.id && activeChatStatus(op.status))) throw new HandlerFailure(409, "Cancel or wait for the active chat operation before deleting this conversation", { code: "CHAT_OPERATION_ACTIVE" });
  if (Object.values(state.emailDeliveryAdmissions).some(admission => admission.sessionId === value.id)) throw new HandlerFailure(409, "A conversation linked to an immutable email approval execution cannot be deleted", { code: "EMAIL_DELIVERY_CHAT_IMMUTABLE" });
  delete state.chats[value.id]; }); return reply.send(ok({ deleted: true }, "Chat session deleted", null)); }
