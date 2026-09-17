import { effectiveStepKind, type WorkflowBlueprint } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";

/** Routing only, never admission. The selected compiler still validates every
 * node, exact capability pin, scope and effect contract independently. */
export function hasWorkflowEffects(source: WorkflowBlueprint, tools: readonly ToolDefinition[]): boolean {
  return source.steps.some(step => effectiveStepKind(step) === "tool" && tools.some(tool =>
    !tool.is_read_only && [tool.name, tool.mcp_tool_name].includes(step.action ?? "")));
}
export function usesCheckpointedOperationWorkflow(source: WorkflowBlueprint, tools: readonly ToolDefinition[]): boolean {
  return source.steps.some(step => ["analysis", "agent"].includes(effectiveStepKind(step))) || hasWorkflowEffects(source, tools);
}
