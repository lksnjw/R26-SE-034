import { defineConfig } from "vite";
import dockerQaConfig from "./vite.erpbridge-qa.config.js";

// Empty-catalog Docker acceptance only. Windows reserves the older QA port
// on this host; keep the normal app and older QA configurations unchanged.
export default defineConfig(environment => {
  const base = typeof dockerQaConfig === "function" ? dockerQaConfig(environment) : dockerQaConfig;
  return { ...base, server: { ...base.server, proxy: {
    "/api": { target: "http://127.0.0.1:31882", changeOrigin: true },
    "/ws": { target: "ws://127.0.0.1:31882", ws: true },
  } } };
});
