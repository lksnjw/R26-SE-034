import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { QueryLoopResult } from "../agent/query-loop.js";

export type DeliveryIntent = { channel: "email" | "unspecified"; recurring: boolean; reportRequested: boolean; requestedAddresses: string[] };

/** Parse operation intent, not recipient identity/permission or consent. Names,
 * addresses in retrieved records, and cadence never become dispatch authority. */
export function deliveryIntent(message: string): DeliveryIntent | null {
  const text = message.trim().toLowerCase();
  if (/^(?:how\b|what\b|why\b|when\b|explain\b)/.test(text) || /\b(?:do not|don't|never|without)\s+(?:send|email|mail)\b/.test(text)) return null;
  const addresses = [...new Set(message.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi) ?? [])];
  const email = /\b(?:e-?mail|mail)\b/.test(text);
  const explicit = /\b(?:send|deliver|forward)\b/.test(text) && (email || addresses.length > 0 || /\b(?:report|details|invoices?|orders?)\b[\s\S]*\bto\b/.test(text));
  const emailVerb = /^(?:(?:please|then|and)\s+)*(?:email|e-mail|mail)\s+(?:my|the|this|these|it|them|a|an|our|[\w.+-]+@)/.test(text) || /\b(?:and|then)\s+(?:email|e-mail|mail)\b/.test(text);
  if (!explicit && !emailVerb) return null;
  return { channel: email || addresses.length ? "email" : "unspecified", recurring: /\b(?:every|each)\s+(?:day|morning|evening|week|month|hour)|\b(?:daily|weekly|monthly)\b/.test(text),
    reportRequested: /\b(?:details|invoices?|orders?|payments?|report|records|sales)\b/.test(text), requestedAddresses: addresses };
}

export type EmailDraft = {
  profile: "email-draft-v1"; id: string; sessionId: string; ownerId: string; version: number; contentHash: string;
  originalRequest: string; channel: "email" | "unspecified"; recurring: boolean; requestedAddresses: string[];
  to: string; subject: string; body: string; state: "DRAFT_NOT_SENT"; reportStatus: "NOT_PREPARED" | "PARTIAL" | "PREPARED_FOR_REVIEW" | "USER_EDITED";
  sourceEvidence: Array<{ toolName: string; outputDigest: string; index: number }>; requirements: string[];
  createdAt: string; updatedAt: string;
};

export const emailDraftCommandSchema = z.object({
  draftId: z.string().min(1).max(128), baseVersion: z.number().int().min(1), baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  patch: z.object({ to: z.string().max(254).refine((value) => value === "" || z.email().safeParse(value).success, "Enter one valid recipient email"),
    subject: z.string().max(300).refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"), body: z.string().max(32000) }).strict(),
}).strict();

export function emailDraftHash(draft: Pick<EmailDraft, "originalRequest" | "channel" | "recurring" | "requestedAddresses" | "to" | "subject" | "body" | "sourceEvidence">): string {
  return `sha256:${createHash("sha256").update(canonicalJSONBytes({ originalRequest: draft.originalRequest, channel: draft.channel, recurring: draft.recurring,
    requestedAddresses: draft.requestedAddresses, to: draft.to, subject: draft.subject, body: draft.body, sourceEvidence: draft.sourceEvidence })).digest("hex")}`;
}

export function draftRequirements(draft: Pick<EmailDraft, "to" | "subject" | "body" | "recurring" | "channel">): string[] {
  return [
    ...(draft.channel === "unspecified" ? ["Confirm the delivery channel; email has not been assumed."] : []),
    ...(draft.to ? [] : ["Resolve and confirm the recipient's exact address; do not guess a person's email."]),
    ...(draft.subject.trim() ? [] : ["Provide a subject."]), ...(draft.body.trim() ? [] : ["Provide the message or retrieve the requested report before review."]),
    "A currently reviewed ERPBridge email connector and fresh independent approval are required; this draft itself cannot send.",
    "Recipient data-sharing permission must be explicitly confirmed for this exact message before approval is requested.",
    ...(draft.recurring ? ["Confirm recurrence, reporting period, delivery time and timezone. No schedule has been activated."] : []),
  ];
}

export function createEmailDraft(id: string, sessionId: string, ownerId: string, originalRequest: string, intent: DeliveryIntent, report?: QueryLoopResult): EmailDraft {
  const now = new Date().toISOString();
  const successes = report?.toolSteps.filter((step) => step.status === "SUCCEEDED") ?? [];
  const complete = Boolean(report && successes.length && !report.boundHit && successes.length === report.toolSteps.length && !report.narrativeRejected && report.text.trim() && report.text.length <= 32000);
  const draft: EmailDraft = { profile: "email-draft-v1", id, sessionId, ownerId, version: 1, contentHash: "", originalRequest,
    channel: intent.channel, recurring: intent.recurring, requestedAddresses: intent.requestedAddresses,
    to: intent.requestedAddresses.length === 1 && z.email().safeParse(intent.requestedAddresses[0]).success ? intent.requestedAddresses[0]! : "",
    subject: intent.reportRequested ? "ERP report — draft for review" : "", body: complete ? report!.text : "",
    state: "DRAFT_NOT_SENT", reportStatus: complete ? "PREPARED_FOR_REVIEW" : successes.length ? "PARTIAL" : "NOT_PREPARED",
    sourceEvidence: (report?.toolSteps ?? []).flatMap((step, index) => step.status === "SUCCEEDED" ? [{ toolName: step.toolName, index, outputDigest: `sha256:${createHash("sha256").update(canonicalJSONBytes(step.result)).digest("hex")}` }] : []),
    requirements: [], createdAt: now, updatedAt: now };
  draft.requirements = draftRequirements(draft); draft.contentHash = emailDraftHash(draft); return draft;
}

export function emailDraftMessage(draft: EmailDraft): string {
  return `Email draft saved. Nothing has been sent.${draft.recurring ? " No schedule is active." : ""}\n\n${draft.reportStatus === "PREPARED_FOR_REVIEW" ? "A report draft was prepared from confirmed reads. Review its facts, scope and recipient before any delivery." : draft.reportStatus === "PARTIAL" ? "Some reads completed, but the report is incomplete. No complete email body was generated." : draft.reportStatus === "USER_EDITED" ? "Your edits are saved as a draft, not an approval or delivery." : "No report data or email body has been prepared yet."}`;
}
