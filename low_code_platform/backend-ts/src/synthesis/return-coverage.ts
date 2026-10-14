import type { Workflow, WorkflowBlueprint } from "../models/schemas.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { actionOrder, loopNodes, parseReadControlFlow, structuralNodes, type ReadSequence } from "../workflows/read-control-flow.js";

/** Denial-only generated-draft check. Do not interpret predicates, prove user
 * intent, rewrite source or grant publication. Both branch possibilities are
 * retained; runtime selection still uses acknowledged exact boolean values.
 * Collection exits have a separate meaning and remain the compiler's concern. */
export function generatedReturnCoverageIssues(blueprint: WorkflowBlueprint): string[] {
  if (blueprint.metadata?.controlFlow === undefined) return [];
  let root: ReadSequence;
  try { root = parseReadControlFlow(blueprint.metadata.controlFlow).root; } catch { return []; } // Strict compiler reports invalid structure.
  if (loopNodes(root).length || !structuralNodes(root).some(node => node.kind === "return")) return [];
  const reachedActions = new Set<string>(), reachedReturns = new Set<string>();
  const visit = (block: ReadSequence, canEnter: boolean): boolean => {
    let continues = canEnter;
    for (const node of block.nodes) {
      if (node.kind === "action") { if (continues) reachedActions.add(node.nodeId); }
      else if (node.kind === "return") { if (continues) reachedReturns.add(node.id); continues = false; }
      else if (node.kind === "if") {
        const yes = visit(node.then, continues), no = visit(node.else, continues);
        continues = yes || no;
      }
    }
    return continues;
  };
  visit(root, true);
  return [...actionOrder(root).filter(id => !reachedActions.has(id)).map(id =>
    `Generated step ${id} is unreachable after typed returns; preserve the requested outcome in a reachable scope or as an unresolved requirement`),
    ...structuralNodes(root).filter(node => node.kind === "return" && !reachedReturns.has(node.id)).map(node =>
      `Generated return ${node.id} is unreachable after an earlier typed return; no answer can be produced there`)];
}

/** Keep a saved chat-generated proposal's denial visible at readiness and
 * publication. These origin fields are saved by the server, not inferred from
 * user YAML. Recompute on the exact current draft so explicit edits can repair
 * its structure; do not mutate historical answers or a published run. */
export function savedGeneratedReturnCoverageIssues(workflow: Pick<Workflow, "yaml" | "chatSessionId" | "chatMessageId">): string[] {
  if (!workflow.chatSessionId || !workflow.chatMessageId) return [];
  try { return generatedReturnCoverageIssues(parseWorkflowYAMLStrict(workflow.yaml)); }
  catch { return []; } // Existing strict validation reports malformed source.
}
