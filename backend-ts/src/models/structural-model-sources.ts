import type { WorkflowBlueprint } from "./schemas.js";
import { actionOrder, loopNodes, parseReadControlFlow, structuralNodes, type ReadSequence } from "../workflows/read-control-flow.js";

/** Declarative source shape only. Does not infer types from tool inputs,
 * manufacture outputs or grant compiler/publication/provider authority. */
export function mergeSourceInScope(workflow: WorkflowBlueprint, sourceId: string, targetId: string): boolean {
  let root: ReadSequence;
  try { root = parseReadControlFlow(workflow.metadata?.controlFlow).root; } catch { return false; }
  if (loopNodes(root).length) return false;
  const order = actionOrder(root), structures = structuralNodes(root), ids = [...order, ...structures.map(node => node.id)];
  if (order.length !== workflow.steps.length || order.some((id, index) => id !== workflow.steps[index]?.id) || new Set(ids).size !== ids.length || structures.length > 100) return false;
  let found = false;
  const visit = (block: ReadSequence, outer: Set<string>, depth: number): void => {
    if (depth > 8) return;
    const available = new Set(outer);
    for (const node of block.nodes) {
      if (node.kind === "action") { if (node.nodeId === targetId) found = available.has(sourceId); }
      else if (node.kind === "if") {
        visit(node.then, available, depth + 1); visit(node.else, available, depth + 1);
        if (node.merge) available.add(node.id);
      }
    }
  };
  visit(root, new Set(), 0);
  return found;
}
