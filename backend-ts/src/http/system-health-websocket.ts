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
  const state = await services.repository.snapshot();
  const workflows = Object.values(state.workflows).filter((item) => !item.archived).length;
  const executions = Object.values(state.executions);
  const runningExecutions = executions.filter((item) => item.status === "RUNNING").length;
  socket.send(JSON.stringify({
    type: "system.health.snapshot",
    id: `event_${randomBytes(8).toString("hex")}`,
    timestamp: new Date().toISOString(),
    data: {
      channel,
      overall: "healthy",
      workflows,
      executions: executions.length,
      runningExecutions,
      mcpConfigured: isMcpConfigured(services.config),
    },
  }));
}
