import type { FastifyReply, FastifyRequest } from "fastify";
import { canReadExecution } from "../execution-scope.js";
import type { RepositoryState } from "../../repository/store.js";
import { publicExecutionEvent } from "../../redact/public-model-usage.js";
import { HandlerFailure, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import { ok } from "../../models/schemas.js";

const MAX_WAIT_MS = 25_000;
const ACTIVE_STATUSES = new Set(["PENDING", "RUNNING", "AWAITING_APPROVAL"]);

export type EventPage = {
  events: unknown[];
  cursor: number;
  lastSequence: number;
  hasMore: boolean;
  status: string;
  profile: string;
};

/** Authenticated, cursor-based execution evidence delivery. A held request only
 * waits for repository commits; it never retries, resumes, or dispatches work. */
export async function handleExecutionEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).some((key) => !["after", "limit", "waitMs"].includes(key))) throw new HandlerFailure(400, "Unsupported event query");
  const after = query.after === undefined ? 0 : progressInteger(query.after, 0, Number.MAX_SAFE_INTEGER);
  const limit = query.limit === undefined ? 100 : progressInteger(query.limit, 1, 100);
  const waitMs = query.waitMs === undefined ? 0 : progressInteger(query.waitMs, 0, MAX_WAIT_MS);
  const executionId = requestParam(request, "id");
  const startedAt = Date.now();
  let page = await authoritativePage(services, user, executionId, after, limit);
  let waited = false;

  if (waitMs > 0 && page.events.length === 0 && !page.hasMore && ACTIVE_STATUSES.has(page.status)) {
    waited = true;
    await waitForRelevantCommit(request, reply, services, user, executionId, page, waitMs);
    // A wake signal carries no response authority. Re-read storage and reapply
    // user/status/event authorization before exposing any evidence.
    page = await authoritativePage(services, user, executionId, after, limit);
  }

  return reply.send(ok({ ...page, waited, waitedMs: waited ? Date.now() - startedAt : 0 }, waited ? "Execution event long poll" : "Execution event replay", null));
}

async function authoritativePage(services: HandlerServices, user: CurrentUser, executionId: string, after: number, limit: number): Promise<EventPage> {
  try {
    return await services.repository.readAuthoritative((state) => projectExecutionEventPage(state, user, executionId, after, limit));
  } catch (error) {
    try { services.repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "Execution progress is unavailable until authoritative storage is recovered. No status or events are confirmed."); }
    throw error;
  }
}

export function projectExecutionEventPage(state: Readonly<RepositoryState>, user: CurrentUser, executionId: string, after: number, limit: number): EventPage {
  const item = readableExecution(state, user, executionId);
  const events = state.executionEvents[item.id] ?? [];
  if (events.some((event, index) => event.sequence !== index + 1 || event.version !== 1 || event.executionId !== item.id || event.workflowId !== item.workflowId || !Number.isFinite(Date.parse(event.timestamp)) || typeof event.type !== "string") ||
      item.readProgress && events.length !== item.readProgress.lastSequence)
    throw new HandlerFailure(409, "Execution event sequence gap; reload from zero", { code: "EXECUTION_EVENT_GAP" });
  const lastSequence = events.at(-1)?.sequence ?? 0;
  if (after > lastSequence) throw new HandlerFailure(400, "Event cursor is ahead of this execution");
  const batch = events.filter((event) => event.sequence > after).slice(0, limit);
  return {
    events: batch.map(publicExecutionEvent),
    cursor: batch.at(-1)?.sequence ?? after,
    lastSequence,
    hasMore: batch.length > 0 && batch.at(-1)!.sequence < lastSequence,
    status: item.status,
    profile: item.readProgress?.profile ?? "legacy-no-journal",
  };
}

export function readableExecution(state: Readonly<RepositoryState>, user: CurrentUser, executionId: string) {
  const item = state.executions[executionId];
  const stored = state.users[user.id];
  const role = stored && state.roles[stored.roleId];
  const permissions = stored ? [...(role?.permissions ?? []), ...stored.permissionOverrides] : [];
  if (!stored || stored.status.toLowerCase() !== "active" || !permissions.some((key) => ["workflow:read", "execution:read_own"].includes(key)) || !item || !canReadExecution({ id: user.id, permissions }, item)) throw new HandlerFailure(404, "Execution not found");
  return item;
}

function pageFingerprint(state: Readonly<RepositoryState>, user: CurrentUser, executionId: string, after: number): string {
  try {
    const item = readableExecution(state, user, executionId);
    const lastSequence = state.executionEvents[item.id]?.at(-1)?.sequence ?? 0;
    if (after > lastSequence) throw new HandlerFailure(400, "Event cursor is ahead of this execution");
    return `${lastSequence}:${item.status}:${item.readProgress?.profile ?? "legacy-no-journal"}`;
  } catch (error) {
    if (error instanceof HandlerFailure) return `failure:${error.status}:${error.message}`;
    return "failure:unknown";
  }
}

async function waitForRelevantCommit(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
  user: CurrentUser,
  executionId: string,
  initial: EventPage,
  waitMs: number,
): Promise<void> {
  const initialFingerprint = `${initial.lastSequence}:${initial.status}:${initial.profile}`;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      request.raw.off("aborted", finish);
      reply.raw.off("close", disconnected);
      resolve();
    };
    const disconnected = (): void => { if (!reply.raw.writableEnded) finish(); };
    const timer = setTimeout(finish, waitMs);
    const unsubscribe = services.repository.observeCommits({
      committed: (state) => { if (pageFingerprint(state, user, executionId, initial.cursor) !== initialFingerprint) finish(); },
      unavailable: finish,
    });
    request.raw.once("aborted", finish);
    reply.raw.once("close", disconnected);
    // Close the subscribe/check race. This read grants no response authority;
    // authoritativePage performs the final security decision after the wait.
    void services.repository.read((state) => pageFingerprint(state, user, executionId, initial.cursor))
      .then((fingerprint) => { if (fingerprint !== initialFingerprint) finish(); }, finish);
  });
}

export function progressInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new HandlerFailure(400, "Invalid event cursor, limit, or wait duration");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new HandlerFailure(400, "Invalid event cursor, limit, or wait duration");
  return parsed;
}
