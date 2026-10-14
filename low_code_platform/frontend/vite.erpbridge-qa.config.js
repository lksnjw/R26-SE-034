import { defineConfig } from "vite";
import applicationConfig from "./vite.config.js";

// Separate LOCAL Docker QA frontend. No owner env, ERP token or direct MCP proxy.
export default defineConfig(configEnvironment => {
  const base = typeof applicationConfig === "function" ? applicationConfig(configEnvironment) : applicationConfig;
  return { ...base, envDir: false, envPrefix: "LCWE_DOCKER_QA_", server: { ...base.server,
    host: "127.0.0.1", port: 5174, strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8082", changeOrigin: true }, "/ws": { target: "ws://127.0.0.1:8082", ws: true, changeOrigin: true } },
  } };
});
