import Fastify from "fastify";
import cors from "@fastify/cors";
import type { AppConfig } from "../config/config.js";
import { effectiveUserFromState } from "../repository/store.js";
import { authenticate } from "../http/handlers/authentication.js";
import { HandlerFailure, isRecord } from "../http/handlers/common.js";
import { routePolicy } from "../http/route-policy.js";
import { INVALID_JSON_BODY } from "../http/request-body.js";
import { initializeRequestTrace, requestTraceId } from "../trace/request-trace.js";
import { fail, ok } from "../models/schemas.js";
import { openFirestoreChatCancellation, type ChatCancellationControl } from "../storage/firestore-chat-cancellation.js";
import { FirestoreSnapshotChanged } from "../storage/firestore-record-store.js";
import type { FunctionHttpRequest, FunctionHttpResponse } from "./http.js";

const path = "/api/chat/operations/:id/cancel";
export function isFunctionChatCancellationRequest(config: AppConfig, request: FunctionHttpRequest) {
  return config.storageDriver === "firestore-records" && config.apiBasePath === "/api" && ["POST", "OPTIONS"].includes(request.method) &&
    /^\/api\/chat\/operations\/[^/?#]+\/cancel$/.test(request.url.split("?", 1)[0]!);
}
/** Authenticated stop intent only; no full runtime, writer or dispatch. */
export async function handleFunctionChatCancellation(config: AppConfig, request: FunctionHttpRequest,
  open: () => ChatCancellationControl = () => openFirestoreChatCancellation(config), entered: () => void = () => {}): Promise<FunctionHttpResponse> {
  const app = Fastify({ logger: false, bodyLimit: 1024 }); let control: ChatCancellationControl | undefined;
  try {
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      try { done(null, JSON.parse(String(body))); } catch { done(null, INVALID_JSON_BODY); }
    });
    await app.register(cors, { origin: config.corsOrigins, credentials: true, allowedHeaders: ["Origin", "Content-Type", "Accept", "Authorization"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] });
    app.addHook("onRequest", async req => { initializeRequestTrace(req); });
    app.addHook("onSend", async (req, reply, payload) => { reply.header("cache-control", "no-store"); reply.header("x-trace-id", requestTraceId(req)); return payload; });
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.status(status).send(fail("Invalid cancellation request", null));
      return reply.status(503).send(fail("Cancellation acknowledgement is unavailable. Inspect this original operation; do not submit replacement work.", { code: "CHAT_CANCELLATION_UNCONFIRMED" }));
    });
    app.post(path, async (req, reply) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let state;
        const auth = await authenticate(req, reply, { config, repository: { effectiveUser: async subject => {
          if (request.signal?.aborted) throw new Error("Cancellation request ended");
          control ??= open(); state = await control.snapshot(request.signal); return effectiveUserFromState(state, subject);
        } } });
        if (!auth) return reply;
        const policy = routePolicy({ method: "POST", path });
        if (!policy || !policy.required.some(permission => auth.user.permissions.includes(permission))) throw new HandlerFailure(403, "Permission denied", { requiredAny: policy?.required ?? [] });
        if (!isRecord(req.body) || Object.keys(req.body).length || Object.keys(req.query as object).length) throw new HandlerFailure(400, "Cancellation accepts an empty object and no query parameters");
        try {
          entered();
          const operation = await control!.request(state!, auth.user, (req.params as { id: string }).id, request.signal);
          const active = ["QUEUED", "RUNNING"].includes(operation.status);
          return reply.status(active ? 202 : 200).send(ok(operation, active ? "Cancellation requested; remote rollback is not implied" : "Operation is already terminal; no new cancellation was recorded", null));
        } catch (error) { if (!(error instanceof FirestoreSnapshotChanged) || attempt === 2) throw error; }
      }
      throw new Error("Chat cancellation coherence budget exhausted");
    });
    const result = await app.inject({ method: request.method as "POST" | "OPTIONS", url: request.url, headers: request.headers,
      ...(request.rawBody?.length ? { payload: request.rawBody } : {}), ...(request.ip ? { remoteAddress: request.ip } : {}) });
    return { statusCode: result.statusCode, headers: result.headers, body: result.rawPayload };
  } finally { try { await app.close(); } finally { await control?.close(); } }
}
