import type { WorkflowBlueprint } from "./schemas.js";
import { actionOrder, handlerScopeIDs, loopNodes, parseReadControlFlow, structuralNodes, type ReadSequence } from "../workflows/read-control-flow.js";

function checkedRoot(workflow: WorkflowBlueprint): ReadSequence | undefined {
  let root: ReadSequence;
  try { root = parseReadControlFlow(workflow.metadata?.controlFlow).root; } catch { return undefined; }
  if (loopNodes(root).length) return undefined;
  const order = actionOrder(root), structures = structuralNodes(root), ids = [...order, ...structures.map(node => node.id)];
  if (order.length !== workflow.steps.length || order.some((id, index) => id !== workflow.steps[index]?.id) || new Set(ids).size !== ids.length || structures.length > 100) return undefined;
  return root;
}

/** Only the declared safe fault fields in an actual lexical handler. Full
 * compiler typing, classification and owned selection remain mandatory. */
export function protectedFaultSourceInScope(workflow: WorkflowBlueprint, sourceId: string, targetId: string, path: readonly string[]): boolean {
  const root = checkedRoot(workflow);
  return !!root && path[0] === "error" && (path.length === 1 || path.length === 2 && ["code", "failedNodeId"].includes(path[1]!)) &&
    !!handlerScopeIDs(root).get(targetId)?.includes(sourceId);
}

/** Declarative source shape only. Does not infer types from tool inputs,
 * manufacture outputs or grant compiler/publication/provider authority. */
export function mergeSourceInScope(workflow: WorkflowBlueprint, sourceId: string, targetId: string): boolean {
  const root = checkedRoot(workflow);
  if (!root) return false;
  let found = false;
  const visit = (block: ReadSequence, outer: Set<string>, depth: number): void => {
    if (depth > 8) return;
    const available = new Set(outer);
    for (const node of block.nodes) {
      if (node.kind === "action") { if (node.nodeId === targetId) found = available.has(sourceId); }
      else if (node.kind === "if") {
        visit(node.then, available, depth + 1); visit(node.else, available, depth + 1);
        if (node.merge) available.add(node.id);
      } else if (node.kind === "protect") {
        visit(node.body, available, depth + 1); visit(node.handler, available, depth + 1);
        available.add(node.id);
      }
    }
  };
  visit(root, new Set(), 0);
  return found;
}
