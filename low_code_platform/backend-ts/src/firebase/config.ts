import { dirname, isAbsolute, relative, resolve } from "node:path";
import { loadConfig, type AppConfig } from "../config/config.js";

/** Secret JSON is read at invocation time, not during Firebase discovery.
 * Exact string environment values only; no ambient key files or bootstrap. */
export function loadFunctionConfig(raw: string, root: string): AppConfig {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 64_000) throw new Error("Invalid Functions runtime configuration");
  const decoded: unknown = JSON.parse(raw);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || Object.getPrototypeOf(decoded) !== Object.prototype)
    throw new Error("Functions runtime configuration must be an environment object");
  const env = decoded as Record<string, unknown>;
  if (Object.values(env).some(value => typeof value !== "string") || ["FIRESTORE_KEY_FILE", "FIRESTORE_KEY_JSON", "PLATFORM_ADMIN_PASSWORD"].some(name => Object.hasOwn(env, name)))
    throw new Error("Functions configuration refuses credential files, inline service credentials and administrator bootstrap passwords");
  const localDocker = env.APP_ENV === "development" && ["native-read/v1", "native-operation/v1", "native-scale/v1"].includes(String(env.LCWE_LOCAL_DOCKER_QA));
  if (!["production", "test"].includes(String(env.APP_ENV)) && !localDocker) throw new Error("Functions requires an explicit production or guarded emulator environment");
  if ((env.APP_ENV === "test" || localDocker) && (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== "demo-lcwe-records" || process.env.GOOGLE_APPLICATION_CREDENTIALS || env.FIRESTORE_PROJECT_ID !== "demo-lcwe-records"))
    throw new Error("Functions test configuration requires the guarded loopback demo emulator");
  if (env.STORAGE_DRIVER !== "firestore-records" || env.API_BASE_PATH !== "/api") throw new Error("Functions requires normalized Firestore and the /api routing contract");
  const config = loadConfig(env as NodeJS.ProcessEnv, root, { administratorBootstrap: "external" });
  const localOperationPolicy = env.LCWE_LOCAL_DOCKER_QA === "native-operation/v1" &&
    config.governanceURL === "http://127.0.0.1:23676/governance";
  // The ordinary development HTTP allowance is usable here only for the exact
  // isolated synthetic Docker bridge. It is not a deployable alternate policy.
  if (localDocker && (!/^test_[a-f0-9]{32}_native$/.test(config.firestoreWorkspaceId ?? "") ||
      config.mcpMode !== "remote" || config.mcpTransport !== "erpbridge-mcp" || config.erpbridgeConnections.length !== 1 ||
      config.erpbridgeConnections[0]?.baseURL !== "http://127.0.0.1:18080" ||
      (!!config.governanceURL && !localOperationPolicy) ||
      [config.generationBaseURL, config.governanceSecondaryURL, config.policyGateURL, config.governanceFallbackLlmApiKey].some(value => !!value)))
    throw new Error("Local Functions Docker qualification requires the exact isolated MockERP fixture scope");
  for (const path of [config.toolRegistryPath, config.ruleRegistryPath]) {
    const scoped = relative(resolve(root, "configs/runtime"), path);
    if (!scoped || scoped.startsWith("..") || isAbsolute(scoped) || dirname(scoped) !== ".") throw new Error("Functions registries must be packaged runtime assets");
  }
  if (config.governanceFallbackPolicyPath !== resolve(root, "policy/governance_fallback.json"))
    throw new Error("Functions governance policy must be the packaged release-managed asset");
  return config;
}
