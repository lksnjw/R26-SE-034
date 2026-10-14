import type { AppConfig } from "../config/config.js";
import type { RepositoryState } from "../repository/store.js";
import { configuredModels, providerConfigurationFromRecord, validateRuntimeProviderConfiguration } from "./runtime.js";
import { staticProviderConfiguration } from "./static-configuration.js";

/** A safe configuration projection, not a runtime binding or a connection test.
 * The caller must resolve current permissions from this same committed image.
 * Never mint an activation epoch here: only ProviderRuntime owns that authority. */
export function configuredModelCatalog(state: Readonly<RepositoryState>, config: AppConfig) {
  const active = Object.values(state.providers).filter(provider => provider.active === true);
  if (active.length > 1) throw new Error("Multiple active provider records require configuration repair");
  const configuration = active[0] ? providerConfigurationFromRecord(active[0], config.generationTimeoutMs ?? 30_000)
    : staticProviderConfiguration(config);
  if (configuration === null) return { configured: false, binding: null, models: [] };
  validateRuntimeProviderConfiguration(configuration);
  return { configured: true, binding: { providerId: configuration.id, providerName: configuration.name,
    model: configuration.model, configurationRevision: null }, models: configuredModels(configuration) };
}
