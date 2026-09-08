import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import { runtimeApprovalInboxAuthority, runtimeApprovalView } from "./runtime-approvals.js";
import { hasOperationReconciliation, operationReconciliationView } from "./operation-reconciliation.js";

const kindSchema = z.enum(["approval", "reconciliation"]);
const querySchema = z.object({ kind: kindSchema.or(z.literal("all")).default("all"), state: z.enum(["open", "closed"]).default("open"),
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default("25").transform(Number), cursor: z.string().min(1).max(2048).optional() }).strict();
const keySchema = z.object({ executionId: z.string().min(1).max(256), reviewId: z.string().min(1).max(256), kind: kindSchema, requestedAt: z.string().datetime() }).strict();
const cursorSchema = z.object({ profile: z.literal("execution-review-cursor/v1"), scope: z.string().regex(/^sha256:[a-f0-9]{64}$/), after: keySchema }).strict();
type Key = z.infer<typeof keySchema>;
type Candidate = Key & { state: "open" | "closed" };
const compare = (a: Key, b: Key) => a.requestedAt !== b.requestedAt ? (a.requestedAt > b.requestedAt ? -1 : 1)
  : a.executionId !== b.executionId ? (a.executionId > b.executionId ? -1 : 1) : a.kind !== b.kind ? a.kind.localeCompare(b.kind)
    : a.reviewId === b.reviewId ? 0 : a.reviewId > b.reviewId ? -1 : 1;
const text = (value: unknown, fallback: string, max = 200) => typeof value === "string" && value.trim() ? value.slice(0, max) : fallback;
const date = (value: unknown, fallback: string) => z.string().datetime().safeParse(value).success ? value as string : fallback;
function deny(message: string, status = 400): never { throw new HandlerFailure(status, message, { code: "EXECUTION_REVIEW_INBOX_DENIED" }); }
function mac(payload: string, secret: string) { return createHmac("sha256", secret).update(`execution-review-cursor/v1:${payload}`).digest("base64url"); }
function decode(raw: string, scope: string, secret: string): Key {
  const parts = raw.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) deny("Invalid review inbox cursor; reload the first page");
  if (!timingSafeEqual(Buffer.from(parts[1]!), Buffer.from(mac(parts[0]!, secret)))) deny("Invalid review inbox cursor; reload the first page");
  try {
    if (Buffer.from(parts[0]!, "base64url").toString("base64url") !== parts[0]) deny("Noncanonical review inbox cursor");
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.scope !== scope) deny("Review authority or filters changed; reload the first page");
    return parsed.data.after;
  } catch { deny("Review authority or cursor changed; reload the first page"); }
}

/** A read-only task index, not a decision, result, retry or dispatch authority.
 * Exact business arguments are only loaded by the existing minimum review API.
 * Proof checks are limited to the requested page; every page rechecks authority.
 * Keyset pagination reflects current state, not a frozen inbox snapshot. */
export function executionReviewInbox(state: Readonly<RepositoryState>, user: CurrentUser, rawQuery: unknown, secret: string) {
  const parsed = querySchema.safeParse(rawQuery); if (!parsed.success) deny("Unsupported review inbox query");
  const query = parsed.data, actor = state.users[user.id], role = actor && state.roles[actor.roleId];
  const permissions = actor ? [...(role?.permissions ?? []), ...actor.permissionOverrides] : [];
  if (!actor || actor.status.toLowerCase() !== "active" || !role || role.name !== user.role ||
      !permissions.some(key => ["execution:approve", "execution:reconcile"].includes(key))) deny("Current review authority is required", 403);
  const scopes = { approval: runtimeApprovalInboxAuthority(state, user.id), reconciliation: permissions.includes("execution:reconcile") };
  const scope = resolvedParameterHashBytes(canonicalJSONBytes({ actorId: user.id, roleId: role.id, permissions: [...new Set(permissions)].sort(),
    policy: (state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy ?? null, kind: query.kind, state: query.state }));
  const after = query.cursor ? decode(query.cursor, scope, secret) : null;
  const candidates: Candidate[] = [];
  for (const execution of Object.values(state.executions)) {
    // Separation of duties also applies to task discovery; a stronger role
    // cannot discover its own operation as an independently actionable task.
    if (execution.startedBy.id === user.id) continue;
    const fallback = date(execution.startedAt, new Date(0).toISOString());
    if (scopes.approval && query.kind !== "reconciliation" && execution.runtimeApprovalSecret) {
      const ledger = execution.runtimeApprovalSecret, entries = Object.entries(ledger.records ?? {});
      if (entries.length > 1000 || entries.length === 0) deny("The review index contains an unsupported approval journal; exact records need repair", 409);
      for (const [reviewId, record] of entries) {
        if (!keySchema.shape.reviewId.safeParse(reviewId).success) deny("The review index contains an invalid record identity", 409);
        candidates.push({ executionId: execution.id, reviewId, kind: "approval", requestedAt: date(record?.requestedAt, fallback),
          state: reviewId === ledger.activeId && record?.state === "PENDING" && execution.status === "AWAITING_APPROVAL" && execution.completedAt === null ? "open" : "closed" });
      }
    }
    if (scopes.reconciliation && query.kind !== "approval" && ["RECONCILIATION_REQUIRED", "RECONCILED"].includes(execution.status) && hasOperationReconciliation(execution)) {
      const intent = Object.values(execution.operationSecret!.intents).find(item => item.state === "UNKNOWN" && item.approvalId);
      candidates.push({ executionId: execution.id, reviewId: intent!.id, kind: "reconciliation", requestedAt: date(intent?.preparedAt, fallback),
        state: execution.status === "RECONCILED" ? "closed" : "open" });
    }
  }
  const matching = candidates.filter(item => item.state === query.state && (!after || compare(item, after) > 0)).sort(compare);
  const page = matching.slice(0, query.limit), hasMore = matching.length > page.length;
  const items = page.map(candidate => {
    const execution = state.executions[candidate.executionId]!;
    const common = { ...candidate, workflowName: text(execution.workflowName, "Workflow"), requesterName: text(execution.startedBy.name, "Requester"),
      executionStatus: execution.status, canResume: false as const, noReplay: true as const };
    try {
      if (candidate.kind === "approval") {
        const review = runtimeApprovalView(state as RepositoryState, execution.id, user.id, candidate.reviewId).runtimeApproval;
        return { ...common, nodeId: review.nodeId, toolName: text(review.toolName, "Exact tool review"), expiresAt: review.expiresAt,
          statusLabel: review.state === "PENDING" ? review.canDecide ? "Awaiting decision" : "Approval unavailable"
            : review.state === "REJECTED" ? "Rejected" : "Approved — not delivery confirmation",
          reviewAvailable: true, actionable: review.canDecide, detail: review.unavailable ? "Exact authorization or evidence changed. Open the current case before any decision." : (review.state === "PENDING"
            ? "Open the exact action and arguments before deciding." : "Approval is a decision, not proof that the tool succeeded or the recipient received it.") };
      }
      const review = operationReconciliationView(state, execution.id, user.id).operationReconciliation;
      const queryBacked = review.history.at(-1)?.basis === "queried-operation-state";
      return { ...common, nodeId: review.nodeId, toolName: text(review.toolName, "Uncertain operation"), expiresAt: null,
        statusLabel: review.state === "OPEN" ? "Outcome uncertain" : queryBacked ? "Closed by reviewed ERP status" : "Closed by operator evidence", reviewAvailable: true, actionable: review.canRecord,
        detail: review.state === "OPEN" ? "Check external evidence. Do not resend an uncertain action." : queryBacked ?
          "A reviewer accepted a saved ERP-state observation. It is not the original SDK answer or delivery proof." : "Operator attestation is not a tool-confirmed result or delivery proof." };
    } catch (error) {
      if (!(error instanceof HandlerFailure)) throw error;
      return { ...common, nodeId: null, toolName: "Exact evidence unavailable", expiresAt: null, statusLabel: "Review unavailable", reviewAvailable: false,
        actionable: false, detail: "The saved evidence or current authorization needs attention. Reload the exact case; this row cannot authorize an action." };
    }
  });
  const last = page.at(-1);
  const payload = hasMore && last ? Buffer.from(JSON.stringify({ profile: "execution-review-cursor/v1", scope,
    after: keySchema.parse({ executionId: last.executionId, reviewId: last.reviewId, kind: last.kind, requestedAt: last.requestedAt }) })).toString("base64url") : null;
  return { profile: "execution-review-inbox/v1" as const, kind: query.kind, state: query.state, scopes, items,
    nextCursor: payload ? `${payload}.${mac(payload, secret)}` : null, hasMore, asOf: new Date().toISOString(), canResume: false, noReplay: true };
}
