import { resolveReadBinding, type CompiledReadPlan, type ReadBinding } from "./compiled-read.js";
import { actionOrder, assertNoProtectedScopes, type ReadSequence, type ReadSkipReason } from "./read-control-flow.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { ReadValueBudget } from "./read-value-budget.js";

type Action = CompiledReadPlan["ir"]["root"]["nodes"][number];
export type ReadIteration = { loopId: string; index: number };
export type ReadVisit = { invocationId: string; iterations: readonly ReadIteration[] };
export type ReadValueKind = "merge" | "return" | "collection-item" | "collection";
export class ReadCollectionFailure extends Error { constructor(readonly code: "COLLECTION_INPUT_INVALID" | "COLLECTION_LIMIT_EXCEEDED" | "COLLECTION_VISIT_LIMIT") { super(code); } }
export type ReadInterpreterDriver = {
  beforeNode?(): void;
  action(node: Action, index: number, visit: ReadVisit): Promise<unknown>;
  condition(index: number, id: string, value: boolean | undefined, visit: ReadVisit): Promise<void>;
  skipped(index: number, id: string, reason: ReadSkipReason, visit: ReadVisit): Promise<void>;
  value(index: number, id: string, kind: ReadValueKind, value: unknown, valid: boolean, visit: ReadVisit): Promise<{ value: unknown } | undefined>;
  collectionStarted?(index: number, id: string, count: number | undefined, valid: boolean, visit: ReadVisit): Promise<void>;
};

/** Shared deterministic semantics only. Drivers own business dispatch or
 * fixture evaluation; this module has no repository, SDK, provider or network. */
export async function interpretReadPlan(plan: CompiledReadPlan, state: Record<string, unknown>, driver: ReadInterpreterDriver): Promise<void> {
  if (plan.ir.flow) assertNoProtectedScopes(plan.ir.flow);
  const definitions = new Map(plan.ir.root.nodes.map((node, index) => [node.id, { node, index }]));
  let cursor = 0, visits = 0;
  let iterations: ReadIteration[] = [];
  const location = (id: string): ReadVisit => ({ invocationId: [...iterations.flatMap(item => [item.loopId, String(item.index)]), id].join("/"), iterations: iterations.map(item => ({ ...item })) });
  const before = () => { if (++visits > 5000) throw new ReadCollectionFailure("COLLECTION_VISIT_LIMIT"); driver.beforeNode?.(); };
  const skip = async (block: ReadSequence, reason: ReadSkipReason) => {
    for (const id of actionOrder(block)) {
      before();
      const definition = definitions.get(id);
      if (!definition || cursor !== definition.index) throw new Error("Compiled skip order changed");
      await driver.skipped(cursor, id, reason, location(id)); cursor++;
    }
  };
  const typed = async (id: string, kind: ReadValueKind, binding: ReadBinding, schema: Record<string, unknown>) => {
    let value: unknown, valid = false;
    try { value = resolveReadBinding(binding, state); valid = validateToolInput(schema, value).length === 0; } catch { /* Missing is not a default. */ }
    const output = await driver.value(cursor, id, kind, value, valid, location(id));
    if (!valid || !output) throw new Error(`Typed ${kind} ${id} failed; no dependent dispatch or implicit default`);
    return output;
  };
  const visit = async (block: ReadSequence): Promise<string | undefined> => {
    let returned: string | undefined;
    for (const node of block.nodes) {
      before();
      if (returned) { await skip({ kind: "sequence", nodes: [node] }, { kind: "return", returnId: returned }); continue; }
      if (node.kind === "action") {
        const definition = definitions.get(node.nodeId);
        if (!definition || cursor !== definition.index) throw new Error("Compiled action order changed");
        state[node.nodeId] = await driver.action(definition.node, cursor, location(node.nodeId)); cursor++; continue;
      }
      if (node.kind === "return") { await typed(node.id, "return", node.output.value, node.output.schema); returned = node.id; continue; }
      if (node.kind === "foreach") {
        if (!driver.collectionStarted) throw new Error("Collection interpretation requires an explicit iteration driver");
        let items: unknown, valid = false;
        try { items = resolveReadBinding(node.items.value, state); valid = Array.isArray(items) && validateToolInput(node.items.schema, items).length === 0; } catch { /* Missing is not an empty list. */ }
        const count = Array.isArray(items) ? items.length : undefined;
        await driver.collectionStarted(cursor, node.id, count, valid && count! <= node.maxItems, location(node.id));
        if (!valid) throw new ReadCollectionFailure("COLLECTION_INPUT_INVALID");
        if (count! > node.maxItems) throw new ReadCollectionFailure("COLLECTION_LIMIT_EXCEEDED");
        const outer = new Set(Object.keys(state)), start = cursor, end = start + actionOrder(node.body).length;
        const collected: unknown[] = [], aggregateBudget = new ReadValueBudget();
        if (!count) await skip(node.body, { kind: "empty-collection", loopId: node.id });
        for (let index = 0; index < count!; index++) {
          before(); cursor = start; iterations.push({ loopId: node.id, index });
          state[node.id] = { item: (items as unknown[])[index], index };
          try {
            const returned = await visit(node.body);
            if (returned || cursor !== end) throw new Error("Collection body did not complete its declared scope");
            const value = await typed(node.id, "collection-item", node.collect.value, node.collect.schema);
            collected.push(aggregateBudget.clone(value.value, 1));
          } finally {
            iterations.pop(); for (const key of Object.keys(state)) if (!outer.has(key)) delete state[key];
          }
        }
        cursor = end;
        const output = await driver.value(cursor, node.id, "collection", collected, true, location(node.id));
        if (!output) throw new Error("Collection output was not accepted");
        state[node.id] = output; continue;
      }
      if (node.kind !== "if") throw new Error("Unsupported read control primitive");
      let predicate: unknown;
      try { predicate = resolveReadBinding(node.predicate, state); } catch { /* Missing is not false. */ }
      if (typeof predicate !== "boolean") {
        await driver.condition(cursor, node.id, undefined, location(node.id));
        throw new Error(`Condition ${node.id} failed: predicate requires a present boolean; no implicit branch or tool dispatch`);
      }
      await driver.condition(cursor, node.id, predicate, location(node.id));
      const outer = new Set(Object.keys(state)), selected = predicate ? "then" : "else";
      if (predicate) { returned = await visit(node.then); await skip(node.else, { kind: "branch", conditionId: node.id, selected }); }
      else { await skip(node.then, { kind: "branch", conditionId: node.id, selected }); returned = await visit(node.else); }
      const merged = !returned && node.merge ? await typed(node.id, "merge", node.merge[selected], node.merge.schema) : undefined;
      for (const key of Object.keys(state)) if (!outer.has(key)) delete state[key];
      if (merged) state[node.id] = merged;
    }
    return returned;
  };
  await visit(plan.ir.flow ?? { kind: "sequence", nodes: plan.ir.root.nodes.map(node => ({ kind: "action", nodeId: node.id })) });
  if (cursor !== plan.ir.root.nodes.length) throw new Error("Compiled interpreter did not account for every action");
}
