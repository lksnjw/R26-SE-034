import { apiClient } from "../config/axios";

function persistSession(session) {
  if (session?.accessToken) {
    localStorage.setItem("workflow.authToken", session.accessToken);
  }
  if (session?.user) {
    localStorage.setItem("workflow.user", JSON.stringify(session.user));
  }
  return session;
}

export const authService = {
  async login(credentials) {
    const response = await apiClient.post("/auth/login", credentials);
    return persistSession(response.data.data);
  },

  async register(payload) {
    const response = await apiClient.post("/auth/register", payload);
    return persistSession(response.data.data);
  },

  async me() {
    const response = await apiClient.get("/auth/me");
    return response.data.data;
  },

  async logout() {
    localStorage.removeItem("workflow.authToken");
    localStorage.removeItem("workflow.user");
    await apiClient.post("/auth/logout").catch(() => null);
  },
};
