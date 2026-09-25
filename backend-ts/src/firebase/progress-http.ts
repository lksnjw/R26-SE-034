import Fastify from "fastify";
import cors from "@fastify/cors";
import type { AppConfig } from "../config/config.js";
import { effectiveUserFromState, type RepositoryState } from "../repository/store.js";
import { openFirestoreProgressReader, type ProgressSnapshotReader } from "../storage/firestore-progress-reader.js";
import { authenticate } from "../http/handlers/authentication.js";
import { getChat } from "../http/handlers/chat-sessions.js";
import { getWorkflow } from "../http/handlers/workflow-runtime.js";
import { getWorkflowYAML } from "../http/handlers/workflows.js";
import { projectChatProgress, projectSessionOperations } from "../agent/chat-progress.js";
import { executionLogs, executionTimeline } from "../http/handlers/uploads-executions.js";
import { projectExecutionProgress } from "../http/handlers/execution-queries.js";
import { projectExecutionEventPage, progressInteger } from "../http/handlers/execution-events.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { routePolicy } from "../http/route-policy.js";
import { initializeRequestTrace, requestTraceId } from "../trace/request-trace.js";
import { fail, ok } from "../models/schemas.js";
import type { FunctionHttpRequest, FunctionHttpResponse } from "./http.js";
import { setTimeout as pause } from "node:timers/promises";
import { configuredModelCatalog } from "../providers/catalog.js";

const paths = ["/api/executions/:id", "/api/executions/:id/events", "/api/executions/:id/logs", "/api/executions/:id/timeline",
  "/api/chat/operations/:id", "/api/chat/sessions/:id/operations", "/api/chat/sessions/:id",
  "/api/workflows/:id", "/api/workflows/:id/yaml", "/api/chat/models"] as const;
const patterns = paths.map(path => new RegExp(`^${path.replace(":id", "[^/?#]+")}/?$`));
const active = new Set(["PENDING", "RUNNING", "AWAITING_APPROVAL"]);
const ACTIVE_CHAT_STATUSES = new Set(["QUEUED", "RUNNING"]);

/** Fixed safe route inventory, never an alternate dispatcher for arbitrary GETs.
 * Exact approval/reconciliation views retain their service-backed authority path. */
export function isFunctionProgressRequest(config: AppConfig, request: FunctionHttpRequest): boolean {
  if (config.storageDriver !== "firestore-records" || config.apiBasePath !== "/api" || !["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  const [path, search] = request.url.split("?", 2);
  // Reserved static routes are not workflow IDs or committed-source views.
  if (/^\/api\/workflows\/(templates|assignable-users)\/?$/.test(path!)) return false;
  if (!patterns.some(pattern => pattern.test(path!))) return false;
  if (patterns[0]!.test(path!)) {
    const views = new URLSearchParams(search).getAll("view");
    if (views.length === 1 && ["approval", "reconciliation"].includes(views[0]!)) return false;
  }
  return true;
}

/** Builds only authentication/projection handlers: no application services,
 * registry startup, writable Repository, worker/outbox or MCP/provider client.
 * Full encrypted committed images are read for now; scoped read optimization
 * requires an equally coherent auth + target-record proof before replacing it. */
export async function handleFunctionProgress(config: AppConfig, request: FunctionHttpRequest,
  open: () => ProgressSnapshotReader = () => openFirestoreProgressReader(config)): Promise<FunctionHttpResponse> {
  if (!isFunctionProgressRequest(config, request)) throw new Error("Not a read-only progress request");
  const app = Fastify({ logger: false, bodyLimit: 1024, exposeHeadRoutes: true });
  let reader: ProgressSnapshotReader | undefined;
  const deadline = Date.now() + 60_000;
  try {
    await app.register(cors, { origin: config.corsOrigins, credentials: true,
      allowedHeaders: ["Origin", "Content-Type", "Accept", "Authorization"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] });
    app.addHook("onRequest", async req => { initializeRequestTrace(req); });
    app.addHook("onSend", async (req, reply, payload) => {
      reply.header("cache-control", "no-store"); reply.header("x-trace-id", requestTraceId(req)); return payload;
    });
    app.setErrorHandler((error, req, reply) => {
      if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
      const status = error instanceof Error ? (error as Error & { statusCode?: number }).statusCode : undefined;
      if (status && status >= 400 && status < 500) return reply.status(status).send(fail("Invalid progress request", null));
      if (req.routeOptions.url === "/api/chat/models") return reply.status(503).send(fail(
        "Configured chat models are unavailable. No provider was activated and no work was submitted.", { code: "FUNCTIONS_MODEL_CATALOG_UNAVAILABLE" }));
      return reply.status(503).send(fail("Committed progress is unavailable. Reconnect to the original run; no work was resubmitted.", { code: "FUNCTIONS_PROGRESS_UNAVAILABLE" }));
    });
    for (const path of paths) app.get(path, async (req, reply) => {
      if (request.rawBody?.length || req.headers["transfer-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0")
        throw new HandlerFailure(400, "Progress queries do not accept a body");
      const id = (req.params as { id: string }).id, query = req.query as Record<string, unknown>;
      const allowed = path.endsWith("/events") ? ["after", "limit", "waitMs"] : path === "/api/chat/operations/:id" ? ["after", "waitMs"] : path === "/api/chat/sessions/:id" ? ["limit", "before"] : [];
      if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== "string")) throw new HandlerFailure(400, "Unsupported progress query");
      let state: RepositoryState | undefined;
      // The shared JWT verifier calls this only after a valid signed subject.
      // Permission resolution and target projection then use this same image.
      const loadUser = async () => authenticate(req, reply, { config, repository: { effectiveUser: async subject => {
        if (request.signal?.aborted || Date.now() >= deadline) throw new Error("Progress request ended");
        reader ??= open();
        state = await reader.snapshot({ timeoutMs: Math.min(30_000, deadline - Date.now()), ...(request.signal ? { signal: request.signal } : {}) });
        return effectiveUserFromState(state, subject);
      } } });
      const authorize = (user: CurrentUser) => {
        const policy = routePolicy({ method: "GET", path });
        if (policy && !policy.required.some(permission => user.permissions.includes(permission))) throw new HandlerFailure(403, "Permission denied", policy.any ? { requiredAny: policy.required } : { required: policy.required[0] });
      };
      const auth = await loadUser(); if (!auth) return reply;
      authorize(auth.user);
      if (path === "/api/chat/models") return reply.send(ok(configuredModelCatalog(state!, config),
        "Configured chat models loaded; runtime activation and remote compatibility are not certified",
        { source: "committed-configuration", runtimeActivationConfirmed: false }));
      const view = { repository: { read: async <T>(project: (value: Readonly<RepositoryState>) => T): Promise<T> => project(state!) } };
      if (path === "/api/workflows/:id") return getWorkflow(req, reply, auth.user, view);
      if (path === "/api/workflows/:id/yaml") return getWorkflowYAML(req, reply, auth.user, view);
      if (path === "/api/chat/sessions/:id") return getChat(req, reply, auth.user, view);
      const withCancellation = async (operation: ReturnType<typeof projectChatProgress>["operation"]) => {
        const stored = state!.chatOperations[operation.id];
        if (["QUEUED", "RUNNING"].includes(operation.status) && !operation.cancellationRequested && stored?.taskDispatchSecret &&
            await reader?.cancellationRequested?.(stored, request.signal)) return { ...operation, cancellationRequested: true };
        return operation;
      };
      if (path === "/api/chat/sessions/:id/operations") {
        const values = projectSessionOperations(state!, auth.user, id);
        return reply.send(ok(await Promise.all(values.map(withCancellation)), "Saved chat operations loaded", null));
      }
      if (path === "/api/chat/operations/:id") {
        const after = query.after ?? "0", waitMs = query.waitMs === undefined ? 0 : progressInteger(query.waitMs, 0, 25_000);
        const started = Date.now(); let progress = projectChatProgress(state!, auth.user, id, after), waited = false;
        const initial = `${progress.operation.lastSequence}:${progress.operation.status}:${progress.operation.stage}`;
        while (waitMs > 0 && !progress.events.length && !progress.hasMore && ACTIVE_CHAT_STATUSES.has(progress.operation.status) &&
          Date.now() - started < waitMs && `${progress.operation.lastSequence}:${progress.operation.status}:${progress.operation.stage}` === initial) {
          waited = true;
          await pause(Math.min(1000, waitMs - (Date.now() - started)), undefined, request.signal ? { signal: request.signal } : {});
          const fresh = await loadUser(); if (!fresh) return reply; authorize(fresh.user);
          progress = projectChatProgress(state!, fresh.user, id, after);
        }
        return reply.send(ok({ ...progress, operation: await withCancellation(progress.operation), waited, waitedMs: waited ? Date.now() - started : 0 },
          waited ? "Chat progress long poll" : "Chat operation progress loaded", null));
      }
      if (path.endsWith("/logs")) return executionLogs(req, reply, auth.user, view);
      if (path.endsWith("/timeline")) return executionTimeline(req, reply, auth.user, view);
      if (path === "/api/executions/:id") return reply.send(ok(projectExecutionProgress(state!, auth.user, id), "OK", null));
      const after = query.after === undefined ? 0 : progressInteger(query.after, 0, Number.MAX_SAFE_INTEGER);
      const limit = query.limit === undefined ? 100 : progressInteger(query.limit, 1, 100);
      const waitMs = query.waitMs === undefined ? 0 : progressInteger(query.waitMs, 0, 25_000);
      const started = Date.now();
      let page = projectExecutionEventPage(state!, auth.user, id, after, limit), waited = false;
      const initial = `${page.lastSequence}:${page.status}:${page.profile}`;
      while (waitMs > 0 && !page.events.length && !page.hasMore && active.has(page.status) && Date.now() - started < waitMs && `${page.lastSequence}:${page.status}:${page.profile}` === initial) {
        waited = true;
        await pause(Math.min(1000, waitMs - (Date.now() - started)), undefined, request.signal ? { signal: request.signal } : {});
        const fresh = await loadUser(); if (!fresh) return reply;
        authorize(fresh.user);
        page = projectExecutionEventPage(state!, fresh.user, id, after, limit);
      }
      return reply.send(ok({ ...page, waited, waitedMs: waited ? Date.now() - started : 0 }, waited ? "Execution event long poll" : "Execution event replay", null));
    });
    const result = await app.inject({ method: request.method as "GET" | "HEAD" | "OPTIONS", url: request.url, headers: request.headers,
      ...(request.ip ? { remoteAddress: request.ip } : {}) });
    return { statusCode: result.statusCode, headers: result.headers, body: result.rawPayload };
  } finally {
    try { await app.close(); } finally { await reader?.close(); }
  }
}
