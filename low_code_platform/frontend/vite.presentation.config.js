import { defineConfig } from "vite";
import applicationConfig from "./vite.config.js";

// The presentation runtime must not inherit owner .env/.env.local bindings.
// It uses only the same-origin governed API proxy from vite.config.js.
export default defineConfig((configEnvironment) => {
  const base = typeof applicationConfig === "function"
    ? applicationConfig(configEnvironment)
    : applicationConfig;

  return {
    ...base,
    envDir: false,
    envPrefix: "LCWE_PRESENTATION_",
    server: {
      ...base.server,
      host: "127.0.0.1",
      strictPort: true,
    },
  };
});
