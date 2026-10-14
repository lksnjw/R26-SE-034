import { defineConfig } from "vite";
import presentationConfig from "./vite.presentation.config.js";

// Local acceptance only: the actual frontend talks to the native Functions
// emulator, not a resident API or a fixture HTTP replacement. No owner env
// files, external origins, credential values or WebSocket fallback are loaded.
export const functionsQaPrefix = "/demo-lcwe-records/asia-south1/api";
export default defineConfig(environment => {
  const base = presentationConfig(environment);
  return { ...base, server: { ...base.server, port: 5192, proxy: {
    "/api": { target: "http://127.0.0.1:23675", changeOrigin: true, rewrite: path => `${functionsQaPrefix}${path}` },
  } } };
});
