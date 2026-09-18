import { effectiveStepKind, type WorkflowBlueprint } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { inspectModelWorkflowDraft } from "../workflows/compiled-read.js";
import type { RecurringRequestedResource } from "./recurring-automation.js";

export type RecurringAnalysisMapping = { index: number; id: string; sourceStepId: string; resource: RecurringRequestedResource };
export type RecurringReportSource = { index: number; id: string; resource: RecurringRequestedResource };

/** Pure authoring evidence only. Runtime publication independently captures
 * source sensitivity, provider egress, schemas and per-effect approval. */
export function inspectRecurringAnalysis(blueprint: WorkflowBlueprint, requested: boolean, resources: readonly RecurringRequestedResource[],
  reports: readonly RecurringReportSource[], tools: readonly ToolDefinition[], role: string) {
  const mappings: RecurringAnalysisMapping[] = [], issues: string[] = [];
  const nodes = blueprint.steps.map((step, index) => ({ step, index })).filter(({ step }) => effectiveStepKind(step) === "analysis");
  if (nodes.length) {
    if (!requested) issues.push("Analysis was added without a requested analysis outcome");
    issues.push(...inspectModelWorkflowDraft(blueprint, tools, role));
    if (nodes.length > resources.length || nodes.length > 2) issues.push("Recurring analysis permits at most one bounded analysis per requested report resource");
  }
  for (const { step, index } of nodes) {
    const input = exactOutputReference(step.input), report = input && reports.find(value => value.id === input.root);
    if (!report || input?.path[0] !== "structuredContent" || reports.some(value => value.index >= index)) {
      issues.push(`Analysis ${step.id} must consume a declared report output after all report reads`); continue;
    }
    if (mappings.some(value => value.resource === report.resource)) issues.push(`Requested resource ${report.resource} has duplicate analysis nodes`);
    mappings.push({ index, id: step.id, sourceStepId: report.id, resource: report.resource });
  }
  return { mappings, issues, bound: requested && resources.length > 0 && resources.every(resource => mappings.some(value => value.resource === resource)) };
}

export function exactOutputReference(value: unknown): { root: string; path: string[] } | null {
  if (typeof value !== "string") return null;
  const match = /^\{\{\s*([A-Za-z][A-Za-z0-9_-]*)((?:\.[A-Za-z0-9_-]+)+)\s*\}\}$/.exec(value);
  return match ? { root: match[1]!, path: match[2]!.slice(1).split(".") } : null;
}

/** Allow only explicit prior-output references and literal framing, never a
 * model-invented result. Typed string compatibility is checked by the compiler. */
export function deliveryOutputReferences(value: unknown): Array<{ root: string; path: string[] }> | null {
  if (typeof value !== "string") return null;
  const refs: Array<{ root: string; path: string[] }> = [];
  let cursor = 0;
  for (const match of value.matchAll(/\{\{[\s\S]*?\}\}/g)) {
    if (/\{\{|\}\}/.test(value.slice(cursor, match.index))) return null;
    const ref = exactOutputReference(match[0]); if (!ref) return null;
    refs.push(ref); cursor = match.index + match[0].length;
  }
  return /\{\{|\}\}/.test(value.slice(cursor)) || refs.length > 16 ? null : refs;
}
