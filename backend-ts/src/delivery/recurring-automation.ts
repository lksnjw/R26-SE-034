import { stringify } from "yaml";
import { deliveryIntent } from "./email-draft.js";

export type RecurringDeliveryRequest = {
  profile: "recurring-delivery-request/v1";
  cadence: "daily" | "weekly" | "monthly" | "custom";
  channel: "email" | "unspecified";
  requestedAddresses: string[];
  reportRequested: boolean;
  scheduleActive: false;
  requirements: string[];
};

function cadence(text: string): RecurringDeliveryRequest["cadence"] {
  const normalized = text.toLowerCase();
  if (/\bdaily\b|\b(?:every|each)\s+(?:day|morning|evening)\b/.test(normalized)) return "daily";
  if (/\bweekly\b|\b(?:every|each)\s+week\b/.test(normalized)) return "weekly";
  if (/\bmonthly\b|\b(?:every|each)\s+month\b/.test(normalized)) return "monthly";
  return "custom";
}

/** A recurrence phrase is workflow-design intent, never authority for an
 * immediate delivery. This contract preserves exactly what the server can
 * derive without inventing a person, timezone, report window or connector. */
export function recurringDeliveryRequest(text: string): RecurringDeliveryRequest | null {
  const intent = deliveryIntent(text);
  if (!intent?.recurring) return null;
  const exactRecipient = intent.requestedAddresses.length === 1 ? intent.requestedAddresses[0] : null;
  const requirements = [
    ...(intent.reportRequested ? ["Add exact reviewed ERP read steps and define a complete bounded report window."] : ["Define the exact message content from reviewed inputs."]),
    "Add one exact reviewed delivery capability whose declared schema supports the required channel and fields.",
    ...(exactRecipient ? [`Confirm data-sharing permission for the exact recipient ${exactRecipient}.`] : ["Resolve and confirm exactly one authorized recipient; do not guess a person's address."]),
    "Confirm the delivery time and IANA timezone; no timezone is inferred from this device.",
    "Publish the reviewed manual workflow, then activate recurrence through the authoritative scheduler. Each effect still requires fresh independent approval.",
  ];
  return { profile: "recurring-delivery-request/v1", cadence: cadence(text), channel: intent.channel,
    requestedAddresses: [...intent.requestedAddresses], reportRequested: intent.reportRequested, scheduleActive: false, requirements };
}

/** Builds an intentionally incomplete, non-executable shell when workflow
 * synthesis is unavailable. It gives the canvas a durable source artifact
 * while preserving every unresolved outcome instead of degrading to a
 * one-off email draft or fabricating tool names. */
export function recurringAutomationShell(text: string, request: RecurringDeliveryRequest): string {
  const label = request.cadence === "custom" ? "Recurring" : `${request.cadence[0]!.toUpperCase()}${request.cadence.slice(1)}`;
  return stringify({
    name: `${label} delivery automation`,
    description: `Incomplete workflow request preserved from chat: ${text.slice(0, 500)}`,
    trigger: { type: "manual" },
    steps: [],
    metadata: {
      automation_request: { profile: request.profile, cadence: request.cadence, channel: request.channel,
        requested_addresses: request.requestedAddresses, report_requested: request.reportRequested, schedule_active: false },
      unresolved_requirements: request.requirements,
    },
  }).trim();
}
