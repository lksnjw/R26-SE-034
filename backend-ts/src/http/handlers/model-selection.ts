import type { RepositoryState } from "../../repository/store.js";
import type { ProviderRuntime } from "../../providers/runtime.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "./common.js";

export function requestedModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length > 256) throw new HandlerFailure(422, "Invalid requested model", { code: "MODEL_SELECTION_INVALID" });
  return value.trim() || undefined;
}

export function selectProvider(services: HandlerServices, model?: string): ProviderRuntime | undefined {
  if (!services.providerRuntime?.configured) {
    if (model) throw new HandlerFailure(503, "Configure a provider before selecting a model", { code: "PROVIDER_NOT_CONFIGURED" });
    return services.providerRuntime;
  }
  try { return services.providerRuntime.snapshot(model); }
  catch { throw new HandlerFailure(422, "The selected model is no longer configured. Choose a current model.", { code: "MODEL_NOT_CONFIGURED" }); }
}

/** Recheck after external awaits inside the same mutation as delivery. */
export function assertActorAuthority(state: Readonly<RepositoryState>, user: CurrentUser) {
  const actor = state.users[user.id], role = actor && state.roles[actor.roleId];
  const permissions = [...new Set([...(role?.permissions ?? []), ...(actor?.permissionOverrides ?? [])])].sort();
  const original = [...new Set(user.permissions)].sort();
  if (!actor || actor.status.toLowerCase() !== "active" || role?.name !== user.role ||
      JSON.stringify(permissions) !== JSON.stringify(original))
    throw new HandlerFailure(403, "Chat authority changed. Reload before continuing.", { code: "CHAT_AUTHORITY_CHANGED" });
  return permissions;
}

export function assertChatAuthority(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string) {
  const permissions = assertActorAuthority(state, user);
  if (!permissions.some((value) => ["chat:use", "workflow:write"].includes(value))) throw new HandlerFailure(403, "Chat authority is no longer available");
  const chat = state.chats[sessionId];
  if (!chat || (chat.ownerId !== user.id && !permissions.includes("workflow:write"))) throw new HandlerFailure(404, "Chat session not found");
  return chat;
}
