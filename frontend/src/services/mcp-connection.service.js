import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const mcpConnectionService = {
  async status() {
    const value = unwrap(await apiClient.get("/settings/mcp-connections"));
    if (!value || !Array.isArray(value.connections) || !Array.isArray(value.recentOperations) || value.connections.length !== 1 ||
        value.connections[0]?.id !== "erpbridge-default" || !Number.isSafeInteger(value.connections[0]?.revision) ||
        typeof value.connections[0]?.initialized !== "boolean" || !value.connections[0]?.supports) throw new Error("Supported MCP lifecycle status is unavailable");
    return value;
  },
  async command(action, id, body) {
    if (!["connect", "disconnect", "test"].includes(action) || id !== "erpbridge-default") throw new Error("Unsupported MCP lifecycle command");
    return unwrap(await apiClient.post(`/settings/mcp-connections/${encodeURIComponent(id)}/${action}`, body));
  },
};
