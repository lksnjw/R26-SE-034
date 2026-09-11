import { apiClient } from "../config/axios";
import { unwrap } from "./api";

// A missing/older backend is not an admission-ready backend.
export const capabilityService = {
  async catalog(offset = 0, connectionId = "") {
    if (connectionId && !/^[a-z][a-z0-9_-]{0,63}$/.test(connectionId)) throw new Error("Unsupported capability connection");
    const value = unwrap(await apiClient.get("/registry/capabilities", { params: { offset, limit: 10, ...(connectionId ? { connectionId } : {}) } }));
    if (!value || !Array.isArray(value.capabilities) || value.offset !== offset || value.limit !== 10 ||
        typeof value.hasMoreCapabilities !== "boolean" || typeof value.connection?.discoveryAvailable !== "boolean" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(value.connection?.id ?? "") || !Array.isArray(value.connections) || value.connections.length < 1 || value.connections.length > 8 ||
        new Set(value.connections.map(item => item?.id)).size !== value.connections.length || value.connections.filter(item => item?.primary).length !== 1 ||
        !value.connections.some(item => item?.id === value.connection.id) || value.connections.some(item => !/^[a-z][a-z0-9_-]{0,63}$/.test(item?.id ?? "") || typeof item?.dispatchSupported !== "boolean") ||
        !["memory-only", "durable-single-writer", "unsupported-for-admission"].includes(value.persistence)) {
      throw new Error("This backend does not provide the supported capability review view.");
    }
    if (value.capabilities.length > 10 || value.capabilities.some((entry) => !entry || typeof entry.capabilityId !== "string" ||
        typeof entry.reviewEligible !== "boolean" || !["AVAILABLE", "DISABLED", "BLOCKED", "REVIEW_REQUIRED"].includes(entry.effectiveState) ||
        (!entry.observation?.definition && !entry.revision?.definition) || (entry.observation?.connectionId ?? entry.revision?.connectionId) !== value.connection.id)) throw new Error("Invalid capability review entries.");
    return value;
  },
  async discover(connectionId) { return unwrap(await apiClient.post("/registry/capabilities/discovery", {}, { params: { connectionId } })); },
  async review(id, body, connectionId) { return unwrap(await apiClient.post(`/registry/capabilities/${encodeURIComponent(id)}/review`, body, { params: { connectionId } })); },
  async disable(id, body, connectionId) { return unwrap(await apiClient.post(`/registry/capabilities/${encodeURIComponent(id)}/disable`, body, { params: { connectionId } })); },
};
