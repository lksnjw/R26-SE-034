import { z } from "zod";
import type { ReadBinding, ReadReference, ReadIR } from "./compiled-read.js";

export type ReadSequence = { kind: "sequence"; nodes: ReadControlNode[] };
export type ReadControlNode = { kind: "action"; nodeId: string } | { kind: "if"; id: string; predicate: ReadReference | { kind: "literal"; value: boolean }; then: ReadSequence; else: ReadSequence };
export type ReadControlFlow = { schemaVersion: "read-control-flow/v1"; root: ReadSequence };
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(value => !["input", "__proto__", "constructor", "prototype"].includes(value));
const path = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value))).max(16);
const predicate = z.union([
  z.object({ kind: z.literal("literal"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("ref"), source: z.literal("workflowInput"), path }).strict(),
  z.object({ kind: z.literal("ref"), source: z.literal("nodeOutput"), nodeId: identifier, path }).strict(),
]);
const sequence: z.ZodType<ReadSequence> = z.lazy(() => z.object({ kind: z.literal("sequence"), nodes: z.array(z.union([
  z.object({ kind: z.literal("action"), nodeId: identifier }).strict(),
  z.object({ kind: z.literal("if"), id: identifier, predicate, then: sequence, else: sequence }).strict(),
])).max(200) }).strict());
const flow = z.object({ schemaVersion: z.literal("read-control-flow/v1"), root: sequence }).strict();

/** Bound unknown input BEFORE recursive schema parsing. A control-flow record
 * is explicit execution meaning, never inferred from visual edges/layout. */
export function parseReadControlFlow(raw: unknown): ReadControlFlow {
  let nodes = 0;
  const bound = (value: unknown, depth: number) => {
    if (++nodes > 8192 || depth > 40) throw new Error("Control flow exceeds structural limits");
    if (value && typeof value === "object") for (const child of Object.values(value)) bound(child, depth + 1);
  };
  bound(raw, 0);
  return flow.parse(raw);
}
export const readControlFlowSchema = z.unknown().transform((raw, ctx) => {
  try { return parseReadControlFlow(raw); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid or oversized structured read control flow" }); return z.NEVER; }
});

export function actionOrder(root: ReadSequence): string[] {
  return root.nodes.flatMap(node => node.kind === "action" ? [node.nodeId] : [...actionOrder(node.then), ...actionOrder(node.else)]);
}
export function controlNodes(root: ReadSequence): Array<Extract<ReadControlNode, { kind: "if" }>> {
  return root.nodes.flatMap(node => node.kind === "action" ? [] : [node, ...controlNodes(node.then), ...controlNodes(node.else)]);
}
export function skippedActions(root: ReadSequence, conditionId: string, selected: "then" | "else"): string[] {
  const node = controlNodes(root).find(value => value.id === conditionId);
  if (!node) throw new Error("Unknown condition");
  return actionOrder(selected === "then" ? node.else : node.then);
}
export function assertSelectedReadNode(root: ReadSequence, nodeId: string, decisions: Record<string, { status: string; selected?: "then" | "else" }>) {
  let found = false;
  const visit = (block: ReadSequence, pathSelected: boolean) => {
    for (const node of block.nodes) {
      if ((node.kind === "action" ? node.nodeId : node.id) === nodeId) {
        found = true; if (!pathSelected) throw new Error("Node is not on a confirmed selected branch");
      }
      if (node.kind === "if") {
        const decision = decisions[node.id];
        visit(node.then, pathSelected && decision?.status === "DONE" && decision.selected === "then");
        visit(node.else, pathSelected && decision?.status === "DONE" && decision.selected === "else");
      }
    }
  };
  visit(root, true);
  if (!found) throw new Error("Node is not in the compiled flow");
}
function references(binding: ReadBinding): ReadReference[] {
  return binding.kind === "ref" ? [binding] : binding.kind === "object" ? Object.values(binding.fields).flatMap(references) : binding.kind === "array" ? binding.items.flatMap(references) : binding.kind === "template" ? binding.parts.filter((part): part is ReadReference => typeof part !== "string") : [];
}

/** Every action has one structural owner. Branch-local outputs cannot escape
 * to siblings/parent scope; an explicit merge primitive is still required. */
export function validateReadControlFlow(root: ReadSequence, ir: ReadIR, outputSchemas: ReadonlyMap<string, Record<string, unknown>>): { issues: string[]; scopes: Map<string, Set<string>> } {
  const issues: string[] = [], scopes = new Map<string, Set<string>>(), seen = new Set(ir.root.nodes.map(node => node.id));
  const definitions = new Map(ir.root.nodes.map(node => [node.id, node]));
  const order = actionOrder(root);
  if (order.length !== ir.root.nodes.length || order.some((id, index) => id !== ir.root.nodes[index]?.id) || new Set(order).size !== order.length)
    issues.push("Control flow must own every declared action exactly once in source declaration order");
  let controlCount = 0;
  const checkReference = (ref: ReadReference, available: Set<string>, label: string) => {
    if (ref.source === "nodeOutput" && !available.has(ref.nodeId!)) issues.push(`${label} references unavailable branch-local or forward data`);
  };
  const visit = (block: ReadSequence, outer: Set<string>, depth: number) => {
    if (depth > 8) { issues.push("Control flow exceeds eight nested scopes"); return; }
    const available = new Set(outer);
    for (const node of block.nodes) {
      if (node.kind === "action") {
        const action = definitions.get(node.nodeId);
        if (!action) { issues.push("Control flow references an unknown action"); continue; }
        scopes.set(node.nodeId, new Set(available));
        for (const ref of references(action.inputs)) checkReference(ref, available, `Step ${node.nodeId}`);
        available.add(node.nodeId);
      } else {
        if (++controlCount > 100 || seen.has(node.id)) issues.push("Conditions require unique IDs and at most 100 nodes");
        seen.add(node.id);
        if (node.predicate.kind === "ref") {
          checkReference(node.predicate, available, `Condition ${node.id}`);
          let schema = node.predicate.source === "workflowInput" ? ir.inputSchema : outputSchemas.get(node.predicate.nodeId!);
          for (const part of node.predicate.path) schema = schema?.type === "array" && /^(0|[1-9][0-9]*)$/.test(part) ? schema.items as Record<string, unknown> : (schema?.properties as Record<string, Record<string, unknown>>)?.[part];
          if (schema && schema.type !== "boolean") issues.push(`Condition ${node.id} requires a boolean predicate, not implicit conversion`);
        }
        visit(node.then, available, depth + 1); visit(node.else, available, depth + 1);
        // Deliberately do not merge branch-local values into the parent.
      }
    }
  };
  visit(root, new Set(), 0);
  return { issues: [...new Set(issues)], scopes };
}

export function assertReadFlowCompletion(root: ReadSequence, decisions: Record<string, { status: string; selected?: "then" | "else" }>, attempts: Record<string, { status: string }>) {
  const visited = new Set<string>(), selected = new Set<string>();
  const visit = (block: ReadSequence) => {
    for (const node of block.nodes) {
      if (node.kind === "action") selected.add(node.nodeId);
      else {
        const receipt = decisions[node.id];
        if (!receipt || receipt.status !== "DONE" || !["then", "else"].includes(receipt.selected ?? "")) throw new Error("Condition lacks a confirmed decision");
        visited.add(node.id); visit(node[receipt.selected!]);
      }
    }
  };
  visit(root);
  const declared = actionOrder(root);
  if (Object.keys(decisions).some(id => !visited.has(id)) || Object.keys(attempts).some(id => !declared.includes(id)) || declared.some(id => attempts[id]?.status !== (selected.has(id) ? "DONE" : "SKIPPED")))
    throw new Error("Confirmed node outcomes do not match the selected control path");
}
