import type { FastifyReply, FastifyRequest } from "fastify";
import { fail, ok } from "../../models/schemas.js";
import type { RouteDefinition } from "../generated-routes.js";
import { requestParam, type CurrentUser, type HandlerServices } from "./common.js";

export const NOTIFICATION_UNHANDLED = Symbol("notification-unhandled");

/** Owns the notification collection and acknowledgement mutations. */
export async function handleNotificationRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  _user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof NOTIFICATION_UNHANDLED> {
  const base = `${services.config.apiBasePath}/notifications`;
  if (route.path === `${base}/read-all` && route.method === "PATCH") return markAllRead(reply, services);
  if (route.path === `${base}/:id/read` && route.method === "PATCH") return markRead(request, reply, services);
  if (route.path === `${base}/:id` && route.method === "DELETE") return remove(request, reply, services);
  if (route.path === base && route.method === "GET") return list(reply, services);
  return NOTIFICATION_UNHANDLED;
}

async function list(reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const all = await services.repository.read((state) => Object.values(state.notifications).map((item) => structuredClone(item)));
  all.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
  return reply.send(ok(all, "OK", { count: all.length }));
}

async function markRead(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const updated = await services.repository.mutate((state) => {
    const item = state.notifications[requestParam(request, "id")];
    if (item === undefined) return null;
    item.read = true; item.readAt = new Date().toISOString();
    return structuredClone(item);
  });
  if (updated === null) return reply.status(404).send(fail("Notification not found", null));
  return reply.send(ok(updated, "Marked as read", null));
}

async function remove(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const existed = await services.repository.mutate((state) => {
    const id = requestParam(request, "id");
    if (state.notifications[id] === undefined) return false;
    delete state.notifications[id]; return true;
  });
  return reply.send(ok({ deleted: existed }, "Notification deleted", null));
}

async function markAllRead(reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const timestamp = new Date().toISOString();
  const count = await services.repository.mutate((state) => {
    let updated = 0;
    for (const item of Object.values(state.notifications)) if (item.read !== true) {
      item.read = true; item.readAt = timestamp; updated += 1;
    }
    return updated;
  });
  return reply.send(ok({ markedRead: count }, "All notifications marked read", null));
}
