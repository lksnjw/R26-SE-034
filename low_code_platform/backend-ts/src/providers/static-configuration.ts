import type { AppConfig } from "../config/config.js";
import type { RuntimeProviderConfiguration } from "./runtime.js";

/** The environment fallback is shared by execution and configuration reads.
 * Returning settings does not activate a provider or establish connectivity. */
export function staticProviderConfiguration(config: AppConfig): RuntimeProviderConfiguration | null {
  const baseURL = config.generationBaseURL ?? "";
  if (baseURL === "") return null;
  return { id: "provider_static", name: "Environment provider", type: "openai_compatible", baseURL,
    apiKey: config.generationAPIKey ?? "", model: config.generationModelPrimary ?? "", fallbackModel: config.generationModelFallback ?? "",
    ...(config.generationAdditionalModels?.length ? { additionalModels: [...config.generationAdditionalModels] } : {}),
    temperature: config.generationTemperature ?? 0, timeoutMs: config.generationTimeoutMs ?? 30_000 };
}
