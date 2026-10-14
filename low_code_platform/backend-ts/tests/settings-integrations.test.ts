import type { FastifyReply } from "fastify";
import { expect, test, vi } from "vitest";
import type { RouteDefinition } from "../src/http/generated-routes.js";
import type { CurrentUser, HandlerServices } from "../src/http/handlers/common.js";
import { handleSettingsIntegrationRoute } from "../src/http/handlers/settings-integrations.js";

const user = {
  id: "usr_admin",
  name: "Admin",
  email: "admin@example.test",
  roleId: "role_admin",
  role: "Platform Admin",
  permissions: ["settings:manage"],
  permissionOverrides: [],
  status: "Active",
  initials: "AD",
  departmentId: null,
  lastLoginAt: null,
  createdAt: "2026-10-07T00:00:00.000Z",
} satisfies CurrentUser;

test("webhook and integration lists recursively redact stored credentials", async () => {
  const state = {
    webhooks: {
      webhook_one: {
        id: "webhook_one",
        name: "Manager notifications",
        secret: "private-webhook-secret",
        secretPreview: "...secret",
      },
    },
    integrations: {
      integration_one: {
        id: "integration_one",
        name: "Legacy record",
        config: { baseUrl: "https://example.test", apiKey: "private-api-key" },
      },
    },
  };
  const services = {
    config: { apiBasePath: "/api" },
    repository: { read: async (reader: (value: typeof state) => unknown) => reader(state) },
  } as unknown as HandlerServices;
  const reply = {
    send: vi.fn((payload: unknown) => payload),
  } as unknown as FastifyReply;

  const webhookResult = await handleSettingsIntegrationRoute(
    { method: "GET", path: "/api/settings/webhooks" } as RouteDefinition,
    {} as never,
    reply,
    user,
    services,
  );
  const integrationResult = await handleSettingsIntegrationRoute(
    { method: "GET", path: "/api/integrations" } as RouteDefinition,
    {} as never,
    reply,
    user,
    services,
  );

  expect(JSON.stringify(webhookResult)).not.toMatch(/private-webhook-secret|secretPreview/);
  expect(JSON.stringify(integrationResult)).not.toContain("private-api-key");
});
