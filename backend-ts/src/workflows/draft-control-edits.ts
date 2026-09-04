import type { WorkflowBlueprint } from "../models/schemas.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { actionOrder, structuralNodes, valueNodes, loopNodes, parseReadControlFlow, type ReadControlNode, type ReadSequence } from "./read-control-flow.js";

export type BranchDestination = { conditionId: string; branch: "then" | "else" } | { loopId: string; scope: "body" };
function reject(message: string): never { throw new HandlerFailure(422, message); }
export function draftFlow(blueprint: WorkflowBlueprint): ReadSequence {
  const root = blueprint.metadata?.controlFlow === undefined
    ? { kind: "sequence" as const, nodes: blueprint.steps.map(step => ({ kind: "action" as const, nodeId: step.id })) }
    : parseReadControlFlow(blueprint.metadata.controlFlow).root;
  const ids = actionOrder(root);
  if (ids.length !== blueprint.steps.length || ids.some((id, index) => id !== blueprint.steps[index]?.id) || new Set(ids).size !== ids.length)
    reject("Repair structural ownership before editing this flow");
  const controls = structuralNodes(root).map(node => node.id);
  if (new Set(controls).size !== controls.length || controls.some(id => ids.includes(id))) reject("Repair duplicate structural IDs before editing this flow");
  return root;
}
export function locateFlowNode(root: ReadSequence, id: string): { block: ReadSequence; index: number; node: ReadControlNode } | undefined {
  for (let index = 0; index < root.nodes.length; index++) {
    const node = root.nodes[index]!;
    if ((node.kind === "action" ? node.nodeId : node.id) === id) return { block: root, index, node };
    if (node.kind === "if") { const match = locateFlowNode(node.then, id) ?? locateFlowNode(node.else, id); if (match) return match; }
    if (node.kind === "foreach") { const match = locateFlowNode(node.body, id); if (match) return match; }
  }
  return undefined;
}
export function insertionScope(root: ReadSequence, beforeNodeId: string | null, destination?: BranchDestination): { block: ReadSequence; index: number } {
  let block = root;
  if (destination) {
    if ("loopId" in destination) {
      const node = locateFlowNode(root, destination.loopId)?.node;
      if (!node || node.kind !== "foreach") reject("Destination collection does not exist");
      block = node.body;
    } else {
      const node = locateFlowNode(root, destination.conditionId)?.node;
      if (!node || node.kind !== "if") reject("Destination condition does not exist");
      block = node[destination.branch];
    }
  }
  if (beforeNodeId !== null) {
    const target = locateFlowNode(root, beforeNodeId);
    if (!target) reject("Insertion target does not exist");
    if (destination && target.block !== block) reject("Insertion target is outside the selected destination scope");
    return { block: target.block, index: target.index };
  }
  return { block, index: block.nodes.length };
}
export function saveDraftFlow(blueprint: WorkflowBlueprint, root: ReadSequence): void {
  const existing = (blueprint.metadata?.controlFlow as { schemaVersion?: string } | undefined)?.schemaVersion;
  const parsed = parseReadControlFlow({ schemaVersion: loopNodes(root).length || existing === "read-control-flow/v3" ? "read-control-flow/v3" : valueNodes(root).length || existing === "read-control-flow/v2" ? "read-control-flow/v2" : "read-control-flow/v1", root });
  const controls = structuralNodes(parsed.root), ids = actionOrder(parsed.root);
  if (controls.length > 100 || new Set([...ids, ...controls.map(node => node.id)]).size !== ids.length + controls.length)
    reject("Structural IDs must be unique and at most 100 conditions are supported");
  const bound = (block: ReadSequence, depth: number) => {
    if (depth > 8) reject("Control flow exceeds eight nested scopes");
    for (const node of block.nodes) if (node.kind === "if") { bound(node.then, depth + 1); bound(node.else, depth + 1); }
    else if (node.kind === "foreach") bound(node.body, depth + 1);
  };
  bound(parsed.root, 0);
  const definitions = new Map(blueprint.steps.map(step => [step.id, step]));
  if (ids.length !== definitions.size || ids.some(id => !definitions.has(id))) reject("Every declared action must have exactly one structural owner");
  blueprint.steps = ids.map(id => definitions.get(id)!);
  blueprint.metadata = { ...blueprint.metadata, controlFlow: parsed };
}
