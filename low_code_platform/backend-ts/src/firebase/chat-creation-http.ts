import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { AppConfig } from "../config/config.js";
import type { Repository } from "../repository/store.js";
import { authenticate } from "../http/handlers/authentication.js";
import { createChat } from "../http/handlers/chat-sessions.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { INVALID_JSON_BODY } from "../http/request-body.js";
import { routePolicy } from "../http/route-policy.js";
import { initializeRequestTrace, requestTraceId } from "../trace/request-trace.js";
import { fail } from "../models/schemas.js";
import { withFunctionResources, type FunctionComposition } from "./invocation.js";
import type { FunctionHttpRequest, FunctionHttpResponse } from "./http.js";

const path = "/api/chat/sessions";

/** One persistence command only. Messages, edits, models and arbitrary writes
 * keep their existing governed runtime. Do not broaden this selector by prefix. */
export function isFunctionChatCreationRequest(config: AppConfig, request: FunctionHttpRequest): boolean {
  return config.storageDriver === "firestore-records" && config.apiBasePath === "/api" &&
    ["POST", "OPTIONS"].includes(request.method) && request.url.split("?", 1)[0] === path;
}

/** Preserve the shared identity, route policy and original creation transaction.
 * No application runtime, provider activation, MCP, governance, worker or model
 * is constructed. The resource opener still loads packaged registry assets. */
export async function handleFunctionChatCreation(input: FunctionComposition, request: FunctionHttpRequest,
  entered: () => void): Promise<FunctionHttpResponse> {
  if (!isFunctionChatCreationRequest(input.config, request)) throw new Error("Not a chat creation request");
  const respond = async (repository?: Repository): Promise<FunctionHttpResponse> => {
    const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
    try {
      app.removeContentTypeParser("application/json");
      app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        try { done(null, JSON.parse(typeof body === "string" ? body : body.toString("utf8"))); }
        catch { done(null, INVALID_JSON_BODY); }
      });
      await app.register(cors, { origin: input.config.corsOrigins, credentials: true,
        allowedHeaders: ["Origin", "Content-Type", "Accept", "Authorization"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] });
      await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
      app.addHook("onRequest", async req => { initializeRequestTrace(req); });
      app.addHook("onSend", async (req, reply, payload) => {
        reply.header("cache-control", "no-store"); reply.header("x-trace-id", requestTraceId(req)); return payload;
      });
      app.setErrorHandler((error, _req, reply) => {
        if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
        const normalized = (error instanceof Error ? error : new Error(String(error))) as Error & { statusCode?: number; code?: string };
        const status = normalized.statusCode && normalized.statusCode >= 400 && normalized.statusCode < 600 ? normalized.statusCode : 500;
        return reply.status(status).send(fail(status === 500 ? "Internal server error" :
          status === 400 && normalized.code === "FST_ERR_CTP_INVALID_JSON_BODY" ? "Invalid request body" : normalized.message, null));
      });
      app.post(path, async (req, reply) => {
        if (!repository) throw new Error("Writable chat resource is required");
        const services = { config: input.config, repository };
        const auth = await authenticate(req, reply, services); if (!auth) return reply;
        const policy = routePolicy({ method: "POST", path });
        if (!policy) throw new Error("Chat creation must have an explicit route policy");
        if (!policy.required.some(permission => auth.user.permissions.includes(permission)))
          throw new HandlerFailure(403, "Permission denied", policy.any ? { requiredAny: policy.required } : { required: policy.required[0] });
        if (req.body === INVALID_JSON_BODY) throw new HandlerFailure(400, "Invalid JSON request body");
        return createChat(req, reply, auth.user, services);
      });
      const result = await app.inject({ method: request.method as "POST" | "OPTIONS", url: request.url, headers: request.headers,
        ...(request.rawBody?.length ? { payload: request.rawBody } : {}), ...(request.ip ? { remoteAddress: request.ip } : {}) });
      if (result.statusCode >= 500) repository?.assertAuthority();
      return { statusCode: result.statusCode, headers: result.headers, body: result.rawPayload };
    } finally { await app.close(); }
  };
  // A preflight does not authenticate or mutate; CORS responds before the POST
  // handler. Actual writes always await their fresh owner and its full disposal.
  if (request.method === "OPTIONS") return respond();
  return withFunctionResources(input, async resources => { entered(); return respond(resources.repository); });
}
