import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ApplicationServices } from "./application-services.js";
import { isMcpConfigured } from "../config/config.js";

type HealthSocket = {
  readyState: number;
  send(data: string): void;
  once(event: "close" | "error", listener: () => void): void;
};

/** Owns the health-only socket lifetime. This is not an execution event feed. */
export function attachSystemHealthSocket(socket: HealthSocket, request: FastifyRequest, services: ApplicationServices): void {
  const wildcard = (request.params as Record<string, unknown>)["*"];
  const channel = typeof wildcard === "string" && wildcard.trim() !== "" ? wildcard : "system-health";
  const interval = setInterval(() => { void sendSystemHealthSnapshot(socket, channel, services); }, 5_000);
  socket.once("close", () => clearInterval(interval));
  socket.once("error", () => clearInterval(interval));
}

async function sendSystemHealthSnapshot(socket: HealthSocket, channel: string, services: ApplicationServices): Promise<void> {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(await buildSystemHealthSnapshot(channel, services)));
}

/** Builds one bounded configuration/local-runtime snapshot. External MCP
 * readiness is deliberately not inferred from configured credentials. */
export async function buildSystemHealthSnapshot(channel: string, services: ApplicationServices): Promise<Record<string, unknown>> {
  const base = {
    type: "system.health.snapshot",
    id: `event_${randomBytes(8).toString("hex")}`,
    timestamp: new Date().toISOString(),
  };
  const mcpConfigured = isMcpConfigured(services.config);
  try {
    const [state, storage] = await Promise.all([
      services.repository.snapshot(),
      services.repository.persistenceStatus(),
    ]);
    const workflows = Object.values(state.workflows).filter((item) => !item.archived).length;
    const executions = Object.values(state.executions);
    return { ...base, data: {
      channel, overall: storage.healthy ? "healthy" : "degraded", scope: "local-runtime",
      workflows,
      executions: executions.length,
      runningExecutions: executions.filter((item) => item.status === "RUNNING").length,
      storage: { durable: storage.durable, status: storage.healthy ? "healthy" : "unhealthy" },
      mcpConfigured,
      mcpLiveStatus: "not_checked",
    } };
  } catch {
    return { ...base, data: {
      channel, overall: "degraded", scope: "local-runtime", workflows: null,
      executions: null, runningExecutions: null,
      storage: { durable: null, status: "unavailable" },
      mcpConfigured,
      mcpLiveStatus: "not_checked",
    } };
  }
}
