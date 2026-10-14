import type { RepositoryState, User } from "../repository/store.js";

export type RecipientResolution = {
  profile: "recipient-directory-resolution/v1";
  requestedLabel: string;
  status: "RESOLVED" | "UNRESOLVED" | "AMBIGUOUS";
  source: "DIRECT_MANAGER" | "EXACT_USER_NAME" | "EXACT_ROLE_SINGLETON" | null;
  userId?: string;
  userName?: string;
  email?: string;
  reason: string;
};

const managerLabels = new Set(["manager", "my manager", "the manager", "line manager", "my line manager", "the line manager"]);
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
const active = (user: User | undefined): user is User => Boolean(user && user.status.toLowerCase() === "active");

/** Extracts only an explicit natural-language recipient after `to`. Literal
 * addresses remain owned by the email parser, and vague pronouns are ignored. */
export function recipientReference(message: string, requestedAddresses: string[]): string | null {
  if (requestedAddresses.length > 0) return null;
  const candidates = [...message.matchAll(/(?:^|\s)to\s+(.+?)(?=(?:\s+(?:every|each)\b|\s+(?:daily|weekly|monthly)\b|\s+with\s+(?:subject|title|message|body)\b|[.!?;]|$))/giu)];
  const raw = candidates.at(-1)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!raw || raw.length > 80 || raw.split(/\s+/).length > 6 || raw.includes("@") || /\b(?:and|or)\b/i.test(raw) ||
      /^(?:him|her|them|it|this|that|these|those|someone|somebody)$/i.test(raw) || !/^[\p{L}\p{M}][\p{L}\p{M}\d .'-]*$/u.test(raw)) return null;
  return raw.replace(/\s+/g, " ");
}

function resolved(requestedLabel: string, source: RecipientResolution["source"], user: User): RecipientResolution {
  return { profile: "recipient-directory-resolution/v1", requestedLabel, status: "RESOLVED", source,
    userId: user.id, userName: user.name, email: user.email,
    reason: source === "DIRECT_MANAGER" ? "Resolved from the requester's assigned active manager." :
      source === "EXACT_USER_NAME" ? "Resolved from one exact active directory name." : "Resolved from one exact active role assignment." };
}

function unresolved(requestedLabel: string, status: "UNRESOLVED" | "AMBIGUOUS", reason: string): RecipientResolution {
  return { profile: "recipient-directory-resolution/v1", requestedLabel, status, source: null, reason };
}

/** Resolves a recipient from current server-owned directory facts only. No
 * fuzzy matching, generated address, or role-based tie-breaking is allowed. */
export function resolveRecipientReference(state: Readonly<RepositoryState>, actorId: string, requestedLabel: string): RecipientResolution {
  const normalized = normalize(requestedLabel);
  if (managerLabels.has(normalized)) {
    const managerID = state.users[actorId]?.managerId;
    if (!managerID) return unresolved(requestedLabel, "UNRESOLVED", "No manager is assigned to the requester in the directory.");
    const manager = state.users[managerID];
    return active(manager) ? resolved(requestedLabel, "DIRECT_MANAGER", manager) :
      unresolved(requestedLabel, "UNRESOLVED", "The assigned manager is not an active directory user.");
  }

  const named = Object.values(state.users).filter((user) => active(user) && normalize(user.name) === normalized);
  if (named.length === 1) return resolved(requestedLabel, "EXACT_USER_NAME", named[0]!);
  if (named.length > 1) return unresolved(requestedLabel, "AMBIGUOUS", "More than one active directory user has this exact name.");

  const roleLabel = normalized.replace(/^(?:my|the)\s+/, "");
  const roles = Object.values(state.roles).filter((role) => normalize(role.name) === roleLabel);
  if (roles.length === 1) {
    const holders = Object.values(state.users).filter((user) => active(user) && user.roleId === roles[0]!.id);
    if (holders.length === 1) return resolved(requestedLabel, "EXACT_ROLE_SINGLETON", holders[0]!);
    if (holders.length > 1) return unresolved(requestedLabel, "AMBIGUOUS", "More than one active directory user has this exact role.");
  }
  return unresolved(requestedLabel, "UNRESOLVED", "No exact active directory user or single-holder role matches this recipient.");
}

/** Re-resolves the original label and requires the same source and identity.
 * This fences manager, name, role, account-status, and email changes between
 * draft creation and approval admission. */
export function recipientResolutionIsCurrent(state: Readonly<RepositoryState>, actorId: string, resolution: RecipientResolution): boolean {
  if (resolution.status !== "RESOLVED") return false;
  const current = resolveRecipientReference(state, actorId, resolution.requestedLabel);
  return current.status === "RESOLVED" && current.source === resolution.source && current.userId === resolution.userId &&
    current.userName === resolution.userName && current.email === resolution.email;
}
