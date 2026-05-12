import { apiClient } from "../config/axios";

export const chatService = {
  async listSessions() {
    const response = await apiClient.get("/chat/sessions");
    return response.data.data ?? [];
  },

  async createSession(title = "Workflow conversation") {
    const response = await apiClient.post("/chat/sessions", { title });
    return response.data.data;
  },

  async getSession(sessionId) {
    const response = await apiClient.get(`/chat/sessions/${sessionId}`);
    return response.data.data;
  },

  async updateSession(sessionId, title) {
    const response = await apiClient.patch(`/chat/sessions/${sessionId}`, { title });
    return response.data.data;
  },

  async deleteSession(sessionId) {
    const response = await apiClient.delete(`/chat/sessions/${sessionId}`);
    return response.data.data;
  },

  async sendMessage(sessionId, content, options = {}) {
    const response = await apiClient.post(`/chat/sessions/${sessionId}/messages`, {
      content,
      mode: options.mode ?? "generate_workflow",
      model: options.model ?? undefined,
      top_k_tools: options.top_k_tools ?? 10,
      top_k_rules: options.top_k_rules ?? 15,
      top_k_templates: options.top_k_templates ?? 5,
      top_k_examples: options.top_k_examples ?? 5,
      generate_candidates: options.generate_candidates ?? 5,
      dry_run: options.dry_run ?? true,
      workflowId: options.workflowId,
    });
    return response.data.data;
  },
};
