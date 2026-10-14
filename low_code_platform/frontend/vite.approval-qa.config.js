import { defineConfig } from "vite";
import baseConfig from "./vite.presentation.config.js";

// Isolated synthetic acceptance backend. Never replaces the normal API target.
export default defineConfig(environment => {
  const base = baseConfig(environment);
  return { ...base, server: { ...base.server, host: "127.0.0.1", port: 5194, strictPort: true, proxy: {
    "/api": { target: "http://127.0.0.1:18083", changeOrigin: true },
    "/ws": { target: "ws://127.0.0.1:18083", ws: true },
  } } };
});
