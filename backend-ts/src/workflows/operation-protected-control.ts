import type { ReadRunProgress } from "../repository/store.js";
import type { OperationProtectedReceipt } from "../runner/operation-state.js";
import { actionOrder, protectedNodes, type ReadSequence } from "./read-control-flow.js";

type Protect = Extract<ReadSequence["nodes"][number], { kind: "protect" }>;
type Failure = { failedNodeId: string; protectedId: string };
export type ProtectedSkipReason = { conditionId: string; selected: "then" | "else" } | { returnId: string } |
  { protectedId: string; outcome: "BODY_SUCCEEDED" | "BODY_ABORTED"; failedNodeId?: string };
export type ProtectedOperationTransition =
  { kind: "action"; nodeId: string; index: number } |
  { kind: "decision"; node: Extract<ReadSequence["nodes"][number], { kind: "if" }>; index: number } |
  { kind: "merge"; node: Extract<ReadSequence["nodes"][number], { kind: "if" }>; selected: "then" | "else"; index: number } |
  { kind: "return"; node: Extract<ReadSequence["nodes"][number], { kind: "return" }>; index: number } |
  { kind: "protected-start"; node: Protect; index: number } |
  { kind: "protected-complete"; node: Protect; outcome: "SUCCEEDED" | "HANDLED_ERROR" | "RETURNED" | "FAILED"; index: number } |
  { kind: "skip"; nodeId: string; index: number; reason: ProtectedSkipReason } |
  { kind: "complete"; returned?: string };

/** Structure only, no handler authority. The worker must verify each private
 * selection against the exact failed intent/current pins before using this.
 * Historical v1-v7 traversal remains separate and still rejects protect. */
export function protectedOperationTransition(root: ReadSequence,
  progress: Pick<ReadRunProgress, "attempts" | "decisions" | "values" | "nextStepIndex">,
  scopes: Readonly<Record<string, OperationProtectedReceipt>>,
  skipped?: Map<string, { index: number; reason: ProtectedSkipReason }>): ProtectedOperationTransition {
  const order = actionOrder(root), positions = new Map(order.map((id, index) => [id, index]));
  if (positions.size !== order.length) throw new Error("Protected operation has duplicate action ownership");
  const groups = new Map(protectedNodes(root).map(node => [node.id, node]));
  const accounted = new Set<string>(), decisions = new Set<string>(), values = new Set<string>(), entered = new Set<string>();
  let transition: ProtectedOperationTransition | undefined;
  // A failed read may propagate through an inner handler into an outer body.
  // Choose the innermost selected group when reading its original body failure.
  const failures = new Map<string, string[]>();
  for (const [id, receipt] of Object.entries(scopes)) {
    if (!groups.has(id) || receipt.profile !== "operation-protected/v1") throw new Error("Orphaned protected receipt");
    if (receipt.selection) {
      const selection = receipt.selection;
      if (selection.code !== "ERP_RESOURCE_NOT_FOUND" || positions.get(selection.failedNodeId) !== selection.failedIndex ||
          progress.attempts[selection.failedNodeId]?.status !== "FAILED") throw new Error("Protected selection has no exact failed action");
      failures.set(selection.failedNodeId, [...(failures.get(selection.failedNodeId) ?? []), id]);
    }
  }
  const skip = (block: ReadSequence, reason: ProtectedSkipReason) => {
    for (const nodeId of actionOrder(block)) {
      if (transition) return;
      const index = positions.get(nodeId)!, attempt = progress.attempts[nodeId];
      if (!attempt) { transition = { kind: "skip", nodeId, index, reason }; return; }
      if (attempt.status !== "SKIPPED" || attempt.stepIndex !== index) throw new Error("Unselected protected action has an incompatible receipt");
      skipped?.set(nodeId, { index, reason });
      accounted.add(nodeId);
    }
  };
  type Result = { returned?: string; failure?: Failure };
  const complete = (node: Protect, outcome: NonNullable<OperationProtectedReceipt["completion"]>["outcome"]) => {
    const receipt = scopes[node.id]!, index = accounted.size;
    if (!receipt.completion) { transition = { kind: "protected-complete", node, outcome, index }; return; }
    if (receipt.completion.outcome !== outcome || receipt.completion.index !== index) throw new Error("Protected completion is detached from its selected path");
    if (outcome === "SUCCEEDED" || outcome === "HANDLED_ERROR") {
      const value = progress.values?.[node.id];
      if (value?.kind !== "protect" || value.status !== "DONE" || value.stepIndex !== index || value.completedAt !== receipt.completion.completedAt)
        throw new Error("Protected output lacks its exact completion receipt");
      values.add(node.id);
    } else if (progress.values?.[node.id]) throw new Error("Terminated protected scope cannot manufacture a final value");
  };
  const visit = (block: ReadSequence, activeBodies: string[]): Result => {
    let result: Result = {};
    for (const node of block.nodes) {
      if (transition) return result;
      if (result.returned || result.failure) {
        skip({ kind: "sequence", nodes: [node] }, result.returned ? { returnId: result.returned } :
          { protectedId: result.failure!.protectedId, failedNodeId: result.failure!.failedNodeId, outcome: "BODY_ABORTED" });
        continue;
      }
      if (node.kind === "action") {
        const index = positions.get(node.nodeId)!, attempt = progress.attempts[node.nodeId];
        if (attempt && attempt.stepIndex !== index) throw new Error("Protected action is detached from source order");
        if (attempt?.status === "DONE") { accounted.add(node.nodeId); continue; }
        if (attempt?.status === "FAILED") {
          const owner = [...activeBodies].reverse().find(id => failures.get(node.nodeId)?.includes(id));
          if (!owner) throw new Error("Failed action has no selected enclosing protected body");
          accounted.add(node.nodeId); result = { failure: { failedNodeId: node.nodeId, protectedId: owner } }; continue;
        }
        if (attempt && !["PREPARING", "DISPATCH_INTENT"].includes(attempt.status)) throw new Error("Selected protected action has an incompatible receipt");
        transition = { kind: "action", nodeId: node.nodeId, index }; return result;
      }
      if (node.kind === "return") {
        const index = accounted.size, receipt = progress.values?.[node.id];
        if (!receipt) { transition = { kind: "return", node, index }; return result; }
        if (receipt.kind !== "return" || receipt.status !== "DONE" || receipt.stepIndex !== index) throw new Error("Protected Return lacks an exact receipt");
        values.add(node.id); result = { returned: node.id }; continue;
      }
      if (node.kind === "if") {
        const index = accounted.size, receipt = progress.decisions?.[node.id];
        if (!receipt) { transition = { kind: "decision", node, index }; return result; }
        if (receipt.status !== "DONE" || !["then", "else"].includes(receipt.selected ?? "") || receipt.stepIndex !== index) throw new Error("Protected condition lacks an exact receipt");
        decisions.add(node.id);
        if (receipt.selected === "else") skip(node.then, { conditionId: node.id, selected: "else" });
        if (!transition) result = visit(node[receipt.selected!], activeBodies);
        if (!transition && receipt.selected === "then") skip(node.else, { conditionId: node.id, selected: "then" });
        if (!transition && !result.returned && !result.failure && node.merge) {
          const index = accounted.size, value = progress.values?.[node.id];
          if (!value) { transition = { kind: "merge", node, selected: receipt.selected!, index }; return result; }
          if (value.kind !== "merge" || value.status !== "DONE" || value.stepIndex !== index) throw new Error("Protected branch output lacks an exact receipt");
          values.add(node.id);
        }
        continue;
      }
      if (node.kind !== "protect") throw new Error("Protected collections require the durable iteration integration");
      const receipt = scopes[node.id], index = accounted.size;
      if (!receipt) { transition = { kind: "protected-start", node, index }; return result; }
      if (receipt.startIndex !== index) throw new Error("Protected entry is detached from source order");
      entered.add(node.id);
      let inner = visit(node.body, [...activeBodies, node.id]);
      if (transition) return result;
      if (inner.returned) {
        if (receipt.selection) throw new Error("Returned body has a contradictory handler selection");
        skip(node.handler, { returnId: inner.returned });
      } else if (inner.failure) {
        if (receipt.selection) {
          if (receipt.selection.failedNodeId !== inner.failure.failedNodeId) throw new Error("Protected handler selection disagrees with body failure");
          inner = visit(node.handler, activeBodies);
        } else {
          skip(node.handler, { protectedId: inner.failure.protectedId, failedNodeId: inner.failure.failedNodeId, outcome: "BODY_ABORTED" });
        }
      } else {
        if (receipt.selection) throw new Error("Successful body has a contradictory handler selection");
        skip(node.handler, { protectedId: node.id, outcome: "BODY_SUCCEEDED" });
      }
      if (transition) return result;
      complete(node, inner.returned ? "RETURNED" : inner.failure ? "FAILED" : receipt.selection ? "HANDLED_ERROR" : "SUCCEEDED");
      if (transition) return result;
      result = inner;
    }
    return result;
  };
  const result = visit(root, []), next = transition ?? { kind: "complete" as const, ...(result.returned ? { returned: result.returned } : {}) };
  if (!transition && result.failure) throw new Error("Unhandled protected failure cannot complete the run");
  if (Object.keys(progress.attempts).some(id => !positions.has(id) || !accounted.has(id) && !(next.kind === "action" && id === next.nodeId)) ||
      Object.keys(progress.decisions ?? {}).some(id => !decisions.has(id)) || Object.keys(progress.values ?? {}).some(id => !values.has(id)) ||
      Object.keys(scopes).some(id => !entered.has(id)) || progress.nextStepIndex !== (next.kind === "complete" ? order.length : next.index))
    throw new Error("Protected pointer or receipts do not match the confirmed path");
  return next;
}

/** Static nearest-body ownership, not error-text matching. A handler is outside
 * its own protected body but may be inside an explicitly authored outer body. */
export function protectedFailureOwners(root: ReadSequence, nodeId: string): string[] {
  let owners: string[] | undefined;
  const visit = (block: ReadSequence, active: string[]) => { for (const node of block.nodes) {
    if (node.kind === "action" && node.nodeId === nodeId) {
      if (owners) throw new Error("Protected action has duplicate ownership");
      owners = [...active].reverse();
    } else if (node.kind === "protect") { visit(node.body, [...active, node.id]); visit(node.handler, active); }
    else if (node.kind === "if") { visit(node.then, active); visit(node.else, active); }
    else if (node.kind === "foreach") visit(node.body, active);
  } };
  visit(root, []); return owners ?? [];
}
