import { z } from "zod";
import {
  blueprintTriggerSchema,
  jsonObjectSchema,
  workflowStepBlueprintSchema,
  type WorkflowBlueprint,
  type WorkflowStepBlueprint,
} from "../models/schemas.js";
import { stringifyWorkflowYAML } from "../parser/workflow.js";

const nodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const semanticNodeSchema = workflowStepBlueprintSchema.extend({ id: nodeId }).strict();
const semanticEdgeSchema = z.object({ source: nodeId, target: nodeId }).strict();
const requestSchema = z.object({
  profile: z.literal("source-order-canvas/v1"),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  trigger: blueprintTriggerSchema,
  metadata: jsonObjectSchema.optional(),
  nodes: z.array(semanticNodeSchema).min(1).max(200),
  edges: z.array(semanticEdgeSchema).max(199),
}).strict();

export class CanvasConversionFailure extends Error {
  constructor(readonly issues: string[]) {
    super(issues[0] ?? "Canvas graph is invalid");
    this.name = "CanvasConversionFailure";
  }
}

export type SourceOrderCanvasConversion = {
  profile: "source-order-canvas/v1";
  blueprint: WorkflowBlueprint;
  yaml: string;
  nodeOrder: string[];
};

/** Converts only an explicit one-root, one-path graph. Visual branching,
 * disconnected nodes and cycles are never inferred or flattened. */
export function convertSourceOrderCanvas(input: unknown): SourceOrderCanvasConversion {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    throw new CanvasConversionFailure(parsed.error.issues.slice(0, 20).map(issue => {
      const path = issue.path.length ? issue.path.join(".") : "request";
      return `${path}: ${issue.message}`;
    }));
  }
  const value = parsed.data, issues: string[] = [];
  const nodeById = new Map<string, WorkflowStepBlueprint>();
  for (const node of value.nodes) {
    if (nodeById.has(node.id)) issues.push(`Node ${node.id} is duplicated`);
    else nodeById.set(node.id, node);
  }
  const incoming = new Map(value.nodes.map(node => [node.id, [] as string[]]));
  const outgoing = new Map(value.nodes.map(node => [node.id, [] as string[]]));
  const pairs = new Set<string>();
  for (const edge of value.edges) {
    const pair = `${edge.source}\u0000${edge.target}`;
    if (pairs.has(pair)) { issues.push(`Connection ${edge.source} → ${edge.target} is duplicated`); continue; }
    pairs.add(pair);
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      issues.push(`Connection ${edge.source} → ${edge.target} references an unknown node`);
      continue;
    }
    if (edge.source === edge.target) { issues.push(`Node ${edge.source} cannot connect to itself`); continue; }
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }
  for (const node of value.nodes) {
    if (incoming.get(node.id)!.length > 1) issues.push(`Node ${node.id} has multiple incoming connections`);
    if (outgoing.get(node.id)!.length > 1) issues.push(`Node ${node.id} branches to multiple nodes; source-order canvas v1 does not infer branch semantics`);
  }
  const roots = value.nodes.filter(node => incoming.get(node.id)!.length === 0);
  if (roots.length !== 1) issues.push(`Canvas requires exactly one starting node; found ${roots.length}`);
  if (value.edges.length !== value.nodes.length - 1) issues.push("Every node must belong to one connected source-order chain");
  if (issues.length) throw new CanvasConversionFailure(issues.slice(0, 20));

  const ordered: WorkflowStepBlueprint[] = [], visited = new Set<string>();
  let current: WorkflowStepBlueprint | undefined = roots[0];
  while (current) {
    if (visited.has(current.id)) throw new CanvasConversionFailure([`Canvas contains a cycle at node ${current.id}`]);
    ordered.push(current); visited.add(current.id);
    const next = outgoing.get(current.id)![0];
    current = next === undefined ? undefined : nodeById.get(next);
  }
  if (ordered.length !== value.nodes.length)
    throw new CanvasConversionFailure(["Every node must belong to one connected source-order chain; cycles and disconnected groups are unsupported"]);

  const blueprint: WorkflowBlueprint = {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    trigger: value.trigger,
    steps: ordered,
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  };
  return { profile: value.profile, blueprint, yaml: stringifyWorkflowYAML(blueprint), nodeOrder: ordered.map(node => node.id) };
}

/** Correlates full-gate messages without treating substring matches inside
 * unrelated identifiers as node evidence. Global findings remain global. */
export function canvasStepErrors(steps: WorkflowStepBlueprint[], errors: string[]): Array<Record<string, unknown>> {
  const findings: Array<Record<string, unknown>> = [];
  for (const message of errors) {
    const matches = steps.filter(step => [step.id, step.action].some(value => value && containsToken(message, value)));
    if (!matches.length) findings.push({ scope: "workflow", node_id: null, action: null, message });
    else findings.push(...matches.map(step => ({ scope: "node", node_id: step.id, action: step.action ?? null, message })));
  }
  return findings;
}

function containsToken(message: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}([^A-Za-z0-9_.-]|$)`).test(message);
}
