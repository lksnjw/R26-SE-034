import type { ReadIR, ReadBinding, CompiledOperationPlan } from "./compiled-read.js";
import { actionOrder, validateReadControlFlow, lexicalSchemaOverrides, assertNoProtectedScopes, type ReadSequence } from "./read-control-flow.js";
import { protectedOperationTransition } from "./operation-protected-control.js";
import type { OperationProtectedReceipt } from "../runner/operation-state.js";
import { schemaAt } from "./read-binding-validation.js";
import type { ReadRunProgress } from "../repository/store.js";

/** The authoring tree is shared; operation decisions have a separate versioned
 * compilation and durable worker. No read-interpreter effect authority. */
export function inspectOperationDecisions(root: ReadSequence, nodes: Array<{ id: string; inputs: ReadBinding }>, inputSchema: Record<string, unknown> | undefined,
  outputs: ReadonlyMap<string, Record<string, unknown>>, inputs: ReadonlyMap<string, Record<string, unknown>> = new Map(), protectedDraftInspection = false) {
  const issues: string[] = [];
  const projection: ReadIR = { schemaVersion: "workflow-read-ir/v2", compilerVersion: "read-compiler/v2", trigger: { kind: "manual" },
    ...(inputSchema ? { inputSchema } : {}), root: { kind: "sequence", nodes: nodes.map(node => ({ ...node, kind: "action", capability: {
      toolId: "draft-scope-only", action: "draft-scope-only", remoteName: "draft-scope-only", contractHash: "draft-scope-only",
    } })) } };
  const lexicalSchemas = lexicalSchemaOverrides(root);
  const visit = (block: ReadSequence) => { for (const node of block.nodes) {
    if (node.kind === "action") continue;
    if (node.kind === "return") continue;
    if (node.kind === "protect") { visit(node.body); visit(node.handler); continue; }
    if (node.kind === "foreach" && protectedDraftInspection) { visit(node.body); continue; }
    if (node.kind !== "if") { issues.push("Operation decisions do not yet support collections"); continue; }
    if (node.predicate.kind === "ref" && schemaAt(node.predicate.source === "workflowInput" ? inputSchema : lexicalSchemas.get(node.id)?.get(node.predicate.nodeId!) ?? outputs.get(node.predicate.nodeId!), node.predicate.path)?.type !== "boolean")
      issues.push(`Operation condition ${node.id} requires an exact declared boolean predicate`);
    visit(node.then); visit(node.else);
  } };
  visit(root);
  const validation = validateReadControlFlow(root, projection, outputs, inputs);
  return { ...validation, issues: [...new Set([...issues, ...validation.issues])] };
}

export type OperationControlTransition = { kind: "action"; nodeId: string; index: number } | { kind: "decision"; node: Extract<ReadSequence["nodes"][number], { kind: "if" }>; index: number } |
  { kind: "return"; node: Extract<ReadSequence["nodes"][number], { kind: "return" }>; index: number } |
  { kind: "merge"; node: Extract<ReadSequence["nodes"][number], { kind: "if" }>; selected: "then" | "else"; index: number } |
  { kind: "skip"; nodeId: string; index: number; conditionId: string; selected: "then" | "else"; returnId?: never } |
  { kind: "skip"; nodeId: string; index: number; returnId: string; conditionId?: never; selected?: never } | { kind: "complete" };

/** Denial-only traversal of exact committed receipts. It never evaluates a
 * predicate, dispatches, grants approval or infers success from a pointer. */
export function operationControlTransition(root: ReadSequence, progress: Pick<ReadRunProgress, "attempts" | "decisions" | "values" | "nextStepIndex">): OperationControlTransition {
  assertNoProtectedScopes(root);
  const order = actionOrder(root), positions = new Map(order.map((id, index) => [id, index]));
  const visited = new Set<string>(), returnedValues = new Set<string>(), accounted = new Set<string>();
  let transition: OperationControlTransition | undefined;
  const skip = (block: ReadSequence, reason: { conditionId: string; selected: "then" | "else" } | { returnId: string }) => {
    for (const nodeId of actionOrder(block)) {
      if (transition) return;
      const attempt = progress.attempts[nodeId], index = positions.get(nodeId)!;
      if (!attempt) { transition = { kind: "skip", nodeId, index, ...reason }; return; }
      if (attempt.status !== "SKIPPED" || attempt.stepIndex !== index) throw new Error("Unselected operation node has an incompatible receipt");
      accounted.add(nodeId);
    }
  };
  const visit = (block: ReadSequence): string | undefined => {
    let returned: string | undefined;
    for (const node of block.nodes) {
    if (transition) return returned;
    if (returned) { skip({ kind: "sequence", nodes: [node] }, { returnId: returned }); continue; }
    if (node.kind === "action") {
      const index = positions.get(node.nodeId)!, attempt = progress.attempts[node.nodeId];
      if (attempt && attempt.stepIndex !== index) throw new Error("Operation receipt is detached from source order");
      if (attempt?.status === "DONE") { accounted.add(node.nodeId); continue; }
      if (attempt && !["PREPARING", "DISPATCH_INTENT"].includes(attempt.status)) throw new Error("Selected operation node has an incompatible receipt");
      transition = { kind: "action", nodeId: node.nodeId, index }; return;
    }
    if (node.kind === "return") {
      const index = accounted.size, receipt = progress.values?.[node.id];
      if (!receipt) { transition = { kind: "return", node, index }; return; }
      if (receipt.kind !== "return" || receipt.status !== "DONE" || receipt.stepIndex !== index) throw new Error("Operation return lacks an exact confirmed receipt");
      returnedValues.add(node.id); returned = node.id; continue;
    }
    if (node.kind !== "if") throw new Error("Unsupported operation control primitive");
    const index = accounted.size, receipt = progress.decisions?.[node.id];
    if (!receipt) { transition = { kind: "decision", node, index }; return; }
    if (receipt.status !== "DONE" || !["then", "else"].includes(receipt.selected ?? "") || receipt.stepIndex !== index) throw new Error("Operation decision lacks an exact confirmed receipt");
    visited.add(node.id);
    if (receipt.selected === "else") skip(node.then, { conditionId: node.id, selected: "else" });
    if (!transition) returned = visit(node[receipt.selected!]);
    if (!transition && receipt.selected === "then") skip(node.else, { conditionId: node.id, selected: "then" });
    if (!transition && !returned && node.merge) {
      const index = accounted.size, value = progress.values?.[node.id];
      if (!value) { transition = { kind: "merge", node, selected: receipt.selected!, index }; return; }
      if (value.kind !== "merge" || value.status !== "DONE" || value.stepIndex !== index) throw new Error("Operation merge lacks an exact confirmed receipt");
      returnedValues.add(node.id);
    }
  }
    return returned;
  };
  visit(root);
  const next = transition ?? { kind: "complete" as const };
  if (Object.keys(progress.attempts).some(id => !accounted.has(id) && !(next.kind === "action" && id === next.nodeId)) ||
      Object.keys(progress.decisions ?? {}).some(id => !visited.has(id)) || Object.keys(progress.attempts).some(id => !positions.has(id)) ||
      Object.keys(progress.values ?? {}).some(id => !returnedValues.has(id)) ||
      progress.nextStepIndex !== (next.kind === "complete" ? order.length : next.index)) throw new Error("Operation pointer or receipts do not match the confirmed decision path");
  return next;
}

export function assertOperationSelectedNode(plan: CompiledOperationPlan, progress: ReadRunProgress, nodeId: string, scopes?: Readonly<Record<string, OperationProtectedReceipt>>): void {
  if (!plan.ir.flow) return;
  const next = plan.ir.schemaVersion === "workflow-operation-ir/v8" ? protectedOperationTransition(plan.ir.flow, progress, scopes ?? {}) : operationControlTransition(plan.ir.flow, progress);
  if (next.kind !== "action" || next.nodeId !== nodeId) throw new Error("Operation node is not the next confirmed selected action");
}

/** Control dependencies retain their sensitivity even when the model input is
 * otherwise public. Branch selection is not a declassification boundary. */
export function operationControlDependencies(root: ReadSequence | undefined): Map<string, ReadBinding[]> {
  const dependencies = new Map<string, ReadBinding[]>();
  const visit = (block: ReadSequence, parents: ReadBinding[]) => { for (const node of block.nodes) {
    if (node.kind === "action") dependencies.set(node.nodeId, parents);
    else if (node.kind === "return") continue;
    else if (node.kind === "if") { visit(node.then, [...parents, node.predicate]); visit(node.else, [...parents, node.predicate]); }
    else if (node.kind === "protect") {
      visit(node.body, parents);
      // The presence of a fault is itself sensitive. A literal notification or
      // fallback model must not declassify the protected body's reviewed data.
      visit(node.handler, [...parents, { kind: "ref", source: "nodeOutput", nodeId: node.id, path: ["error", "code"] }]);
    }
    else throw new Error("Unsupported operation control dependency");
  } };
  if (root) visit(root, []);
  return dependencies;
}
