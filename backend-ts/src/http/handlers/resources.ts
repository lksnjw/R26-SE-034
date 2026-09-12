import type { FastifyReply, FastifyRequest } from "fastify";
import { fail } from "../../models/schemas.js";
import type { RouteDefinition } from "../generated-routes.js";
import {
  HandlerFailure,
  type CurrentUser,
  type HandlerServices,
} from "./common.js";
import { CHAT_OPERATION_UNHANDLED, handleChatOperationRoute } from "./chat-operations.js";
import { CHAT_UNHANDLED, handleChatRoute } from "./chat.js";
import { COMPANY_UNHANDLED, handleCompanyRoute } from "./company.js";
import { handleProviderRoute, PROVIDER_UNHANDLED } from "./providers.js";
import {
  handleSettingsIntegrationRoute,
  SETTINGS_INTEGRATION_UNHANDLED,
} from "./settings-integrations.js";

export const RESOURCE_UNHANDLED = Symbol("resource-unhandled");

/**
 * Composes resource-oriented HTTP handlers while each business responsibility
 * remains implemented in its dedicated module.
 */
export async function handleResourceRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof RESOURCE_UNHANDLED> {
  try {
    const operationResponse = await handleChatOperationRoute(route, request, reply, user, services);
    if (operationResponse !== CHAT_OPERATION_UNHANDLED) return operationResponse;

    const chatResponse = await handleChatRoute(route, request, reply, user, services);
    if (chatResponse !== CHAT_UNHANDLED) return chatResponse;

    const companyResponse = await handleCompanyRoute(route, request, reply, user, services);
    if (companyResponse !== COMPANY_UNHANDLED) return companyResponse;

    const providerResponse = await handleProviderRoute(route, request, reply, user, services);
    if (providerResponse !== PROVIDER_UNHANDLED) return providerResponse;

    const settingsResponse = await handleSettingsIntegrationRoute(route, request, reply, user, services);
    if (settingsResponse !== SETTINGS_INTEGRATION_UNHANDLED) return settingsResponse;
  } catch (error) {
    if (error instanceof HandlerFailure) {
      return reply.status(error.status).send(fail(error.message, error.meta));
    }
    throw error;
  }
  return RESOURCE_UNHANDLED;
}
