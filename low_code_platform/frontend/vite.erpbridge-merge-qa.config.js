import { defineConfig } from "vite";
import qaConfig from "./vite.erpbridge-qa.config.js";

// Isolated application-only QA; never owner env, ERP credentials or MCP proxy.
export default defineConfig(environment => {
  const base = qaConfig(environment);
  return { ...base, server: { ...base.server, port: 5180,
    proxy: { "/api": { target: "http://127.0.0.1:8088", changeOrigin: true }, "/ws": { target: "ws://127.0.0.1:8088", ws: true, changeOrigin: true } },
  } };
});
