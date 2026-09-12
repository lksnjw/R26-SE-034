import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import { modelDataClasses, normalizeModelEgressPolicy, providerOrigin, type ModelDataClass } from "../../providers/egress-policy.js";
import { providerConfigurationFromRecord, validateRuntimeProviderConfiguration } from "../../providers/runtime.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, numberValue, requestParam, stringValue } from "./common.js";
import { assertActorAuthority } from "./model-selection.js";

export const PROVIDER_UNHANDLED = Symbol("provider-unhandled");

/** Owns model-provider administration and runtime activation routes. */
export async function handleProviderRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof PROVIDER_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/providers` && route.method === "GET") return listProviders(reply, user, services);
  if (route.path === `${base}/providers` && route.method === "POST") return createProvider(request, reply, user, services);
  if (route.path === `${base}/providers/:id` && route.method === "PUT") return updateProvider(request, reply, user, services);
  if (route.path === `${base}/providers/:id/activate`) return activateProvider(request, reply, user, services);
  if (route.path === `${base}/providers/:id/test`) return testProvider(request, reply, user, services);
  return PROVIDER_UNHANDLED;
}

function requirePlatformAdmin(user: CurrentUser): void { if (user.role !== "Platform Admin") throw new HandlerFailure(403, "Only Platform Admin can manage providers"); }
async function listProviders(reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const providers = await services.repository.read((state) => Object.values(state.providers).map((item) => withoutSecretFields(item))); return reply.send(ok(providers, "Provider configurations loaded", null)); }
function providerInput(body: Record<string, unknown>, id: string, user: CurrentUser, existing?: Record<string, unknown>): Record<string, unknown> {
  const name = stringValue(body.name).trim(), model = stringValue(body.model).trim();
  if (name === "" || model === "") throw new HandlerFailure(422, "Provider name and model are required");
  const baseUrl = stringValue(body.baseUrl).trim() || stringValue(existing?.baseUrl).trim();
  if (baseUrl === "") throw new HandlerFailure(422, "Provider base URL is required");
  let origin: string; try { origin = providerOrigin(baseUrl); } catch (error) { throw new HandlerFailure(422, errorText(error)); }
  const type = stringValue(body.type).trim();
  if (type !== "openai_compatible") throw new HandlerFailure(422, "Only OpenAI-compatible providers are implemented; native Gemini/Ollama adapters are unavailable");
  if ((Object.hasOwn(body, "additionalModels") && (!Array.isArray(body.additionalModels) || body.additionalModels.some((value) => typeof value !== "string" || !value.trim()))) ||
      (Object.hasOwn(body, "fallbackModel") && typeof body.fallbackModel !== "string")) throw new HandlerFailure(422, "Model choices must be strings");
  const rawAdditional = Array.isArray(body.additionalModels) ? body.additionalModels : (Array.isArray(existing?.additionalModels) ? existing!.additionalModels : []);
  const additionalModels = (rawAdditional as unknown[]).filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim());
  const fallbackModel = Object.hasOwn(body, "fallbackModel") ? stringValue(body.fallbackModel).trim() : stringValue(existing?.fallbackModel);
  if (additionalModels.length > 64 || [...additionalModels, model, fallbackModel].some((value) => value.length > 256 || value.includes(":latest"))) throw new HandlerFailure(422, "Model IDs must be bounded and pinned");
  let egressPolicy;
  if (body.egressPolicy === undefined) {
    try { egressPolicy = normalizeModelEgressPolicy(existing?.egressPolicy, baseUrl); } catch { egressPolicy = normalizeModelEgressPolicy(undefined, baseUrl); }
  } else {
    if (!isRecord(body.egressPolicy)) throw new HandlerFailure(422, "Model egress policy must be an object");
    const classes = body.egressPolicy.runtimeAnalysisDataClasses, runtimeAgentClasses = body.egressPolicy.runtimeAgentDataClasses ?? [], interactiveClasses = body.egressPolicy.interactiveDataClasses ?? [];
    if (!validClasses(classes)) throw new HandlerFailure(422, "Runtime analysis data classes are invalid");
    if (!validClasses(interactiveClasses)) throw new HandlerFailure(422, "Interactive model data classes are invalid");
    if (!validClasses(runtimeAgentClasses)) throw new HandlerFailure(422, "Runtime agent data classes are invalid");
    if (stringValue(body.egressPolicy.approvedOrigin) !== origin) throw new HandlerFailure(422, "The reviewed model egress origin must exactly match the provider base URL origin");
    if (classes.length + runtimeAgentClasses.length + interactiveClasses.length > 0 && body.egressPolicy.confirmed !== true) throw new HandlerFailure(422, "Explicit administrator confirmation is required before the model can receive application or ERP data");
    const reviewed = classes.length + runtimeAgentClasses.length + interactiveClasses.length > 0;
    egressPolicy = { profile: "model-egress-policy/v1", approvedOrigin: origin, runtimeAnalysisDataClasses: classes as ModelDataClass[], runtimeAgentDataClasses: runtimeAgentClasses as ModelDataClass[], interactiveDataClasses: interactiveClasses as ModelDataClass[], reviewedAt: reviewed ? now() : null, reviewedBy: reviewed ? { id: user.id, name: user.name } : null };
  }
  return { id, name, type, baseUrl, model, fallbackModel, ...(additionalModels.length > 0 ? { additionalModels } : {}), temperature: typeof body.temperature === "number" ? body.temperature : 0, apiKey: typeof body.apiKey === "string" && body.apiKey !== "" ? body.apiKey : existing?.apiKey ?? "", active: existing?.active === true, egressPolicy, revision: numberValue(existing?.revision, 0) + 1, createdAt: stringValue(existing?.createdAt) === "" ? now() : existing!.createdAt };
}
function validClasses(value: unknown): value is ModelDataClass[] { return Array.isArray(value) && value.length <= modelDataClasses.length && value.every((item) => typeof item === "string" && modelDataClasses.includes(item as ModelDataClass)) && new Set(value).size === value.length; }
async function createProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const provider = await services.repository.mutate((state) => { if (Object.values(state.providers).some((item) => stringValue(item.name).toLowerCase() === stringValue(body.name).trim().toLowerCase())) throw new HandlerFailure(409, "A provider with this name already exists"); const id = nextID(state, "provider"), value = providerInput(body, id, user); state.providers[id] = value; appendAudit(state, user, "provider.created", "provider", id, null, withoutSecretFields(value) as Record<string, unknown>, request); return value; }); return reply.status(201).send(ok(withoutSecretFields(provider), "Provider created", null)); }
async function updateProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requirePlatformAdmin(user); const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const id = requestParam(request, "id");
  const provider = await services.repository.mutate((state) => { assertActorAuthority(state, user); const existing = state.providers[id]; if (existing === undefined) throw new HandlerFailure(404, "Provider configuration not found"); const value = providerInput(body, id, user, existing); if (value.active === true) { try { validateRuntimeProviderConfiguration(providerConfigurationFromRecord(value, services.config.generationTimeoutMs ?? 30_000)); } catch (error) { throw new HandlerFailure(422, errorText(error)); } } state.providers[id] = value; appendAudit(state, user, "provider.updated", "provider", id, withoutSecretFields(existing) as Record<string, unknown>, withoutSecretFields(value) as Record<string, unknown>, request); return value; });
  if (provider.active === true) services.providerRuntime?.activate(providerConfigurationFromRecord(provider, services.config.generationTimeoutMs ?? 30_000));
  return reply.send(ok(withoutSecretFields(provider), "Provider updated", null));
}
async function activateProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requirePlatformAdmin(user); const id = requestParam(request, "id"); if (!(await services.repository.read((state) => state.providers[id]))) throw new HandlerFailure(404, "Provider configuration not found"); if (services.providerRuntime === undefined) throw new HandlerFailure(503, "Provider runtime is unavailable");
  const provider = await services.repository.mutate((state) => { assertActorAuthority(state, user); const item = state.providers[id]; if (item === undefined) throw new HandlerFailure(404, "Provider configuration not found"); try { validateRuntimeProviderConfiguration(providerConfigurationFromRecord(item, services.config.generationTimeoutMs ?? 30_000)); } catch (error) { throw new HandlerFailure(422, errorText(error)); } for (const value of Object.values(state.providers)) value.active = false; item.active = true; appendAudit(state, user, "provider.activated", "provider", id, null, { active: true }, request); return structuredClone(item); });
  services.providerRuntime.activate(providerConfigurationFromRecord(provider, services.config.generationTimeoutMs ?? 30_000)); return reply.send(ok(withoutSecretFields(provider), "Provider activated", null));
}
async function testProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const provider = await services.repository.read((state) => state.providers[requestParam(request, "id")] ?? null); if (provider === null) throw new HandlerFailure(404, "Provider configuration not found"); if (services.providerRuntime === undefined) throw new HandlerFailure(503, "Provider runtime is unavailable"); try { const response = await services.providerRuntime.test(providerConfigurationFromRecord(provider, services.config.generationTimeoutMs ?? 30_000), request.signal); return reply.send(ok({ ok: true, providerId: provider.id, provider: response.provider, model: response.model, measured: response.measured, inputTokens: response.inputTokens, outputTokens: response.outputTokens }, "Provider test completed", null)); } catch (error) { return reply.send(ok({ ok: false, providerId: provider.id, message: errorText(error) }, "Provider test completed", null)); } }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
