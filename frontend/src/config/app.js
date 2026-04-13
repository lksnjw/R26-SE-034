export const appConfig = {
  name: import.meta.env.VITE_APP_NAME ?? "Agentic Workflow Engine",
  version: "0.1.0",
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080/api",
  wsBaseUrl: import.meta.env.VITE_WS_BASE_URL ?? "ws://localhost:8080/ws",
  analyticsEnabled: import.meta.env.VITE_ANALYTICS_ENABLED === "true",
};
