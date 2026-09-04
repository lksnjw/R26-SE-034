import { z } from "zod";
import type { ReadBinding, ReadReference, ReadIR } from "./compiled-read.js";
import { mergeSchema, returnSchema, type ReadMerge, type ReadReturn } from "./read-values.js";
import { checkBinding, schemaAt } from "./read-binding-validation.js";

export type ReadSequence = { kind: "sequence"; nodes: ReadControlNode[] };
export type ReadControlNode = { kind: "action"; nodeId: string } | { kind: "if"; id: string; predicate: ReadReference | { kind: "literal"; value: boolean }; then: ReadSequence; else: ReadSequence; merge?: ReadMerge | undefined } | { kind: "return"; id: string; output: ReadReturn };
export type ReadControlFlow = { schemaVersion: "read-control-flow/v1" | "read-control-flow/v2"; root: ReadSequence };
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(value => !["input", "__proto__", "constructor", "prototype"].includes(value));
const path = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value))).max(16);
export const readPredicateSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("ref"), source: z.literal("workflowInput"), path }).strict(),
  z.object({ kind: z.literal("ref"), source: z.literal("nodeOutput"), nodeId: identifier, path }).strict(),
]);
const sequence: z.ZodType<ReadSequence> = z.lazy(() => z.object({ kind: z.literal("sequence"), nodes: z.array(z.union([
  z.object({ kind: z.literal("action"), nodeId: identifier }).strict(),
  z.object({ kind: z.literal("if"), id: identifier, predicate: readPredicateSchema, then: sequence, else: sequence, merge: mergeSchema.optional() }).strict(),
  z.object({ kind: z.literal("return"), id: identifier, output: returnSchema }).strict(),
])).max(200) }).strict());
const flow = z.object({ schemaVersion: z.enum(["read-control-flow/v1", "read-control-flow/v2"]), root: sequence }).strict();

/** Bound unknown input BEFORE recursive schema parsing. A control-flow record
 * is explicit execution meaning, never inferred from visual edges/layout. */
export function parseReadControlFlow(raw: unknown): ReadControlFlow {
  let nodes = 0;
  const bound = (value: unknown, depth: number) => {
    if (++nodes > 8192 || depth > 40) throw new Error("Control flow exceeds structural limits");
    if (value && typeof value === "object") for (const child of Object.values(value)) bound(child, depth + 1);
  };
  bound(raw, 0);
  const parsed = flow.parse(raw);
  if (parsed.schemaVersion === "read-control-flow/v1" && valueNodes(parsed.root).length) throw new Error("Typed values require read-control-flow/v2");
  return parsed;
}
export const readControlFlowSchema = z.unknown().transform((raw, ctx) => {
  try { return parseReadControlFlow(raw); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid or oversized structured read control flow" }); return z.NEVER; }
});

export function actionOrder(root: ReadSequence): string[] {
  return root.nodes.flatMap(node => node.kind === "action" ? [node.nodeId] : node.kind === "if" ? [...actionOrder(node.then), ...actionOrder(node.else)] : []);
}
export function controlNodes(root: ReadSequence): Array<Extract<ReadControlNode, { kind: "if" }>> {
  return root.nodes.flatMap(node => node.kind !== "if" ? [] : [node, ...controlNodes(node.then), ...controlNodes(node.else)]);
}
export function structuralNodes(root: ReadSequence): Array<Exclude<ReadControlNode, { kind: "action" }>> {
  return root.nodes.flatMap(node => node.kind === "action" ? [] : node.kind === "return" ? [node] : [node, ...structuralNodes(node.then), ...structuralNodes(node.else)]);
}
export function valueNodes(root: ReadSequence) { return structuralNodes(root).filter(node => node.kind === "return" || node.merge); }
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
export function validateReadControlFlow(root: ReadSequence, ir: ReadIR, outputSchemas: ReadonlyMap<string, Record<string, unknown>>): { issues: string[]; scopes: Map<string, Set<string>>; branchScopes: Map<string, { then: Set<string>; else: Set<string> }> } {
  const issues: string[] = [], scopes = new Map<string, Set<string>>(), branchScopes = new Map<string, { then: Set<string>; else: Set<string> }>(), seen = new Set(ir.root.nodes.map(node => node.id));
  const definitions = new Map(ir.root.nodes.map(node => [node.id, node]));
  const order = actionOrder(root);
  if (order.length !== ir.root.nodes.length || order.some((id, index) => id !== ir.root.nodes[index]?.id) || new Set(order).size !== order.length)
    issues.push("Control flow must own every declared action exactly once in source declaration order");
  let controlCount = 0;
  const checkReference = (ref: ReadReference, available: Set<string>, label: string) => {
    if (ref.source === "nodeOutput" && !available.has(ref.nodeId!)) issues.push(`${label} references unavailable branch-local or forward data`);
  };
  const visit = (block: ReadSequence, outer: Set<string>, depth: number): Set<string> => {
    if (depth > 8) { issues.push("Control flow exceeds eight nested scopes"); return new Set(outer); }
    const available = new Set(outer);
    for (const node of block.nodes) {
      if (node.kind === "action") {
        const action = definitions.get(node.nodeId);
        if (!action) { issues.push("Control flow references an unknown action"); continue; }
        scopes.set(node.nodeId, new Set(available));
        for (const ref of references(action.inputs)) checkReference(ref, available, `Step ${node.nodeId}`);
        available.add(node.nodeId);
      } else {
        scopes.set(node.id, new Set(available));
        if (++controlCount > 100 || seen.has(node.id)) issues.push("Conditions require unique IDs and at most 100 nodes");
        seen.add(node.id);
        if (node.kind === "return") {
          for (const ref of references(node.output.value)) checkReference(ref, available, `Return ${node.id}`);
          checkBinding(node.output.value, node.output.schema, `Return ${node.id}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : outputSchemas.get(ref.nodeId!), ref.path));
          // Following declarations are still verified; runtime completion must
          // prove they were explicitly skipped after the committed return.
          continue;
        }
        if (node.predicate.kind === "ref") {
          checkReference(node.predicate, available, `Condition ${node.id}`);
          let schema = node.predicate.source === "workflowInput" ? ir.inputSchema : outputSchemas.get(node.predicate.nodeId!);
          for (const part of node.predicate.path) schema = schema?.type === "array" && /^(0|[1-9][0-9]*)$/.test(part) ? schema.items as Record<string, unknown> : (schema?.properties as Record<string, Record<string, unknown>>)?.[part];
          if (schema && schema.type !== "boolean") issues.push(`Condition ${node.id} requires a boolean predicate, not implicit conversion`);
        }
        const thenAvailable = visit(node.then, available, depth + 1), elseAvailable = visit(node.else, available, depth + 1);
        branchScopes.set(node.id, { then: thenAvailable, else: elseAvailable });
        if (node.merge) {
          for (const [branch, branchAvailable] of [["then", thenAvailable], ["else", elseAvailable]] as const) {
            for (const ref of references(node.merge[branch])) checkReference(ref, branchAvailable ?? new Set(), `Merge ${node.id} ${branch}`);
            checkBinding(node.merge[branch], node.merge.schema, `Merge ${node.id} ${branch}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : outputSchemas.get(ref.nodeId!), ref.path));
          }
          available.add(node.id);
        }
      }
    }
    return available;
  };
  visit(root, new Set(), 0);
  return { issues: [...new Set(issues)], scopes, branchScopes };
}

export type ReadValueReceipt = { kind: "merge" | "return"; status: "DONE" | "FAILED"; stepIndex: number; completedAt: string };
export type ReadSkipReason = { kind: "branch"; conditionId: string; selected: "then" | "else" } | { kind: "return"; returnId: string };
/** A value boundary may not jump over an earlier decision, merge, return or
 * action. This is a denial-only check over committed evidence, not execution. */
export function assertReadValueBoundary(root: ReadSequence, nodeId: string, kind: "merge" | "return", decisions: Record<string, { status: string; selected?: "then" | "else" }>, attempts: Record<string, { status: string }>, values: Record<string, { kind: string; status: string }>) {
  let found = false;
  const requireValue = (id: string, expected: string) => { if (values[id]?.kind !== expected || values[id]?.status !== "DONE") throw new Error("Earlier typed value is not confirmed"); };
  const visit = (block: ReadSequence): void => {
    for (const node of block.nodes) {
      if (found) return;
      if (node.kind === "action") { if (attempts[node.nodeId]?.status !== "DONE") throw new Error("Earlier selected read is not confirmed"); }
      else if (node.kind === "return") {
        if (node.id === nodeId && kind === "return") { found = true; return; }
        throw new Error("Value boundary follows an earlier return");
      } else {
        const decision = decisions[node.id];
        if (decision?.status !== "DONE" || !["then", "else"].includes(decision.selected ?? "")) throw new Error("Earlier condition is not confirmed");
        visit(node[decision.selected!]); if (found) return;
        if (actionOrder(node[decision.selected === "then" ? "else" : "then"]).some(id => attempts[id]?.status !== "SKIPPED")) throw new Error("Unselected branch is not checkpointed");
        if (node.merge) {
          if (node.id === nodeId && kind === "merge") { found = true; return; }
          requireValue(node.id, "merge");
        }
      }
    }
  };
  visit(root); if (!found) throw new Error("Value boundary is not on the confirmed path");
}
export function readFlowOutcomes(root: ReadSequence, decisions: Record<string, { status: string; selected?: "then" | "else" }>, values: Record<string, { kind: string; status: string }> = {}) {
  const visited = new Set<string>(), selected = new Set<string>(), valueIDs = new Set<string>(), skipped = new Map<string, ReadSkipReason>();
  const skip = (block: ReadSequence, reason: ReadSkipReason) => { for (const id of actionOrder(block)) skipped.set(id, reason); };
  const value = (id: string, kind: string) => {
    if (values[id]?.kind !== kind || values[id]?.status !== "DONE") throw new Error("Typed value lacks a confirmed checkpoint");
    valueIDs.add(id);
  };
  const visit = (block: ReadSequence, returned?: string): string | undefined => {
    for (const node of block.nodes) {
      if (returned) { skip({ kind: "sequence", nodes: [node] }, { kind: "return", returnId: returned }); continue; }
      if (node.kind === "action") selected.add(node.nodeId);
      else if (node.kind === "return") { value(node.id, "return"); returned = node.id; }
      else {
        const receipt = decisions[node.id];
        if (!receipt || receipt.status !== "DONE" || !["then", "else"].includes(receipt.selected ?? "")) throw new Error("Condition lacks a confirmed decision");
        visited.add(node.id);
        returned = visit(node[receipt.selected!]);
        skip(node[receipt.selected === "then" ? "else" : "then"], { kind: "branch", conditionId: node.id, selected: receipt.selected! });
        if (!returned && node.merge) value(node.id, "merge");
      }
    }
    return returned;
  };
  const returned = visit(root);
  return { visited, selected, valueIDs, skipped, returned };
}
export function assertReadFlowCompletion(root: ReadSequence, decisions: Record<string, { status: string; selected?: "then" | "else" }>, attempts: Record<string, { status: string }>, values: Record<string, { kind: string; status: string }> = {}) {
  const { visited, selected, valueIDs } = readFlowOutcomes(root, decisions, values);
  const declared = actionOrder(root);
  if (Object.keys(decisions).some(id => !visited.has(id)) || Object.keys(values).some(id => !valueIDs.has(id)) || Object.keys(attempts).some(id => !declared.includes(id)) || declared.some(id => attempts[id]?.status !== (selected.has(id) ? "DONE" : "SKIPPED")))
    throw new Error("Confirmed node outcomes do not match the selected control path");
}
export function controlPoint(root: ReadSequence, nodeId: string, afterBranches = false): number {
  let cursor = 0, result: number | undefined;
  const visit = (block: ReadSequence) => {
    for (const node of block.nodes) {
      const id = node.kind === "action" ? node.nodeId : node.id;
      if (id === nodeId && !afterBranches) result = cursor;
      if (node.kind === "action") cursor++;
      else if (node.kind === "if") { visit(node.then); visit(node.else); }
      if (id === nodeId && afterBranches) result = cursor;
    }
  };
  visit(root); if (result === undefined) throw new Error("Unknown structural checkpoint"); return result;
}
