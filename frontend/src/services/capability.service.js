import { apiClient } from "../config/axios";
import { unwrap } from "./api";

// A missing/older backend is not an admission-ready backend.
export const capabilityService = {
  async catalog(offset = 0) {
    const value = unwrap(await apiClient.get("/registry/capabilities", { params: { offset, limit: 10 } }));
    if (!value || !Array.isArray(value.capabilities) || value.offset !== offset || value.limit !== 10 ||
        typeof value.hasMoreCapabilities !== "boolean" || typeof value.connection?.discoveryAvailable !== "boolean" ||
        !["memory-only", "durable-single-writer", "unsupported-for-admission"].includes(value.persistence)) {
      throw new Error("This backend does not provide the supported capability review view.");
    }
    if (value.capabilities.length > 10 || value.capabilities.some((entry) => !entry || typeof entry.capabilityId !== "string" ||
        typeof entry.reviewEligible !== "boolean" || !["AVAILABLE", "DISABLED", "BLOCKED", "REVIEW_REQUIRED"].includes(entry.effectiveState) ||
        (!entry.observation?.definition && !entry.revision?.definition))) throw new Error("Invalid capability review entries.");
    return value;
  },
  async discover() { return unwrap(await apiClient.post("/registry/capabilities/discovery", {})); },
  async review(id, body) { return unwrap(await apiClient.post(`/registry/capabilities/${encodeURIComponent(id)}/review`, body)); },
  async disable(id, body) { return unwrap(await apiClient.post(`/registry/capabilities/${encodeURIComponent(id)}/disable`, body)); },
};
