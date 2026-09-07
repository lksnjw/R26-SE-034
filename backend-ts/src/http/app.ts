import { createHash, randomBytes } from "node:crypto";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HTTPMethods,
} from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { AppConfig } from "../config/config.js";
import { hashPassword, verifyPassword } from "../authn/password.js";
import {
  fail,
  loginRequestSchema,
  ok,
  registerRequestSchema,
  runWorkflowRequestSchema,
  type Workflow,
} from "../models/schemas.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { withoutSecretFields } from "../redact/secrets.js";
import type { RegistryService } from "../registry/service.js";
import type { Execution, Repository, User } from "../repository/store.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import type { SynthesisService } from "../synthesis/service.js";
import type { ValidationGate } from "../governance/gate.js";
import { ResourceMutations } from "./resource-mutations.js";
import { type Executor } from "../runner/executor.js";
import type { RegistryValidator } from "../validator/registry-validator.js";
import { routeTable, type RouteDefinition } from "./generated-routes.js";
import { isPolicyCheckerEnabled, checkErpPolicy } from "../governance/rbac.js";
import {
  canReadExecution,
  visibleExecutions,
} from "./execution-scope.js";
import { buildTraceChain } from "./trace-chain.js";
import {
  initializeRequestTrace,
  isTraceId,
  requestTraceId,
} from "../trace/request-trace.js";
import {
  ADMIN_UNHANDLED,
  handleAdministrationRoute,
} from "./handlers/administration.js";
import {
  ANALYTICS_UNHANDLED,
  handleAnalyticsCatalogRoute,
} from "./handlers/analytics-catalog.js";
import { inspectReadWorkflow } from "../runner/read-workflow.js";
import { runVerifiedRead } from "./handlers/read-execution.js";
import { boundedReadFixtureRequest, handleReadFixtureSimulation } from "./handlers/read-simulation.js";
import { readJobQueue, supportsReadJobs } from "../runner/read-jobs.js";
import { operationJobQueue, supportsOperationJobs } from "../runner/operation-jobs.js";
import { chatJobQueue, supportsChatJobs } from "../agent/chat-jobs.js";
import { handleExecutionControlRoute, EXECUTION_CONTROL_UNHANDLED } from "./handlers/execution-control.js";
import { runtimeApprovalView } from "../runner/runtime-approvals.js";
import { operationReconciliationView, hasOperationReconciliation } from "../runner/operation-reconciliation.js";
import {
  REGISTRY_UNHANDLED,
  handleRegistryRoute,
} from "./handlers/registry.js";
import {
  RESOURCE_UNHANDLED,
  handleResourceRoute,
} from "./handlers/resources.js";
import {
  UPLOAD_EXECUTION_UNHANDLED,
  handleUploadExecutionRoute,
} from "./handlers/uploads-executions.js";
import {
  WORKFLOW_UNHANDLED,
  handleWorkflowRoute,
} from "./handlers/workflows.js";
import {
  HandlerFailure,
  appendAudit,
  stringValue,
  validateWorkflow as validateWithGovernance,
} from "./handlers/common.js";

export type ApplicationServices = {
  config: AppConfig;
  repository: Repository;
  registries: RegistryService;
  validator: RegistryValidator;
  validationGate?: ValidationGate;
  executor: Executor;
  providerRuntime?: ProviderRuntime;
  synthesis?: SynthesisService;
  erpbridgeSession?: ErpbridgeMcpSession | undefined;
  mcpConnectionRuntime?: import("../tools/mcp-connection-runtime.js").McpConnectionRuntime;
  contextAvailable?: boolean;
};

const publicRoutes = new Set([
  "GET /healthz",
  "GET /api/health",
  "POST /api/auth/login",
  "POST /api/auth/register",
  "POST /api/auth/refresh",
  "POST /api/auth/forgot-password",
  "POST /api/auth/reset-password",
  "POST /api/auth/verify-email",
  "GET /api/auth/oauth/:provider/authorize",
  "GET /api/auth/oauth/:provider/callback",
]);

const malformedJSONMessages = new Map<string, string>([
  ...[
    "POST /api/canvas/validate-workflow",
    "POST /api/chat/sessions",
    "PATCH /api/chat/sessions/:id",
    "POST /api/chat/sessions/:id/messages",
    "POST /api/integrations",
    "PATCH /api/integrations/:id",
    "PATCH /api/profile",
    "POST /api/profile/api-keys",
    "POST /api/roles",
    "PATCH /api/roles/:id",
    "PUT /api/roles/:id",
    "PATCH /api/settings",
    "PATCH /api/settings/general",
    "PATCH /api/settings/llm",
    "PATCH /api/settings/rbac",
    "POST /api/settings/webhooks",
    "PATCH /api/settings/webhooks/:id",
    "POST /api/synthesis",
    "POST /api/synthesis/explain",
    "POST /api/synthesis/preview-flow",
    "POST /api/synthesis/validate",
    "POST /api/upload/workflow-import",
    "POST /api/users",
    "PATCH /api/users/:id",
    "PUT /api/users/:id/role",
    "PUT /api/users/:id/status",
    "POST /api/workflows/:id/assign",
    "POST /api/workflows/:id/duplicate",
    "POST /api/workflows/:id/publish",
    "POST /api/workflows/templates",
    "POST /api/workflows/templates/:id/use",
  ].map((key) => [key, "Invalid JSON request body"] as const),
  ...[
    "PUT /api/company",
    "POST /api/company/approval-tiers",
    "PUT /api/company/approval-tiers/:id",
    "POST /api/company/cost-centres",
    "PUT /api/company/cost-centres/:id",
    "POST /api/company/departments",
    "PUT /api/company/departments/:id",
    "POST /api/import/commit",
    "PATCH /api/profile/notifications",
    "POST /api/providers",
    "PUT /api/providers/:id",
    "POST /api/workflows",
    "PATCH /api/workflows/:id",
    "PUT /api/workflows/:id/canvas",
    "POST /api/workflows/:id/run",
    "PUT /api/workflows/:id/yaml",
  ].map((key) => [key, "Invalid request body"] as const),
]);

/*******************************************************************************
 * Function: buildApp
 *
 * Configures the Fastify application, middleware, routes, and websocket
 * handlers.
 ******************************************************************************/
export async function buildApp(
  services: ApplicationServices,
): Promise<FastifyInstance> {
  assertApplicationServices(services);
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 10 * 1024 * 1024,
  });
  const resourceMutations = new ResourceMutations();
  if (supportsChatJobs(services)) {
    const queue = chatJobQueue(services);
    app.addHook("onReady", () => queue.start());
    app.addHook("onClose", () => queue.stop());
  }
  if (supportsReadJobs(services)) {
    const queue = readJobQueue(services);
    app.addHook("onReady", () => queue.start());
    app.addHook("onClose", () => queue.stop());
  }
  if (supportsOperationJobs(services)) {
    const queue = operationJobQueue(services);
    app.addHook("onReady", () => queue.start());
    app.addHook("onClose", () => queue.stop());
  }
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(
          null,
          JSON.parse(typeof body === "string" ? body : body.toString("utf8")),
        );
      } catch {
        done(null, INVALID_JSON_BODY);
      }
    },
  );
  await app.register(cors, {
    origin: services.config.corsOrigins,
    credentials: true,
    allowedHeaders: ["Origin", "Content-Type", "Accept", "Authorization"],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HandlerFailure) {
      void reply.status(error.status).send(fail(error.message, error.meta));
      return;
    }
    const normalized = (
      error instanceof Error ? error : new Error(String(error))
    ) as Error & { statusCode?: number; code?: string };
    const status =
      normalized.statusCode !== undefined &&
      normalized.statusCode >= 400 &&
      normalized.statusCode < 600
        ? normalized.statusCode
        : 500;
    if (status === 500) {
      request.log.error(
        { err: normalized, traceId: requestTraceId(request) },
        "Unhandled request error",
      );
    }
    const message =
      status === 400 && normalized.code === "FST_ERR_CTP_INVALID_JSON_BODY"
        ? "Invalid request body"
        : status === 500
          ? "Internal server error"
          : normalized.message;
    void reply.status(status).send(fail(message, null));
  });
  app.addHook("onRequest", async (request) => {
    initializeRequestTrace(request);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-trace-id", requestTraceId(request));
    return payload;
  });

  for (const route of routeTable) {
    if (route.path === "/ws/*") {
      app.get(
        route.path,
        {
          websocket: true,
          /*******************************************************************************
           * Function: preValidation
           *
           * Authenticates a websocket request before the connection is accepted.
           ******************************************************************************/
          preValidation: async (request, reply) => {
            const auth = await authenticate(request, reply, services);
            if (auth === null) return reply;
          },
        },
        (socket, request) => {
          const wildcard = (request.params as Record<string, unknown>)["*"];
          const channel =
            typeof wildcard === "string" && wildcard.trim() !== ""
              ? wildcard
              : "system-health";
          const interval = setInterval(() => {
            void sendWebsocketSnapshot(socket, channel, services);
          }, 5_000);
          socket.once("close", () => clearInterval(interval));
          socket.once("error", () => clearInterval(interval));
        },
      );
      continue;
    }
    app.route({
      method: route.method as HTTPMethods,
      url: route.path,
      /*******************************************************************************
       * Function: handler
       *
       * Dispatches the registered HTTP route to its application handler.
       ******************************************************************************/
      handler: async (request, reply) => {
        if (route.method === "GET" || route.path.includes("/settings/mcp-connections") || /\/(commands|node-proposals|run|retry)$/.test(route.path))
          return handleRoute(route, request, reply, services);
        const params = request.params as Record<string, unknown>;
        const family = route.path.split("/")[2] ?? route.path;
        const key = `${family}:${String(params?.id ?? params?.userId ?? "collection")}`;
        return resourceMutations.run(key, () => handleRoute(route, request, reply, services));
      },
    });
  }
  if (routeTable.length !== 190)
    throw new Error(
      `route table has ${routeTable.length} routes, expected 190`,
    );
  return app;
}

/*******************************************************************************
 * Function: assertApplicationServices
 *
 * Checks that the application has the services required to start.
 ******************************************************************************/
function assertApplicationServices(services: ApplicationServices): void {
  if (
    services === null ||
    services === undefined ||
    typeof services !== "object"
  )
    throw new Error("application services are required");
  if (services.config === null || services.config === undefined)
    throw new Error("application config is required");
  if (
    services.repository === null ||
    services.repository === undefined ||
    typeof services.repository.snapshot !== "function" ||
    typeof services.repository.mutate !== "function"
  )
    throw new Error("application repository is invalid");
  if (
    services.registries === null ||
    services.registries === undefined ||
    typeof services.registries.snapshot !== "function"
  )
    throw new Error("application registry service is invalid");
  if (
    services.validator === null ||
    services.validator === undefined ||
    typeof services.validator.validateAndIssueToken !== "function"
  )
    throw new Error("application validator is invalid");
  if (
    services.executor === null ||
    services.executor === undefined ||
    typeof services.executor.run !== "function"
  )
    throw new Error("application executor is invalid");
}

const INVALID_JSON_BODY = Object.freeze({ invalidJSONBody: true });

/*******************************************************************************
 * Function: sendWebsocketSnapshot
 *
 * Sends the current workflow and execution snapshot to an open websocket.
 ******************************************************************************/
async function sendWebsocketSnapshot(
  socket: { readyState: number; send(data: string): void },
  channel: string,
  services: ApplicationServices,
): Promise<void> {
  if (socket.readyState !== 1) return;
  const state = await services.repository.snapshot();
  const workflows = Object.values(state.workflows).filter(
    (item) => !item.archived,
  ).length;
  const executions = Object.values(state.executions);
  const runningExecutions = executions.filter(
    (item) => item.status === "RUNNING",
  ).length;
  socket.send(
    JSON.stringify({
      type: "system.health.snapshot",
      id: `event_${randomBytes(8).toString("hex")}`,
      timestamp: new Date().toISOString(),
      data: {
        channel,
        overall: "healthy",
        workflows,
        executions: executions.length,
        runningExecutions,
        mcpConfigured:
          services.config.mcpMode === "mock" ||
          services.config.mcpBaseURL !== "",
      },
    }),
  );
}

/*******************************************************************************
 * Function: handleRoute
 *
 * Dispatches an HTTP request to the matching backend handler.
 ******************************************************************************/
async function handleRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  const routeKey = `${route.method} ${route.path}`;
  if (
    route.path === "/healthz" ||
    route.path === `${services.config.apiBasePath}/health`
  )
    return health(reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/login`)
    return login(request, reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/register`)
    return register(request, reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/refresh`)
    return refresh(request, reply, services);
  if (route.path.includes("/auth/oauth/"))
    return reply
      .status(501)
      .send(fail("OAuth is not configured for this installation", null));
  if (
    route.path.endsWith("/forgot-password") ||
    route.path.endsWith("/reset-password")
  )
    return reply
      .status(501)
      .send(
        fail("Password recovery is not configured for this installation", null),
      );
  if (route.path.endsWith("/verify-email"))
    return reply
      .status(501)
      .send(
        fail(
          "Email verification is not configured for this installation",
          null,
        ),
      );

  const auth = publicRoutes.has(routeKey)
    ? null
    : await authenticate(request, reply, services);
  if (!publicRoutes.has(routeKey) && auth === null) return;
  const current = auth?.user ?? null;
  if (current !== null) {
    // Authentication/authorization is mandatory, independent of optional
    // advisory policy checks. Disabling the UI toggle cannot grant access.
    const policy = routePolicy(route);
    if (policy !== null && !policy.required.some((permission) => current.permissions.includes(permission))) {
      const meta = policy.any ? { requiredAny: policy.required } : { required: policy.required[0] };
      return reply.status(403).send(fail("Permission denied", meta));
    }
  }

  if (route.path === `${services.config.apiBasePath}/auth/logout`)
    return logout(request, reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/me`)
    return reply.send(ok(publicUser(current!), "OK", null));
  if (route.path.includes("/auth/2fa/"))
    return reply
      .status(501)
      .send(
        fail(
          "Two-factor authentication is not configured for this installation",
          null,
        ),
      );
  if (
    route.path === `${services.config.apiBasePath}/workflows` &&
    route.method === "GET"
  )
    return listWorkflows(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/workflows` &&
    route.method === "POST"
  )
    return createWorkflow(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/workflows/:id` &&
    route.method === "GET"
  )
    return getWorkflow(request, reply, current!, services);
  if (route.path === `${services.config.apiBasePath}/workflows/:id/validate`)
    return validateWorkflow(request, reply, current!, services);
  if (route.path === `${services.config.apiBasePath}/workflows/:id/run`)
    return runWorkflow(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/registry/tools` &&
    route.method === "GET"
  )
    return reply.send(
      ok(services.registries.snapshot().tools, "Tool registry loaded", {
        count: services.registries.snapshot().tools.length,
        registryHash: services.registries.hash(),
      }),
    );
  if (
    route.path === `${services.config.apiBasePath}/registry/rules` &&
    route.method === "GET"
  )
    return reply.send(
      ok(services.registries.snapshot().rules, "Rule registry loaded", {
        count: services.registries.snapshot().rules.length,
        registryHash: services.registries.hash(),
      }),
    );
  if (
    route.path === `${services.config.apiBasePath}/executions` &&
    route.method === "GET"
  )
    return listExecutions(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/executions/:id` &&
    route.method === "GET"
  )
    return getExecution(request, reply, current!, services);
  const executionControl = await handleExecutionControlRoute(route, request, reply, current!, services);
  if (executionControl !== EXECUTION_CONTROL_UNHANDLED) return executionControl;
  if (
    route.path === `${services.config.apiBasePath}/notifications/read-all` &&
    route.method === "PATCH"
  )
    return markAllNotificationsRead(reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/notifications/:id/read` &&
    route.method === "PATCH"
  )
    return markNotificationRead(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/notifications/:id` &&
    route.method === "DELETE"
  )
    return deleteNotification(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/notifications` &&
    route.method === "GET"
  )
    return listNotifications(reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/profile` &&
    route.method === "GET"
  )
    return reply.send(ok(publicUser(current!), "OK", null));
  if (route.path === `${services.config.apiBasePath}/users/invite`)
    return reply
      .status(501)
      .send(
        fail("Email invitations is not configured for this installation", null),
      );
  if (route.path === `${services.config.apiBasePath}/profile/security`)
    return reply
      .status(501)
      .send(
        fail(
          "Security preference changes is not configured for this installation",
          null,
        ),
      );
  if (routeKey === "POST /api/import/analyse" && !request.isMultipart())
    return reply
      .status(400)
      .send(fail("Choose a registry file to analyse", null));
  if (request.body === INVALID_JSON_BODY) {
    const message = malformedJSONMessages.get(routeKey);
    if (message !== undefined)
      return reply.status(400).send(fail(message, null));
  }

  const workflowResult = await handleWorkflowRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (workflowResult !== WORKFLOW_UNHANDLED) return workflowResult;
  const adminResult = await handleAdministrationRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (adminResult !== ADMIN_UNHANDLED) return adminResult;
  const resourceResult = await handleResourceRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (resourceResult !== RESOURCE_UNHANDLED) return resourceResult;
  const analyticsResult = await handleAnalyticsCatalogRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (analyticsResult !== ANALYTICS_UNHANDLED) return analyticsResult;
  const registryResult = await handleRegistryRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (registryResult !== REGISTRY_UNHANDLED) return registryResult;
  const uploadExecutionResult = await handleUploadExecutionRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (uploadExecutionResult !== UPLOAD_EXECUTION_UNHANDLED)
    return uploadExecutionResult;

  return genericRoute(route, request, reply, current, services);
}

/*******************************************************************************
 * Function: health
 *
 * Returns application and persistence health information.
 ******************************************************************************/
async function health(
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  const storage = await services.repository.persistenceStatus();
  const data = {
    service: services.config.appName,
    environment: services.config.environment,
    status: storage.healthy ? "healthy" : "degraded",
    storage: {
      driver: services.config.storageDriver,
      durable: storage.durable,
      status: storage.healthy ? "healthy" : "unhealthy",
    },
    mcpMode: services.config.mcpMode,
    mcpBackend:
      services.config.mcpBaseURL === "" ? "unconfigured" : "configured",
    time: new Date().toISOString(),
  };
  return storage.healthy
    ? reply.send(ok(data, "OK", null))
    : reply.status(503).send({
        success: false,
        data,
        message: "Storage persistence is degraded",
        meta: null,
      });
}

/*******************************************************************************
 * Function: login
 *
 * Verifies login credentials and issues an authenticated session.
 ******************************************************************************/
async function login(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const parsed = loginRequestSchema.safeParse(request.body);
  if (!parsed.success)
    return reply
      .status(400)
      .send(fail("Email and password are required", null));
  const email = parsed.data.email.trim().toLowerCase();
  const state = await services.repository.snapshot();
  const user = Object.values(state.users).find(
    (item) => item.email.toLowerCase() === email,
  );
  const hash =
    user === undefined
      ? "$2b$10$C6UzMDM.H6dfI/f/IKcEe.3n4Qj06DNMo2n7ixfV7t9lU8vNzeW.u"
      : (state.passwordHashes[user.id] ?? "");
  const valid = await verifyPassword(hash, parsed.data.password);
  if (user === undefined || !valid)
    return reply.status(401).send(fail("Invalid email or password", null));
  if (user.status.toLowerCase() !== "active")
    return reply.status(403).send(fail("User account is not active", null));
  const session = await issueSession(user, parsed.data.rememberMe, services);
  await services.repository.mutate((draft) => {
    const current = draft.users[user.id];
    if (current !== undefined) current.lastLoginAt = new Date().toISOString();
  });
  return reply.send(ok(session, "Login successful", null));
}

/*******************************************************************************
 * Function: register
 *
 * Creates a user account from a validated registration request.
 ******************************************************************************/
async function register(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const parsed = registerRequestSchema.safeParse(request.body);
  if (
    !parsed.success ||
    parsed.data.name.trim() === "" ||
    parsed.data.email.trim() === "" ||
    parsed.data.password.length < 8
  )
    return reply
      .status(400)
      .send(
        fail(
          "Name, a valid email, and a password of at least 8 characters are required",
          null,
        ),
      );
  if (!services.config.allowPublicRegistration)
    return reply
      .status(403)
      .send(fail("Public registration is disabled", null));
  const passwordHash = await hashPassword(parsed.data.password);
  const user = await services.repository
    .mutate((state) => {
      if (
        Object.values(state.users).some(
          (item) =>
            item.email.toLowerCase() === parsed.data.email.trim().toLowerCase(),
        )
      )
        throw new HTTPFailure(409, "A user with this email already exists");
      state.counter += 1;
      const id = `usr_${state.counter}_${randomBytes(4).toString("hex")}`;
      const created: User = {
        id,
        name: parsed.data.name.trim(),
        email: parsed.data.email.trim().toLowerCase(),
        roleId: "role_client",
        permissionOverrides: [],
        status: "Active",
        initials: initials(parsed.data.name),
        departmentId: null,
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
      };
      state.users[id] = created;
      state.passwordHashes[id] = passwordHash;
      return created;
    })
    .catch((error: unknown) => {
      if (error instanceof HTTPFailure) return error;
      throw error;
    });
  if (user instanceof HTTPFailure)
    return reply.status(user.status).send(fail(user.message, null));
  return reply
    .status(201)
    .send(
      ok(
        await issueSession(user, false, services),
        "Registration successful",
        null,
      ),
    );
}

/*******************************************************************************
 * Function: refresh
 *
 * Exchanges a valid refresh token for a renewed session.
 ******************************************************************************/
async function refresh(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const schema = z.object({ refreshToken: z.string() }).strict();
  const parsed = schema.safeParse(request.body);
  if (!parsed.success || parsed.data.refreshToken === "")
    return reply.status(400).send(fail("Refresh token is required", null));
  const digest = sha256(parsed.data.refreshToken);
  const user = await services.repository.mutate((state) => {
    const session = state.refreshSessions[digest];
    if (session === undefined) return null;
    delete state.refreshSessions[digest];
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return state.users[session.userId] ?? null;
  });
  if (user === null || user.status.toLowerCase() !== "active")
    return reply
      .status(401)
      .send(fail("Invalid or expired refresh token", null));
  return reply.send(
    ok(await issueSession(user, false, services), "Token refreshed", null),
  );
}

/*******************************************************************************
 * Function: logout
 *
 * Revokes the supplied refresh session.
 ******************************************************************************/
async function logout(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  const token =
    isRecord(request.body) && typeof request.body.refreshToken === "string"
      ? request.body.refreshToken
      : "";
  if (token !== "")
    await services.repository.mutate((state) => {
      delete state.refreshSessions[sha256(token)];
    });
  return reply.send(ok({ loggedOut: true }, "Logged out", null));
}

/*******************************************************************************
 * Function: authenticate
 *
 * Resolves and validates the request's authentication token and user.
 ******************************************************************************/
async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<{ user: User & { role: string; permissions: string[] } } | null> {
  let token = "";
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    token = header.slice(7).trim();
  if (
    token === "" &&
    request.url.startsWith("/ws/") &&
    isRecord(request.query) &&
    typeof request.query.token === "string"
  )
    token = request.query.token;
  if (token === "") {
    await reply.status(401).send(fail("Missing access token", null));
    return null;
  }
  try {
    const claims = jwt.verify(token, services.config.jwtSecret, {
      algorithms: ["HS256"],
    });
    if (
      typeof claims === "string" ||
      typeof claims.sub !== "string" ||
      claims.sub.trim() === ""
    ) {
      await reply.status(401).send(fail("Invalid token subject", null));
      return null;
    }
    const user = await services.repository.effectiveUser(claims.sub);
    if (user === null) {
      await reply
        .status(401)
        .send(fail("Authenticated user no longer exists", null));
      return null;
    }
    if (user.status.toLowerCase() !== "active") {
      await reply.status(403).send(fail("User account is not active", null));
      return null;
    }
    return { user };
  } catch {
    await reply.status(401).send(fail("Invalid or expired access token", null));
    return null;
  }
}

/*******************************************************************************
 * Function: issueSession
 *
 * Creates access and refresh tokens and stores the refresh session.
 ******************************************************************************/
async function issueSession(
  user: User,
  remember: boolean,
  services: ApplicationServices,
): Promise<Record<string, unknown>> {
  const accessToken = jwt.sign({}, services.config.jwtSecret, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: services.config.tokenTTLSeconds,
  });
  const refreshToken = `refresh_${randomBytes(24).toString("hex")}`;
  const days = remember ? 30 : 7;
  await services.repository.mutate((state) => {
    state.refreshSessions[sha256(refreshToken)] = {
      userId: user.id,
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    };
  });
  const effective = await services.repository.effectiveUser(user.id);
  return {
    accessToken,
    refreshToken,
    expiresIn: services.config.tokenTTLSeconds,
    user: publicUser(effective!),
  };
}

/*******************************************************************************
 * Function: listWorkflows
 *
 * Returns workflows visible to the current user.
 ******************************************************************************/
async function listWorkflows(
  _request: FastifyRequest,
  reply: FastifyReply,
  user: User & { permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  const state = await services.repository.snapshot();
  const all = Object.values(state.workflows).filter((item) => !item.archived);
  const visible = user.permissions.includes("workflow:read")
    ? all
    : all.filter(
        (item) =>
          item.owner.id === user.id ||
          (item.assignedUserIds ?? []).includes(user.id),
      );
  return reply.send(
    ok(visible.map(publicWorkflow), "OK", {
      page: 1,
      limit: 20,
      total: visible.length,
      totalPages: visible.length === 0 ? 0 : 1,
      sort: "updatedAt",
      relevance: "relevant",
    }),
  );
}

/*******************************************************************************
 * Function: createWorkflow
 *
 * Validates and stores a new workflow from the request.
 ******************************************************************************/
async function createWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string },
  services: ApplicationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const schema = z
    .object({
      name: z.string().default(""),
      description: z.string().default(""),
      yaml: z.string().optional(),
      candidate: z
        .object({
          yaml: z.string(),
          candidate_id: z.string().optional(),
          id: z.string().optional(),
          chatSessionId: z.string().optional(),
          chatMessageId: z.string().optional(),
          traceId: z.string().optional(),
        })
        .passthrough()
        .optional(),
      tags: z.array(z.string()).optional(),
      chatSessionId: z.string().optional(),
      chatMessageId: z.string().optional(),
      traceId: z.string().optional(),
    })
    .strict();
  const parsed = schema.safeParse(request.body);
  if (!parsed.success)
    return reply.status(400).send(fail("Workflow YAML is required", null));
  const rawYAML = parsed.data.candidate?.yaml ?? parsed.data.yaml ?? "";
  if (rawYAML.trim() === "")
    return reply.status(400).send(fail("Workflow YAML is required", null));
  const chatSessionId = (
    parsed.data.chatSessionId ?? parsed.data.candidate?.chatSessionId ?? ""
  ).trim();
  const chatMessageId = (
    parsed.data.chatMessageId ?? parsed.data.candidate?.chatMessageId ?? ""
  ).trim();
  const linkedTraceId = (
    parsed.data.traceId ?? parsed.data.candidate?.traceId ?? ""
  ).trim();
  if (linkedTraceId !== "" && !isTraceId(linkedTraceId))
    return reply.status(400).send(fail("Invalid trace ID", null));
  const traceId = requestTraceId(
    request,
    linkedTraceId === "" ? undefined : linkedTraceId,
  );
  if ((chatSessionId === "") !== (chatMessageId === ""))
    return reply
      .status(400)
      .send(fail("Chat session and message IDs must be provided together", null));
  if (chatSessionId !== "") {
    const originExists = await services.repository.read((state) => {
      const chat = state.chats[chatSessionId];
      if (
        chat === undefined ||
        (chat.ownerId !== user.id &&
          !(user as User & { permissions?: string[] }).permissions?.includes(
            "workflow:read",
          ))
      )
        return false;
      return chat.messages.some(
        (message) =>
          message.id === chatMessageId && stringValue(message.role) === "user",
      );
    });
    if (!originExists)
      return reply.status(400).send(fail("Chat candidate origin not found", null));
  }
  let blueprint;
  try {
    blueprint = parseWorkflowYAMLStrict(rawYAML);
  } catch (error) {
    return reply
      .status(422)
      .send(fail("Workflow validation failed", { error: errorText(error) }));
  }
  const gate = await validateWithGovernance(
    services,
    "CreateWorkflow",
    rawYAML,
    user,
    {
      traceId,
      ...(chatSessionId === "" ? {} : { sessionId: chatSessionId }),
      ...(chatMessageId === "" ? {} : { messageId: chatMessageId }),
      candidateId:
        parsed.data.candidate?.candidate_id ?? parsed.data.candidate?.id,
    },
  );
  if (!gate.result.passed)
    return reply
      .status(422)
      .send(fail("Workflow validation failed", { ...gate.result, traceId }));
  const workflow = await services.repository.mutate((state) => {
    state.counter += 1;
    const id = `wf_${state.counter}_${randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    const requestedName = parsed.data.name.trim();
    const requestedDescription = parsed.data.description.trim();
    const blueprintDescription = blueprint.description ?? "";
    const fromCandidate = parsed.data.candidate !== undefined;
    // SAFETY: the strict workflow parser guarantees trigger.config is JSON-compatible; Workflow stores the same value as a generic object.
    const item: Workflow = {
      id,
      name: requestedName === "" ? blueprint.name : requestedName,
      description:
        requestedDescription === ""
          ? blueprintDescription
          : requestedDescription,
      owner: { id: user.id, name: user.name },
      assignedUserIds: [],
      status: "PENDING",
      trigger: blueprint.trigger as unknown as Record<string, unknown>,
      steps: blueprint.steps.length,
      successRate: 0,
      lastRunAt: null,
      publishedVersion: 0,
      draftVersion: 1,
      tags: parsed.data.tags ?? [],
      domainTags: [],
      canRun: false,
      createdAt: now,
      updatedAt: now,
      yaml: rawYAML,
      archived: false,
      ...(chatSessionId === ""
        ? {}
        : { chatSessionId, chatMessageId }),
      ...(linkedTraceId === "" ? {} : { traceId }),
    };
    state.workflows[id] = item;
    if (fromCandidate) {
      state.counter += 1;
      state.versions[id] = [
        {
          id: `ver_${state.counter}_${randomBytes(4).toString("hex")}`,
          workflowId: id,
          version: 1,
          artifactState: "DRAFT",
          versionNote: "Validated generated candidate",
          yaml: rawYAML,
          sourceCandidateId:
            parsed.data.candidate?.candidate_id ??
            parsed.data.candidate?.id ??
            "",
          createdAt: now,
          createdBy: { id: user.id, name: user.name },
        },
      ];
    }
    return item;
  });
  return reply
    .status(201)
    .send(ok(publicWorkflow(workflow), "Workflow created", null));
}

/*******************************************************************************
 * Function: getWorkflow
 *
 * Returns a workflow when it is visible to the current user.
 ******************************************************************************/
async function getWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  const id = param(request, "id");
  const item = await services.repository.read(
    (state) => state.workflows[id] ?? null,
  );
  if (
    item === null ||
    (!user.permissions.includes("workflow:read") &&
      item.owner.id !== user.id &&
      !(item.assignedUserIds ?? []).includes(user.id))
  )
    return reply.status(404).send(fail("Workflow not found", null));
  return reply.send(ok(publicWorkflow(item), "OK", null));
}

/*******************************************************************************
 * Function: validateWorkflow
 *
 * Validates the requested workflow and returns the gate result.
 ******************************************************************************/
async function validateWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string },
  services: ApplicationServices,
): Promise<unknown> {
  const item = await services.repository.read(
    (state) => state.workflows[param(request, "id")] ?? null,
  );
  if (item === null)
    return reply.status(404).send(fail("Workflow not found", null));
  const raw =
    isRecord(request.body) && typeof request.body.yaml === "string"
      ? request.body.yaml
      : item.yaml;
  const traceId = requestTraceId(request, item.traceId);
  const gate = await validateWithGovernance(
    services,
    "ValidateWorkflow",
    raw,
    user,
    { traceId, workflowId: item.id },
  );
  return reply.send(
    ok(
      gate.result,
      gate.result.passed ? "Workflow is valid" : "Workflow is invalid",
      { traceId },
    ),
  );
}

/*******************************************************************************
 * Function: runWorkflow
 *
 * Loads the requested workflow and delegates its execution.
 ******************************************************************************/
async function runWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string; permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  if (!boundedReadFixtureRequest(request.body)) return reply.status(400).send(fail("Invalid or oversized read simulation fixtures", { code: "SIMULATION_FIXTURES_INVALID" }));
  if (!runWorkflowRequestSchema.safeParse(request.body ?? {}).success)
    return reply.status(400).send(fail("Invalid request body", null));
  const workflow = await services.repository.read(
    (state) => state.workflows[param(request, "id")] ?? null,
  );
  if (workflow === null)
    return reply.status(404).send(fail("Workflow not found", null));
  return runWorkflowFor(workflow, request, reply, user, services);
}

// Shared by POST /workflows/:id/run and POST /executions/:id/retry — the ONLY
// normal workflow admission path: exact published read/collection or separately
// compiled independently approved operations, without LLM reinterpretation.
/*******************************************************************************
 * Function: runWorkflowFor
 *
 * Validates a workflow run request and manages its execution lifecycle.
 ******************************************************************************/
export async function runWorkflowFor(
  workflow: Workflow,
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string; permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  // Repository.read exposes references. Pin before any awaited validation so a
  // concurrent draft edit cannot mutate this run's source/version in place.
  workflow = structuredClone(workflow);
  if (!boundedReadFixtureRequest(request.body)) return reply.status(400).send(fail("Invalid or oversized read simulation fixtures", { code: "SIMULATION_FIXTURES_INVALID" }));
  const parsed = runWorkflowRequestSchema.safeParse(request.body ?? {});
  if (!parsed.success)
    return reply.status(400).send(fail("Invalid request body", null));
  const traceId = requestTraceId(request, workflow.traceId);
  // Shared by run and retry: permissions and assignment never depend on an
  // optional policy toggle, and must be checked before any external work.
  if (!user.permissions.some((permission) => ["workflow:run", "workflow:run_own"].includes(permission)))
    return reply.status(403).send(fail("Permission denied", { requiredAny: ["workflow:run", "workflow:run_own"] }));
  if (
    !user.permissions.includes("workflow:run") &&
    workflow.owner.id !== user.id &&
    !(workflow.assignedUserIds ?? []).includes(user.id)
  )
    return reply
      .status(403)
      .send(fail("Workflow is not assigned to the current user", null));
  if (workflow.yaml.length > 200_000) return reply.status(422).send(fail("Workflow source exceeds supported limits", { traceId }));
  if (parsed.data.simulation !== undefined && !parsed.data.dryRun) return reply.status(400).send(fail("Fixture simulation requires dryRun; test data cannot be used for real execution", { code: "SIMULATION_MODE_REQUIRED", traceId }));
  // Routing only, never authority. Admission/worker decisions recheck inside
  // acknowledged transactions. Preserve the read simulation's own error/fence.
  const operationPublication = await services.repository.read(state => (state.versions[workflow.id] ?? []).findLast(version => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED"));
  if (operationPublication?.compiledOperation || parsed.data.mode === "async-operation") {
    if (!["", "execute", "async-read", "async-operation"].includes(parsed.data.mode)) return reply.status(422).send(fail("Unsupported operation execution mode", { code: "UNSUPPORTED_EXECUTION_MODE", traceId }));
    if (parsed.data.dryRun) return reply.send(ok({ dry_run: true, simulation: "static-operation-plan", can_execute: false, live_readiness: "not_checked", requires_independent_approval: true,
      planned_steps: withoutSecretFields(parseWorkflowYAMLStrict(workflow.yaml).steps) }, "Static operation plan only; no ERP calls or effects occurred", { traceId }));
    const admission = await operationJobQueue(services).admit(workflow, parsed.data.input ?? {}, user, parsed.data.idempotencyKey, traceId);
    return reply.status(202).send(ok(admission.execution, admission.replayed ? "Existing operation run; no additional run admitted" : "Operation queued; verification and independent approvals are required before writes", { traceId, admission: "operation-job/v1", replayed: admission.replayed }));
  }
  const asyncRead = parsed.data.mode === "async-read";
  if (asyncRead) {
    if (parsed.data.dryRun) return reply.status(422).send(fail("Async admission is not a dry-run mode", { code: "UNSUPPORTED_EXECUTION_MODE", traceId }));
    const queue = readJobQueue(services);
    const admission = queue.prepare(workflow, parsed.data.input ?? {}, user, parsed.data.idempotencyKey);
    const existing = await services.repository.read((state) => queue.existing(state, admission, user));
    if (existing) return reply.status(202).send(ok(existing, "Existing read run for this idempotency key; no additional run was admitted", { traceId, admission: "read-job-v1", replayed: true }));
  }
  if (!["", "execute", "deterministic-read", "async-read"].includes(parsed.data.mode) || (!asyncRead && parsed.data.idempotencyKey !== ""))
    return reply.status(422).send(fail("Requested execution mode or idempotency contract is not implemented", { code: "UNSUPPORTED_EXECUTION_MODE", traceId }));
  if (parsed.data.dryRun) {
    if (parsed.data.simulation !== undefined) return handleReadFixtureSimulation(request, reply, services, user, workflow, parsed.data.simulation, parsed.data.input ?? {}, traceId);
    const validation = services.validator.validatePlan("ReadWorkflowSimulation", workflow.yaml, user.role);
    let issues: string[] = [];
    try { issues = inspectReadWorkflow(parseWorkflowYAMLStrict(workflow.yaml), services.registries.snapshot().tools, user.role); }
    catch { issues = ["Workflow could not be parsed"]; }
    return reply.send(ok({ dry_run: true, simulation: "static-read-plan", can_execute: false,
      plan_valid: validation.passed && issues.length === 0, validation, issues, live_readiness: "not_checked",
      planned_steps: (() => { try { return withoutSecretFields(parseWorkflowYAMLStrict(workflow.yaml).steps); } catch { return []; } })() },
      "Static simulation only; no live discovery or execution was performed", { traceId }));
  }
  // Accepting the build proposal does not authorize runtime transactions.
  if (workflow.pendingGenerationApproval && workflow.pendingGenerationApproval.steps.length > 0)
    return reply.status(409).send(
      fail("This workflow has a pending approval — resolve it in chat before running", {
        pendingGenerationApproval: workflow.pendingGenerationApproval,
      }),
    );
  const gate = await validateWithGovernance(services, "RunWorkflow", workflow.yaml, user, { traceId, workflowId: workflow.id });
  if (!gate.result.passed)
    return reply.status(422).send(fail("Workflow validation failed", { ...gate.result, traceId }));
  // The legacy agent cannot enforce transaction approval boundaries.
  const checkedBlueprint = parseWorkflowYAMLStrict(workflow.yaml);
  if (checkedBlueprint.steps.some((step) => step.kind === "approval"))
    return reply.status(409).send(fail("Runtime approval checkpoints require the safe checkpoint executor; this legacy run is blocked", { code: "RUNTIME_APPROVAL_EXECUTOR_REQUIRED", traceId }));
  if (workflow.publishedVersion < 1)
    return reply.status(409).send(fail("Publish the validated draft before execution", { code: "WORKFLOW_NOT_PUBLISHED", traceId }));
  const publication = await services.repository.read((state) => (state.versions[workflow.id] ?? [])
    .findLast((version) => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED"));
  if (publication === undefined || typeof publication.yaml !== "string" || publication.yaml !== workflow.yaml)
    return reply.status(409).send(fail("A current verified publication snapshot is required; legacy or edited drafts need explicit publication", { code: "PUBLISHED_SNAPSHOT_REQUIRED", traceId }));
  if (gate.token === null) return reply.status(422).send(fail("Execution verification receipt is unavailable", { traceId }));
  return runVerifiedRead(workflow, parsed.data.input ?? {}, gate.token, traceId, request, reply, user, services);
}

// Legacy records may still contain pending approvals. Do not resume them via
// a model prompt: there is no durable, exact-transaction approval executor yet.
export async function resumeWorkflowApproval(
  execution: Execution,
  _note: string,
  _request: FastifyRequest,
  reply: FastifyReply,
  _user: User & { role: string; permissions: string[] },
  _services: ApplicationServices,
): Promise<unknown> {
  if (execution.status !== "AWAITING_APPROVAL" || !execution.pendingApproval)
    return reply.status(409).send(fail("This execution is not awaiting approval", null));
  return reply.status(409).send(fail("Runtime approval resume requires the safe checkpoint executor", {
    code: "RUNTIME_APPROVAL_EXECUTOR_REQUIRED", executionId: execution.id,
  }));
}

/*******************************************************************************
 * Function: listExecutions
 *
 * Returns visible executions filtered by the request parameters.
 ******************************************************************************/
async function listExecutions(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  const state = await services.repository.snapshot();
  const query = request.query as Record<string, unknown>;
  const traceId = stringValue(query.traceId).trim();
  if (traceId !== "") {
    if (!isTraceId(traceId))
      return reply.status(400).send(fail("Invalid trace ID", null));
    const chain = buildTraceChain(state, user, traceId);
    return reply.send(
      ok(chain, "OK", { traceId, count: chain.length }),
    );
  }
  const chatSessionId = stringValue(query.chatSessionId).trim();
  const all = Object.values(state.executions).filter(
    (item) => chatSessionId === "" || item.chatSessionId === chatSessionId,
  );
  const visible = visibleExecutions(user, all);
  return reply.send(
    ok(visible.map((item) => withoutSecretFields(item)), "OK", {
      page: 1,
      limit: 20,
      total: visible.length,
      totalPages: visible.length === 0 ? 0 : 1,
    }),
  );
}

/*******************************************************************************
 * Function: getExecution
 *
 * Returns an execution when the current user can read it.
 ******************************************************************************/
async function getExecution(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  if (isRecord(request.query) && request.query.view === "reconciliation") {
    if (Object.keys(request.query).some(key => key !== "view")) throw new HandlerFailure(400, "Unsupported reconciliation review query");
    const review = await services.repository.readAuthoritative(state => operationReconciliationView(state, param(request, "id"), user.id));
    return reply.send(ok(review, "Exact uncertain operation evidence only; no dispatch authority", null));
  }
  if (isRecord(request.query) && request.query.view === "approval") {
    if (Object.keys(request.query).some(key => key !== "view")) throw new HandlerFailure(400, "Unsupported approval review query");
    const review = await services.repository.readAuthoritative(state => runtimeApprovalView(state, param(request, "id"), user.id));
    return reply.send(ok(review, "Exact transaction review only; approval does not execute", null));
  }
  // A review-only permission is not a read grant, even if this account started
  // the execution before its role changed. Minimum views are handled above.
  if (!user.permissions.some(key => ["workflow:read", "execution:read_own"].includes(key)))
    return reply.status(404).send(fail("Execution not found", null));
  const item = await services.repository.read(
    (state) => state.executions[param(request, "id")] ?? null,
  );
  if (
    item === null ||
    !canReadExecution(user, item)
  )
    return reply.status(404).send(fail("Execution not found", null));
  return reply.send(ok(withoutSecretFields({ ...item, ...(item.runtimeApprovalSecret ? { hasRuntimeApproval: true } : {}), ...(hasOperationReconciliation(item) ? { hasOperationReconciliation: true } : {}) }), "OK", null));
}

/*******************************************************************************
 * Function: genericRoute
 *
 * Returns the fallback response for a route without a specific handler.
 ******************************************************************************/
async function genericRoute(
  route: RouteDefinition,
  _request: FastifyRequest,
  reply: FastifyReply,
  _user: User | null,
  services: ApplicationServices,
): Promise<unknown> {
  if (route.method === "GET") {
    if (route.path.endsWith("/:id") || route.path.includes(":id/"))
      return reply.status(404).send(fail("Resource not found", null));
    return reply.send(ok([], "OK", { count: 0 }));
  }
  if (route.method === "DELETE")
    return reply.status(404).send(fail("Resource not found", null));
  if (route.path === `${services.config.apiBasePath}/semantic-index/rebuild`)
    return reply
      .status(503)
      .send(fail("Semantic search service is unavailable", null));
  throw new Error(`Missing route dispatch for ${route.method} ${route.path}`);
}

/*******************************************************************************
 * Function: routePolicy
 *
 * Determines the permission required for an HTTP route.
 ******************************************************************************/
function routePolicy(
  route: RouteDefinition,
): { required: string[]; any: boolean } | null {
  const path = route.path;
  if (path.startsWith("/api/import"))
    return { required: ["registry:write"], any: false };
  // Must precede the general profile self-service exemption.
  if (path.startsWith("/api/profile/api-keys"))
    return { required: ["settings:manage"], any: false };
  if (
    path.startsWith("/ws/") ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/company") ||
    path.startsWith("/api/profile") ||
    path.startsWith("/api/notifications")
  )
    return null;
  if (
    path.startsWith("/api/users") ||
    path.startsWith("/api/roles") ||
    path.startsWith("/api/permissions")
  )
    return { required: ["user:manage"], any: false };
  if (path.startsWith("/api/audit"))
    return { required: ["audit:read"], any: false };
  if (path.startsWith("/api/registry"))
    return {
      required: [route.method === "GET" ? "registry:read" : "registry:write"],
      any: false,
    };
  if (
    path.startsWith("/api/settings") ||
    path.startsWith("/api/integrations") ||
    path.includes("/api-keys")
  )
    return { required: ["settings:manage"], any: false };
  if (path.startsWith("/api/providers"))
    return { required: ["provider:manage"], any: false };
  if (path.startsWith("/api/executions"))
    if (path === "/api/executions/:id/reconcile" && route.method === "POST") return { required: ["execution:reconcile"], any: false };
  if (path.startsWith("/api/executions"))
    if (path === "/api/executions/:id" && route.method === "GET" || /\/executions\/:id\/(approve|reject)$/.test(path))
      return { required: route.method === "GET" ? ["workflow:read", "execution:read_own", "execution:approve", "execution:reconcile"] : ["workflow:run", "workflow:run_own", "execution:approve"], any: true };
  if (path.startsWith("/api/executions"))
    return route.method === "GET"
      ? { required: ["workflow:read", "execution:read_own"], any: true }
      : { required: ["workflow:run", "workflow:run_own"], any: true };
  if (path.startsWith("/api/chat"))
    return {
      required:
        route.method === "GET"
          ? ["workflow:read", "chat:use"]
          : ["workflow:write", "chat:use"],
      any: true,
    };
  if (path.startsWith("/api/workflows") && path.endsWith("/run"))
    return { required: ["workflow:run", "workflow:run_own"], any: true };
  if (
    path.startsWith("/api/workflows") ||
    path.startsWith("/api/synthesis") ||
    path.startsWith("/api/tools") ||
    path.startsWith("/api/rules") ||
    path.startsWith("/api/semantic") ||
    path.startsWith("/api/canvas") ||
    path.startsWith("/api/dashboard") ||
    path.startsWith("/api/analytics") ||
    path.startsWith("/api/upload")
  )
    return route.method === "GET"
      ? { required: ["workflow:read", "workflow:read_own"], any: true }
      : { required: ["workflow:write"], any: false };
  // A newly registered protected route without an access policy must not
  // silently become accessible to every authenticated account.
  return { required: [], any: true };
}

/*******************************************************************************
 * Function: publicUser
 *
 * Projects user data into its public representation without the password
 * hash.
 ******************************************************************************/
function publicUser(
  user: (User & { role?: string; permissions?: string[] }) | null,
): Record<string, unknown> {
  if (user === null) return {};
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roleId: user.roleId,
    permissionOverrides: user.permissionOverrides,
    status: user.status,
    initials: user.initials,
    ...(user.timezone === undefined ? {} : { timezone: user.timezone }),
    departmentId: user.departmentId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    ...(user.twoFactorEnabled === undefined
      ? {}
      : { twoFactorEnabled: user.twoFactorEnabled }),
    ...(user.emailVerified === undefined
      ? {}
      : { emailVerified: user.emailVerified }),
    role: user.role ?? "",
    permissions: user.permissions ?? [],
  };
}
/*******************************************************************************
 * Function: publicWorkflow
 *
 * Projects workflow data into the response shape for this handler.
 ******************************************************************************/
function publicWorkflow(
  workflow: Workflow,
): Omit<Workflow, "yaml" | "archived"> {
  const { yaml: _yaml, archived: _archived, ...publicPart } = workflow;
  return publicPart;
}
/*******************************************************************************
 * Function: param
 *
 * Reads a named route parameter as a string.
 ******************************************************************************/
function param(request: FastifyRequest, name: string): string {
  return String((request.params as Record<string, unknown>)[name] ?? "");
}
/*******************************************************************************
 * Function: initials
 *
 * Builds uppercase initials from the first two name components.
 ******************************************************************************/
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
/*******************************************************************************
 * Function: sha256
 *
 * Computes a hexadecimal SHA-256 digest of the supplied value.
 ******************************************************************************/
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/*******************************************************************************
 * Function: isRecord
 *
 * Checks whether a value is a non-null object other than an array.
 ******************************************************************************/
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
class HTTPFailure extends Error {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a HTTPFailure instance with its required state.
   ******************************************************************************/
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/*******************************************************************************
 * Function: listNotifications
 *
 * Returns notifications using this handler's visibility and ordering rules.
 ******************************************************************************/
async function listNotifications(
  reply: FastifyReply,
  _user: User,
  services: ApplicationServices,
): Promise<unknown> {
  const state = await services.repository.snapshot();
  const all = Object.values(state.notifications) as Array<Record<string, unknown>>;
  all.sort((a, b) => {
    const ta = typeof a.createdAt === "string" ? a.createdAt : "";
    const tb = typeof b.createdAt === "string" ? b.createdAt : "";
    return tb.localeCompare(ta);
  });
  return reply.send(ok(all, "OK", { count: all.length }));
}

/*******************************************************************************
 * Function: markNotificationRead
 *
 * Marks a notification as read and records the read time.
 ******************************************************************************/
async function markNotificationRead(
  request: FastifyRequest,
  reply: FastifyReply,
  _user: User,
  services: ApplicationServices,
): Promise<unknown> {
  const id = param(request, "id");
  const updated = await services.repository.mutate((state) => {
    const notif = state.notifications[id];
    if (notif === undefined) return null;
    notif.read = true;
    notif.readAt = new Date().toISOString();
    return structuredClone(notif);
  });
  if (updated === null) return reply.status(404).send(fail("Notification not found", null));
  return reply.send(ok(updated, "Marked as read", null));
}

/*******************************************************************************
 * Function: deleteNotification
 *
 * Deletes the requested notification.
 ******************************************************************************/
async function deleteNotification(
  request: FastifyRequest,
  reply: FastifyReply,
  _user: User,
  services: ApplicationServices,
): Promise<unknown> {
  const id = param(request, "id");
  const existed = await services.repository.mutate((state) => {
    if (state.notifications[id] === undefined) return false;
    delete state.notifications[id];
    return true;
  });
  // Idempotent deletion keeps the captured API contract, while the data
  // reports whether a record actually existed.
  return reply.send(ok({ deleted: existed }, "Notification deleted", null));
}

/*******************************************************************************
 * Function: markAllNotificationsRead
 *
 * Marks unread notifications as read and reports the updated count.
 ******************************************************************************/
async function markAllNotificationsRead(
  reply: FastifyReply,
  _user: User,
  services: ApplicationServices,
): Promise<unknown> {
  const now = new Date().toISOString();
  const count = await services.repository.mutate((state) => {
    let n = 0;
    for (const notif of Object.values(state.notifications)) {
      if (notif.read !== true) { notif.read = true; notif.readAt = now; n++; }
    }
    return n;
  });
  return reply.send(ok({ markedRead: count }, "All notifications marked read", null));
}
