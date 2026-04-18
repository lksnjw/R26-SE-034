export const authService = {
  async login(credentials) {
    return {
      token: "local-dev-token",
      user: {
        name: "Lakshan Jay",
        email: credentials?.email ?? "admin@workflow.local",
        role: "Platform Admin",
      },
    };
  },
  async logout() {
    localStorage.removeItem("workflow.authToken");
  },
};
