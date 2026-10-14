import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import type { RouteDefinition } from "../generated-routes.js";
import {
  bodyRecord,
  HandlerFailure,
  type CurrentUser,
  type HandlerServices,
  isRecord,
  nextID,
  now,
  requestParam,
  stringValue,
} from "./common.js";

export const SETTINGS_INTEGRATION_UNHANDLED = Symbol("settings-integration-unhandled");

/**
 * Owns persisted webhook/integration settings and the backend-managed MCP
 * connection lifecycle. Business tool execution remains outside this module.
 */
export async function handleSettingsIntegrationRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof SETTINGS_INTEGRATION_UNHANDLED> {
  const base = services.config.apiBasePath;

  if (route.path.startsWith(`${base}/settings/mcp-connections`)) {
    return handleMcpConnectionRoute(route, request, reply, user, services);
  }

  if (route.path === `${base}/settings/webhooks` && route.method === "GET") {
    const webhooks = await services.repository.read((state) =>
      Object.values(state.webhooks).map((item) => withoutSecretFields(item)),
    );
    return reply.send(ok(webhooks, "OK", null));
  }
  if (route.path === `${base}/settings/webhooks` && route.method === "POST") {
    return createWebhook(request, reply, services);
  }
  if (route.path === `${base}/settings/webhooks/:id` && route.method === "PATCH") {
    return updateWebhook(request, reply, services);
  }
  if (route.path === `${base}/settings/webhooks/:id` && route.method === "DELETE") {
    return deleteWebhook(request, reply, services);
  }
  if (route.path === `${base}/settings/webhooks/:id/test`) {
    return testWebhook(request, reply, services);
  }

  if (route.path === `${base}/integrations` && route.method === "GET") {
    const integrations = await services.repository.read((state) =>
      Object.values(state.integrations).map((item) => withoutSecretFields(item)),
    );
    return reply.send(ok(integrations, "OK", null));
  }
  if (route.path === `${base}/integrations` && route.method === "POST") {
    return createIntegration(request, reply, services);
  }
  if (route.path === `${base}/integrations/:id` && route.method === "GET") {
    return getIntegration(request, reply, services);
  }
  if (route.path === `${base}/integrations/:id` && route.method === "PATCH") {
    return updateIntegration(request, reply, services);
  }
  if (route.path === `${base}/integrations/:id` && route.method === "DELETE") {
    return deleteIntegration(request, reply, services);
  }
  if (route.path === `${base}/integrations/:id/test` || route.path === `${base}/integrations/:id/connect`) {
    return testIntegration(request, services);
  }
  if (route.path === `${base}/integrations/:id/disconnect`) {
    return disconnectIntegration(request, reply, services);
  }

  return SETTINGS_INTEGRATION_UNHANDLED;
}

async function handleMcpConnectionRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const runtime = services.mcpConnectionRuntime;
  if (!runtime) {
    throw new HandlerFailure(503, "This backend has no supported MCP lifecycle service", {
      code: "MCP_LIFECYCLE_UNAVAILABLE",
    });
  }
  if (route.method === "GET") {
    return reply.send(ok(
      await runtime.status(user),
      "Backend-owned MCP state; initialization is not ERP delivery",
      null,
    ));
  }
  const action = route.path.endsWith("/disconnect")
    ? "disconnect"
    : route.path.endsWith("/test")
      ? "test"
      : "connect";
  const connectionId = requestParam(request, "id");
  const result = await runtime.command(action, user, request.body, request, connectionId);
  return reply.send(ok(result, "MCP lifecycle operation acknowledged; no business tool was invoked", null));
}

async function createWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const name = stringValue(body.name).trim();
  if (name === "") throw new HandlerFailure(400, "Webhook name is required");
  const url = validURL(body.url);
  const events = stringArray(body.events);
  if (events.length === 0) throw new HandlerFailure(400, "Webhook events are required");

  const item = await services.repository.mutate((state) => {
    const id = nextID(state, "webhook");
    const secret = randomBytes(24).toString("hex");
    const value = {
      id,
      name,
      url,
      events,
      enabled: true,
      secretPreview: `...${secret.slice(-6)}`,
      secret,
      createdAt: now(),
    };
    state.webhooks[id] = value;
    return value;
  });
  return reply.status(201).send(ok(withoutSecretFields(item), "Webhook created", null));
}

async function updateWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const item = await services.repository.mutate((state) => {
    const value = state.webhooks[requestParam(request, "id")];
    if (value === undefined) throw new HandlerFailure(404, "Webhook not found");
    if (typeof body.name === "string") value.name = body.name;
    if (body.url !== undefined) value.url = validURL(body.url);
    if (Array.isArray(body.events)) value.events = stringArray(body.events);
    if (typeof body.enabled === "boolean") value.enabled = body.enabled;
    return structuredClone(value);
  });
  return reply.send(ok(withoutSecretFields(item), "Webhook updated", null));
}

async function deleteWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  await services.repository.mutate((state) => {
    delete state.webhooks[requestParam(request, "id")];
  });
  return reply.send(ok({ deleted: true }, "Webhook deleted", null));
}

async function testWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const item = await services.repository.read((state) =>
    state.webhooks[requestParam(request, "id")] ?? null,
  );
  if (item === null) throw new HandlerFailure(404, "Webhook not found");
  try {
    const response = await fetch(stringValue(item.url), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "webhook.test", timestamp: now() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return reply.send(ok({ ok: true, status: response.status }, "Webhook test succeeded", null));
  } catch (error) {
    throw new HandlerFailure(502, `Webhook test failed: ${errorText(error)}`);
  }
}

async function createIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const name = stringValue(body.name).trim();
  const type = stringValue(body.type).trim();
  if (name === "" || type === "") {
    throw new HandlerFailure(400, "Integration name and type are required");
  }
  const item = await services.repository.mutate((state) => {
    const id = nextID(state, "integration");
    const value = {
      id,
      name,
      type,
      status: "Disconnected",
      icon: stringValue(body.icon),
      config: isRecord(body.config) ? structuredClone(body.config) : {},
      lastTestedAt: null,
      createdAt: now(),
    };
    state.integrations[id] = value;
    return value;
  });
  return reply.status(201).send(ok(withoutSecretFields(item), "Integration created", null));
}

async function getIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const item = await services.repository.read((state) =>
    state.integrations[requestParam(request, "id")] ?? null,
  );
  if (item === null) throw new HandlerFailure(404, "Integration not found");
  return reply.send(ok(withoutSecretFields(item), "OK", null));
}

async function updateIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const item = await services.repository.mutate((state) => {
    const value = state.integrations[requestParam(request, "id")];
    if (value === undefined) throw new HandlerFailure(404, "Integration not found");
    if (typeof body.name === "string") value.name = body.name;
    if (typeof body.type === "string") value.type = body.type;
    if (isRecord(body.config)) value.config = structuredClone(body.config);
    return structuredClone(value);
  });
  return reply.send(ok(withoutSecretFields(item), "Integration updated", null));
}

async function deleteIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  await services.repository.mutate((state) => {
    delete state.integrations[requestParam(request, "id")];
  });
  return reply.send(ok({ deleted: true }, "Integration deleted", null));
}

async function testIntegration(request: FastifyRequest, services: HandlerServices): Promise<never> {
  const item = await services.repository.read((state) =>
    state.integrations[requestParam(request, "id")] ?? null,
  );
  if (item === null) throw new HandlerFailure(404, "Integration not found");
  const config = isRecord(item.config) ? item.config : {};
  const endpoint = [config.baseUrl, config.url, config.endpoint]
    .map(stringValue)
    .find((value) => value.trim() !== "");
  if (endpoint === undefined) throw new HandlerFailure(400, "Integration endpoint is not configured");

  // A generic URL has no protocol contract, credential policy, SSRF policy,
  // or agent-session authority. Only a typed adapter may establish readiness.
  throw new HandlerFailure(
    501,
    "A typed integration adapter is required. Use the backend MCP connection lifecycle for ERPBridge; this URL record cannot establish agent readiness",
    { code: "INTEGRATION_ADAPTER_REQUIRED" },
  );
}

async function disconnectIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const item = await services.repository.mutate((state) => {
    const value = state.integrations[requestParam(request, "id")];
    if (value === undefined) throw new HandlerFailure(404, "Integration not found");
    value.status = "Disconnected";
    return structuredClone(value);
  });
  return reply.send(ok(withoutSecretFields(item), "Integration disconnected", null));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function validURL(value: unknown): string {
  const text = stringValue(value).trim();
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return parsed.toString();
  } catch {
    throw new HandlerFailure(400, "A valid HTTP(S) URL is required");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
