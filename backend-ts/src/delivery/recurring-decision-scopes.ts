import type { WorkflowBlueprint } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { inspectWorkflowDraft } from "../workflows/compiled-read.js";
import { controlNodes, parseReadControlFlow } from "../workflows/read-control-flow.js";
import { decisionReturnScopes } from "../workflows/decision-return-scopes.js";

export const RECURRING_DECISION_REQUIREMENT = "Review the original conditional request and confirm its exact declared boolean predicates and Yes/No outcomes; never substitute approval or silently make delivery unconditional.";

/** Request evidence, not a natural-language compiler or permission grant.
 * Preserve the original wording so an unsupported comparison is not lost. */
export function recurringDecisionRequest(text: string) {
  return /\b(?:if|unless)\b|\bonly\s+(?:when|where|while)\b/i.test(text) ?
    { profile: "recurring-decision-request/v1" as const, originalRequest: text } : undefined;
}

/** Pure bounded authoring scopes. Publication and scheduling independently
 * validate capabilities, source classes, exact coverage and approval. */
export function recurringDecisionScopes(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, requested: boolean) {
  const issues: string[] = [], predecessors = new Map<string, ReadonlySet<string>>();
  const raw = blueprint.metadata?.controlFlow;
  if (raw === undefined) {
    const prior = new Set<string>();
    for (const step of blueprint.steps) { predecessors.set(step.id, new Set(prior)); prior.add(step.id); }
    return { predecessors, issues, structured: false };
  }
  issues.push(...inspectWorkflowDraft(blueprint, tools, role).issues);
  try {
    const root = parseReadControlFlow(raw).root;
    const deliveryNames = new Set(tools.filter(tool => !tool.is_read_only && tool.email_delivery_contract).flatMap(tool => [tool.name, tool.mcp_tool_name]));
    const deliveryIds = new Set(blueprint.steps.filter(step => deliveryNames.has(step.action ?? "")).map(step => step.id));
    const scopes = decisionReturnScopes(root, deliveryIds);
    for (const [id, visible] of scopes.predecessors) predecessors.set(id, visible);
    if (scopes.hasCondition && !requested) issues.push("A recurring decision was added without a requested conditional outcome");
    for (const node of controlNodes(root)) if (node.predicate.kind !== "ref")
      issues.push(`Recurring condition ${node.id} must retain a declared boolean reference, not a constant delivery choice`);
    if (scopes.unreachable.length) issues.push(`Recurring work is unreachable after Return: ${scopes.unreachable.join(", ")}`);
    if (scopes.maxEffects > 1) issues.push("A recurring draft may not silently select multiple delivery effects on one possible path");
  } catch { issues.push("Recurring composition requires supported decisions/Returns without branch merges or collections"); }
  return { predecessors, issues, structured: true };
}
