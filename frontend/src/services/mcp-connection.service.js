import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const mcpConnectionService = {
  async status() {
    const value = unwrap(await apiClient.get("/settings/mcp-connections"));
    if (!value || !Array.isArray(value.connections) || !Array.isArray(value.recentOperations) || value.connections.length < 1 || value.connections.length > 8 ||
        new Set(value.connections.map(item => item?.id)).size !== value.connections.length || value.connections.filter(item => item?.primary).length !== 1 ||
        value.connections.some(item => !/^[a-z][a-z0-9_-]{0,63}$/.test(item?.id ?? "") || !Number.isSafeInteger(item?.revision) ||
          typeof item?.initialized !== "boolean" || typeof item?.dispatchSupported !== "boolean" || !item?.supports) ||
        value.primaryConnectionId !== value.connections.find(item => item.primary)?.id) throw new Error("Supported MCP lifecycle status is unavailable");
    for (const connection of value.connections) {
      const stream = connection.notificationStream;
      if (stream != null && (!["STARTING", "ACTIVE", "RECOVERING", "UNSUPPORTED", "FAILED", "CLOSED"].includes(stream.state) ||
          !Number.isSafeInteger(stream.recoveryAttempts) || stream.recoveryAttempts < 0 || stream.recoveryAttempts > 8 ||
          (stream.reason !== undefined && !["STREAM_GAP", "STREAM_UNAUTHORIZED", "SESSION_EXPIRED", "STREAM_PROTOCOL", "STREAM_BUDGET", "RECOVERY_EXHAUSTED"].includes(stream.reason)))) throw new Error("Supported MCP notification status is unavailable");
    }
    return value;
  },
  async command(action, id, body) {
    if (!["connect", "disconnect", "test"].includes(action) || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Unsupported MCP lifecycle command");
    return unwrap(await apiClient.post(`/settings/mcp-connections/${encodeURIComponent(id)}/${action}`, body));
  },
};
