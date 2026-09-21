import { stringify } from "yaml";
import type { WorkflowBlueprint } from "../models/schemas.js";
import { parseReadControlFlow, assertNoProtectedScopes, type ReadSequence } from "./read-control-flow.js";

/** Extra denial-only process/shape view, NEVER a publication source or token.
 * Keep lexical structural ownership while excluding unconfirmed actions from
 * prerequisite evidence. The broker still validates and dispatches against
 * the original exact source, compiled selected path and current argument pin. */
export function selectedPrerequisiteYAML(blueprint: WorkflowBlueprint, selectedId: string, completed: ReadonlySet<string>): string {
  const steps = blueprint.steps.filter(step => step.id === selectedId || completed.has(step.id)), included = new Set(steps.map(step => step.id));
  const metadata = { ...blueprint.metadata };
  if (metadata.controlFlow !== undefined) {
    const flow = parseReadControlFlow(metadata.controlFlow);
    assertNoProtectedScopes(flow.root);
    const prune = (block: ReadSequence): ReadSequence => ({ kind: "sequence", nodes: block.nodes.flatMap<ReadSequence["nodes"][number]>(node => {
      if (node.kind === "action") return included.has(node.nodeId) ? [node] : [];
      if (node.kind === "if") return [{ ...node, then: prune(node.then), else: prune(node.else) }];
      if (node.kind === "foreach") return [{ ...node, body: prune(node.body) }];
      return [node];
    }) });
    metadata.controlFlow = { ...flow, root: prune(flow.root) };
  }
  return stringify({ ...blueprint, metadata, steps });
}
