import { stringify } from "yaml";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { deliveryIntent } from "./email-draft.js";

export type RecurringRequestedResource = "invoices" | "orders";

export type RecurringDeliveryRequest = {
  profile: "recurring-delivery-request/v1";
  cadence: "daily" | "weekly" | "monthly" | "custom";
  channel: "email" | "unspecified";
  requestedAddresses: string[];
  reportRequested: boolean;
  requestedResources: RecurringRequestedResource[];
  analysisRequested: boolean;
  scheduleActive: false;
  requirements: string[];
};

export type RecurringAutomationComposition = {
  profile: "recurring-automation-composition/v1";
  status: "CAPABILITIES_MAPPED" | "PARTIAL";
  mappedSteps: Array<{ stepId: string; capability: "report" | "delivery"; tool: string; resource?: RecurringRequestedResource }>;
  relatedRecords: { status: "MATCHED" | "NOT_REQUESTED" | "UNRESOLVED"; relationName?: string };
  reportWindowBound: boolean;
  recipientBound: boolean;
  deliveryBodyBound: boolean;
  readyForPublication: false;
  scheduleActive: false;
  remainingRequirements: string[];
};

const REPORT_REQUIREMENT = "Add exact reviewed ERP report reads and bind every report to the declared server-owned report window.";
const MESSAGE_CONTENT_REQUIREMENT = "Define the exact message content from reviewed inputs.";
const RELATED_REQUIREMENT = "Bind the related-order report directly to the complete invoice report's reviewed related-key output.";
const DELIVERY_REQUIREMENT = "Add one exact reviewed email delivery capability with an explicit operation and delivery-input contract.";
const ANALYSIS_REQUIREMENT = "Add a supported bounded analysis node or retain analysis as an unresolved requested outcome.";
const DELIVERY_BODY_REQUIREMENT = "Bind the delivery body to a confirmed report output; do not invent report content.";
const TIME_REQUIREMENT = "Confirm the local delivery time and IANA timezone; no timezone is inferred from this device.";
const DELIVERY_PROOF_REQUIREMENT = "Confirm the connector's delivery-status semantics; operation acceptance is not proof that the recipient received the message.";
const ACTIVATE_REQUIREMENT = "Publish the reviewed manual workflow, then activate recurrence through the authoritative scheduler. Each effect still requires fresh independent approval.";
const CALENDAR_REQUIREMENT = "The authoritative scheduler currently supports daily recurrence only; retain this cadence until its exact calendar is implemented and reviewed.";

function resourceRequirement(resource: RecurringRequestedResource): string {
  return `Add one exact reviewed ERP report capability whose business resource is ${resource} and bind it to the declared server-owned report window.`;
}

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
  const normalized = text.toLowerCase();
  const exactRecipient = intent.requestedAddresses.length === 1 ? intent.requestedAddresses[0] : null;
  const requestedResources: RecurringRequestedResource[] = [
    ...(/\binvoices?\b/.test(normalized) ? ["invoices" as const] : []),
    ...(/\borders?\b/.test(normalized) ? ["orders" as const] : []),
  ];
  const requestedCadence = cadence(text);
  const requirements = [
    ...(intent.reportRequested ? requestedResources.length ? requestedResources.map(resourceRequirement) : [REPORT_REQUIREMENT] : [MESSAGE_CONTENT_REQUIREMENT]),
    DELIVERY_REQUIREMENT,
    ...(exactRecipient ? [`Confirm data-sharing permission for the exact recipient ${exactRecipient}.`] : ["Resolve and confirm exactly one authorized recipient; do not guess a person's address."]),
    TIME_REQUIREMENT,
    DELIVERY_PROOF_REQUIREMENT,
    ...(requestedCadence === "daily" ? [] : [CALENDAR_REQUIREMENT]),
    ACTIVATE_REQUIREMENT,
  ];
  return { profile: "recurring-delivery-request/v1", cadence: requestedCadence, channel: intent.channel,
    requestedAddresses: [...intent.requestedAddresses], reportRequested: intent.reportRequested, requestedResources,
    analysisRequested: /\banaly[sz](?:e|es|ed|ing|is)\b/.test(normalized), scheduleActive: false, requirements };
}

/** Supplies only server-derived request facts and authoring constraints. The
 * provider still proposes the workflow, while the backend validates the exact
 * result before it can be saved. This object is not execution authority. */
export function recurringAutomationCandidateContext(request: RecurringDeliveryRequest): Record<string, unknown> {
  return {
    profile: "recurring-automation-candidate-context/v1",
    automation_request: automationMetadata(request),
    workflow_report_window_inputs: { start: "reportStartAt", end: "reportEndAt" },
    required_unresolved_requirements: request.requirements,
    constraints: [
      "Keep trigger.type manual and schedule_active false.",
      "Use only offered exact capabilities; do not guess a recipient, report field or delivery result.",
      "Use a report capability only for its reviewed report_coverage_contract.business_resource and map every requested resource exactly once.",
      "A report step must bind its reviewed window parameters to input.reportStartAt and input.reportEndAt.",
      "A related report must consume the preceding primary report's exact reviewed key projection.",
      "An email delivery step must use the literal requested address when exactly one address is present and bind its body to confirmed report output.",
    ],
  };
}

/** Returns whether live discovery exposes any exact capability that can
 * materially advance this recurring request. Avoids a model round-trip when
 * only an empty shell can truthfully be produced. */
export function hasRecurringCompositionCapability(request: RecurringDeliveryRequest, tools: readonly ToolDefinition[], userRole: string): boolean {
  return tools.some(tool => grantsRole(tool, userRole) &&
    (request.reportRequested && tool.is_read_only && tool.report_coverage_contract !== undefined &&
      request.requestedResources.includes(tool.report_coverage_contract.business_resource as RecurringRequestedResource) ||
    request.channel === "email" && !tool.is_read_only && tool.operation_contract?.effect_class === "notification" &&
      tool.email_delivery_contract !== undefined && safeNotificationRisk(tool.risk_level)));
}

/** Verifies a recurring candidate against server-derived facts and the exact
 * live contracts used for generation. It never repairs model output. Invalid
 * proposals are rejected so the caller can preserve the safe empty shell. */
export function inspectRecurringAutomationCandidate(rawYAML: string, request: RecurringDeliveryRequest, tools: readonly ToolDefinition[], userRole: string): RecurringAutomationComposition {
  const blueprint = parseWorkflowYAMLStrict(rawYAML);
  const issues: string[] = [];
  if (blueprint.trigger.type !== "manual") issues.push("Recurring workflow drafts must retain a manual trigger");
  const metadata = record(blueprint.metadata?.automation_request);
  const expected = automationMetadata(request);
  for (const [key, value] of Object.entries(expected)) if (!sameJSON(metadata?.[key], value)) issues.push(`Automation request field ${key} changed or is missing`);

  const inputSchema = record(blueprint.trigger.config?.inputSchema), properties = record(inputSchema?.properties);
  const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  const windowInputReady = inputSchema?.type === "object" && record(properties?.reportStartAt)?.type === "string" &&
    record(properties?.reportEndAt)?.type === "string" && required.includes("reportStartAt") && required.includes("reportEndAt") && inputSchema?.additionalProperties === false;
  const byAction = new Map<string, ToolDefinition>();
  for (const tool of tools) for (const name of [tool.name, tool.mcp_tool_name]) if (name.trim()) byAction.set(name, tool);
  const mappedSteps: RecurringAutomationComposition["mappedSteps"] = [];
  const reportSteps: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown>; resource: RecurringRequestedResource }> = [];
  const deliverySteps: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown> }> = [];
  for (const [index, step] of blueprint.steps.entries()) {
    const action = (step.action ?? "").trim(), tool = byAction.get(action);
    if (!tool) { issues.push(`Step ${step.id} does not use one exact live capability`); continue; }
    if (!grantsRole(tool, userRole)) issues.push(`Step ${step.id} is not granted to the current role`);
    const parameters = record(step.parameters) ?? {};
    let recognized = false;
    if (tool.report_coverage_contract && tool.is_read_only) {
      recognized = true;
      const contract = tool.report_coverage_contract;
      const resource = contract.business_resource as RecurringRequestedResource | undefined;
      if (!resource || !request.requestedResources.includes(resource)) {
        issues.push(`Report step ${step.id} has no exact reviewed requested business resource`);
      } else {
        reportSteps.push({ index, id: step.id, tool, parameters, resource });
        mappedSteps.push({ stepId: step.id, capability: "report", tool: tool.name, resource });
      }
      if (!windowInputReady || parameters[contract.start_parameter] !== "{{input.reportStartAt}}" || parameters[contract.end_parameter] !== "{{input.reportEndAt}}")
        issues.push(`Report step ${step.id} is not bound to the server-owned report window inputs`);
    }
    if (!tool.is_read_only && tool.operation_contract?.effect_class === "notification" && tool.email_delivery_contract && safeNotificationRisk(tool.risk_level)) {
      recognized = true;
      deliverySteps.push({ index, id: step.id, tool, parameters });
      mappedSteps.push({ stepId: step.id, capability: "delivery", tool: tool.name });
    }
    if (!recognized) issues.push(`Step ${step.id} is not a reviewed report or email-delivery capability`);
  }

  for (const resource of request.requestedResources) {
    if (reportSteps.filter(report => report.resource === resource).length > 1)
      issues.push(`Requested business resource ${resource} was mapped more than once`);
  }

  const relation = relatedRecordStatus(request, reportSteps);
  const exactRecipient = request.requestedAddresses.length === 1 ? request.requestedAddresses[0]! : null;
  let recipientBound = false, deliveryBodyBound = false;
  for (const delivery of deliverySteps) {
    const contract = delivery.tool.email_delivery_contract!;
    if (exactRecipient === null) {
      if (delivery.parameters[contract.recipient_parameter] !== undefined) issues.push("A delivery recipient was supplied without one exact requested address");
    } else if (delivery.parameters[contract.recipient_parameter] === exactRecipient) recipientBound = true;
    const body = exactReference(delivery.parameters[contract.body_parameter]);
    if (body && reportSteps.some(report => report.index < delivery.index && report.id === body.root && body.path[0] === "structuredContent")) deliveryBodyBound = true;
  }
  if (deliverySteps.length > 1) issues.push("A recurring draft may not silently select multiple delivery effects");
  if (reportSteps.length > 2) issues.push("The supported recurring report profile permits at most two reviewed report steps");
  if (deliverySteps.some(delivery => reportSteps.some(report => report.index > delivery.index))) issues.push("All reviewed report reads must precede the delivery effect");
  if (exactRecipient !== null && deliverySteps.length > 0 && !recipientBound) issues.push("The delivery step did not preserve the exact requested address");
  if (request.reportRequested && deliverySteps.length > 0 && !deliveryBodyBound) issues.push("The delivery body is not bound to confirmed report output");
  if (request.requestedResources.includes("invoices") && request.requestedResources.includes("orders") && relation.status !== "MATCHED" &&
      reportSteps.some(report => report.tool.report_coverage_contract?.requested_key_coverage !== undefined))
    issues.push("Invoice and order reports do not have one exact reviewed relationship binding");

  const remainingRequirements = recurringCompositionRequirements(request, reportSteps, deliverySteps.length, relation.status, recipientBound, deliveryBodyBound, windowInputReady);
  const unresolved = Array.isArray(blueprint.metadata?.unresolved_requirements) ? blueprint.metadata.unresolved_requirements : [];
  for (const requirement of remainingRequirements) if (!unresolved.includes(requirement)) issues.push(`Required unresolved outcome was omitted: ${requirement}`);
  if (issues.length) throw new Error(`Recurring automation candidate failed its server contract: ${[...new Set(issues)].join("; ")}`);
  const everyResourceMapped = request.requestedResources.length > 0 && request.requestedResources.every(resource => reportSteps.some(report => report.resource === resource));
  const fullyMapped = request.cadence === "daily" && request.reportRequested && everyResourceMapped && windowInputReady && relation.status !== "UNRESOLVED" &&
    deliverySteps.length === 1 && exactRecipient !== null && recipientBound && deliveryBodyBound && !request.analysisRequested;
  return { profile: "recurring-automation-composition/v1", status: fullyMapped ? "CAPABILITIES_MAPPED" : "PARTIAL", mappedSteps,
    relatedRecords: relation, reportWindowBound: !request.reportRequested || reportSteps.length > 0 && windowInputReady,
    recipientBound, deliveryBodyBound, readyForPublication: false, scheduleActive: false, remainingRequirements };
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
        requested_addresses: request.requestedAddresses, report_requested: request.reportRequested, requested_resources: request.requestedResources,
        analysis_requested: request.analysisRequested, schedule_active: false },
      unresolved_requirements: request.requirements,
    },
  }).trim();
}

function automationMetadata(request: RecurringDeliveryRequest): Record<string, unknown> {
  return { profile: request.profile, cadence: request.cadence, channel: request.channel, requested_addresses: request.requestedAddresses,
    report_requested: request.reportRequested, requested_resources: request.requestedResources, analysis_requested: request.analysisRequested, schedule_active: false };
}

function recurringCompositionRequirements(request: RecurringDeliveryRequest,
  reports: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown>; resource: RecurringRequestedResource }>, deliveryCount: number,
  relation: RecurringAutomationComposition["relatedRecords"]["status"], recipientBound: boolean, deliveryBodyBound: boolean, windowInputReady: boolean): string[] {
  const exactRecipient = request.requestedAddresses.length === 1 ? request.requestedAddresses[0]! : null;
  return [
    ...(!request.reportRequested ? [MESSAGE_CONTENT_REQUIREMENT] : []),
    ...(request.reportRequested && !windowInputReady ? [REPORT_REQUIREMENT] : []),
    ...request.requestedResources.filter(resource => !reports.some(report => report.resource === resource)).map(resourceRequirement),
    ...(request.requestedResources.includes("invoices") && request.requestedResources.includes("orders") && relation !== "MATCHED" ? [RELATED_REQUIREMENT] : []),
    ...(request.analysisRequested ? [ANALYSIS_REQUIREMENT] : []),
    ...(deliveryCount !== 1 ? [DELIVERY_REQUIREMENT] : []),
    ...(request.reportRequested && deliveryCount === 1 && !deliveryBodyBound ? [DELIVERY_BODY_REQUIREMENT] : []),
    ...(exactRecipient === null ? ["Resolve and confirm exactly one authorized recipient; do not guess a person's address."] :
      recipientBound ? [`Confirm data-sharing permission for the exact recipient ${exactRecipient}.`] : [`Bind the reviewed delivery capability to the exact recipient ${exactRecipient} and confirm data-sharing permission.`]),
    TIME_REQUIREMENT,
    DELIVERY_PROOF_REQUIREMENT,
    ...(request.cadence === "daily" ? [] : [CALENDAR_REQUIREMENT]),
    ACTIVATE_REQUIREMENT,
  ];
}

function relatedRecordStatus(request: RecurringDeliveryRequest,
  reports: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown>; resource: RecurringRequestedResource }>): RecurringAutomationComposition["relatedRecords"] {
  if (!(request.requestedResources.includes("invoices") && request.requestedResources.includes("orders"))) return { status: "NOT_REQUESTED" };
  for (const primary of reports) {
    if (primary.resource !== "invoices") continue;
    const projection = primary.tool.report_coverage_contract?.key_projection;
    if (!projection) continue;
    for (const related of reports) {
      if (related.resource !== "orders") continue;
      const coverage = related.tool.report_coverage_contract?.requested_key_coverage;
      if (!coverage || related.index <= primary.index || coverage.relation_name !== projection.relation_name) continue;
      const expected = `{{${primary.id}.structuredContent.${projection.keys_path.join(".")}}}`;
      if (related.parameters[coverage.keys_parameter] === expected) return { status: "MATCHED", relationName: projection.relation_name };
    }
  }
  return { status: "UNRESOLVED" };
}

function exactReference(value: unknown): { root: string; path: string[] } | null {
  if (typeof value !== "string") return null;
  const match = /^\{\{\s*([A-Za-z][A-Za-z0-9_-]*)((?:\.[A-Za-z0-9_-]+)+)\s*\}\}$/.exec(value);
  return match ? { root: match[1]!, path: match[2]!.slice(1).split(".") } : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sameJSON(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function grantsRole(tool: ToolDefinition, userRole: string): boolean {
  const role = userRole.trim().toLowerCase();
  return role.length > 0 && tool.allowed_roles.some(allowed => allowed.trim().toLowerCase() === role);
}

function safeNotificationRisk(risk: string): boolean {
  return ["low", "medium"].includes(risk.trim().toLowerCase());
}
