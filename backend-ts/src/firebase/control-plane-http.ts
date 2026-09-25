import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { AppConfig } from "../config/config.js";
import type { Repository } from "../repository/store.js";
import { authenticate, login, logout, publicAuthenticatedUser, refresh, register } from "../http/handlers/authentication.js";
import { handleProviderRoute } from "../http/handlers/providers.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { INVALID_JSON_BODY } from "../http/request-body.js";
import { routePolicy } from "../http/route-policy.js";
import { initializeRequestTrace, requestTraceId } from "../trace/request-trace.js";
import { fail, ok } from "../models/schemas.js";
import { withFunctionResources, type FunctionComposition } from "./invocation.js";
import type { FunctionHttpRequest, FunctionHttpResponse } from "./http.js";

const routes = [
  { method: "POST", path: "/api/auth/login" }, { method: "POST", path: "/api/auth/refresh" },
  { method: "POST", path: "/api/auth/register" }, { method: "POST", path: "/api/auth/logout" },
  { method: "GET", path: "/api/auth/me" }, { method: "GET", path: "/api/providers" },
  { method: "POST", path: "/api/providers" }, { method: "PUT", path: "/api/providers/:id" },
  { method: "POST", path: "/api/providers/:id/activate" }, { method: "POST", path: "/api/providers/:id/test" },
] as const;

/** Closed method/path allowlist; encoded/nested paths and other hosts retain
 * the execution host. HEAD exists only for GET routes. */
export function isFunctionControlPlaneRequest(config: AppConfig, request: FunctionHttpRequest): boolean {
  if (config.storageDriver !== "firestore-records" || config.apiBasePath !== "/api") return false;
  const path = request.url.split("?", 1)[0];
  return routes.some(route => (request.method === route.method || request.method === "OPTIONS" ||
    request.method === "HEAD" && route.method === "GET") &&
    new RegExp(`^${route.path.replace(":id", "[^/\\\\%?#]+")}$`).test(path ?? ""));
}

/** Configuration/identity only. Existing packaged registries, acknowledged
 * fresh storage ownership, mandatory auth and awaited cleanup remain intact. */
export async function handleFunctionControlPlane(input: FunctionComposition, request: FunctionHttpRequest,
  entered: () => void): Promise<FunctionHttpResponse> {
  if (!isFunctionControlPlaneRequest(input.config, request)) throw new Error("Not a control-plane request");
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
      for (const route of routes) app.route({ method: route.method, url: route.path, handler: async (req, reply) => {
        if (!repository) throw new Error("Control-plane storage is required");
        const services = { config: input.config, repository, providerActivationScope: "stored-configuration" as const };
        if (route.path === "/api/auth/login") return login(req, reply, services);
        if (route.path === "/api/auth/refresh") return refresh(req, reply, services);
        if (route.path === "/api/auth/register") return register(req, reply, services);
        const auth = await authenticate(req, reply, services); if (!auth) return reply;
        const policy = routePolicy(route);
        if (policy && !policy.required.some(permission => auth.user.permissions.includes(permission)))
          throw new HandlerFailure(403, "Permission denied", policy.any ? { requiredAny: policy.required } : { required: policy.required[0] });
        if (route.path === "/api/auth/logout") return logout(req, reply, services);
        if (route.path === "/api/auth/me") return reply.send(ok(publicAuthenticatedUser(auth.user), "OK", null));
        if (req.body === INVALID_JSON_BODY && ["/api/providers", "/api/providers/:id"].includes(route.path))
          throw new HandlerFailure(400, "Invalid request body");
        const signal = request.signal ? AbortSignal.any([req.signal, request.signal]) : req.signal;
        return handleProviderRoute(route, req, reply, auth.user, services, signal);
      } });
      const result = await app.inject({ method: request.method as "GET" | "HEAD" | "POST" | "PUT" | "OPTIONS", url: request.url, headers: request.headers,
        ...(request.rawBody?.length ? { payload: request.rawBody } : {}), ...(request.ip ? { remoteAddress: request.ip } : {}) });
      repository?.assertAuthority();
      return { statusCode: result.statusCode, headers: result.headers, body: result.rawPayload };
    } finally { await app.close(); }
  };
  if (request.method === "OPTIONS") return respond();
  return withFunctionResources(input, async resources => { entered(); return respond(resources.repository); });
}
