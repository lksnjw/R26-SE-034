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

  async sendMessage(sessionId, content, options = {}) {
    const response = await apiClient.post(`/chat/sessions/${sessionId}/messages`, {
      content,
      mode: "generate_workflow",
      top_k_tools: 10,
      top_k_rules: 15,
      top_k_templates: 5,
      top_k_examples: 5,
      generate_candidates: 5,
      dry_run: true,
      ...options,
    });
    return response.data.data;
  },
};
