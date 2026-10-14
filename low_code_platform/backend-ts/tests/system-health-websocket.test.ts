import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildSystemHealthSnapshot } from "../src/http/system-health-websocket.js";
import type { ApplicationServices } from "../src/http/application-services.js";

const config = loadConfig({
  APP_ENV: "test", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
  ERPBRIDGE_BASE_URL: "https://erpbridge.example.test", ERPBRIDGE_MCP_TOKEN: "secret",
  ERPBRIDGE_ROLE_MAP: JSON.stringify({ "Workflow Builder": "workflow_builder" }),
});

function services(input: { healthy?: boolean; durable?: boolean; fail?: boolean } = {}): ApplicationServices {
  const repository = {
    async snapshot() {
      if (input.fail) throw new Error("repository unavailable");
      return {
        workflows: { active: { archived: false }, archived: { archived: true } },
        executions: { running: { status: "RUNNING" }, done: { status: "SUCCEEDED" } },
      };
    },
    async persistenceStatus() {
      if (input.fail) throw new Error("persistence unavailable");
      return { durable: input.durable ?? true, healthy: input.healthy ?? true };
    },
  };
  return { config, repository } as unknown as ApplicationServices;
}

describe("health-only websocket projection", () => {
  test("reports local storage health and keeps modern MCP readiness explicitly unchecked", async () => {
    const snapshot = await buildSystemHealthSnapshot("system-health", services());
    expect(snapshot).toMatchObject({ type: "system.health.snapshot", data: {
      channel: "system-health", overall: "healthy", scope: "local-runtime",
      workflows: 1, executions: 2, runningExecutions: 1,
      storage: { durable: true, status: "healthy" },
      mcpConfigured: true, mcpLiveStatus: "not_checked",
    } });
  });

  test("does not fabricate healthy counts when authoritative health data is unavailable", async () => {
    const snapshot = await buildSystemHealthSnapshot("system-health", services({ fail: true }));
    expect(snapshot).toMatchObject({ data: {
      overall: "degraded", scope: "local-runtime", workflows: null,
      executions: null, runningExecutions: null,
      storage: { durable: null, status: "unavailable" },
      mcpConfigured: true, mcpLiveStatus: "not_checked",
    } });
  });

  test("reports degraded when the persistence probe is unhealthy", async () => {
    const snapshot = await buildSystemHealthSnapshot("system-health", services({ healthy: false }));
    expect(snapshot).toMatchObject({ data: { overall: "degraded", storage: { status: "unhealthy" } } });
  });
});
