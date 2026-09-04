import { resolveReadBinding, type CompiledReadPlan, type ReadBinding } from "./compiled-read.js";
import { actionOrder, type ReadSequence, type ReadSkipReason } from "./read-control-flow.js";
import { validateToolInput } from "../tools/tool-input-schema.js";

type Action = CompiledReadPlan["ir"]["root"]["nodes"][number];
export type ReadInterpreterDriver = {
  beforeNode?(): void;
  action(node: Action, index: number): Promise<unknown>;
  condition(index: number, id: string, value: boolean | undefined): Promise<void>;
  skipped(index: number, id: string, reason: ReadSkipReason): Promise<void>;
  value(index: number, id: string, kind: "merge" | "return", value: unknown, valid: boolean): Promise<{ value: unknown } | undefined>;
};

/** Shared deterministic semantics only. Drivers own business dispatch or
 * fixture evaluation; this module has no repository, SDK, provider or network. */
export async function interpretReadPlan(plan: CompiledReadPlan, state: Record<string, unknown>, driver: ReadInterpreterDriver): Promise<void> {
  const definitions = new Map(plan.ir.root.nodes.map((node, index) => [node.id, { node, index }]));
  let cursor = 0;
  const skip = async (block: ReadSequence, reason: ReadSkipReason) => {
    for (const id of actionOrder(block)) {
      driver.beforeNode?.();
      const definition = definitions.get(id);
      if (!definition || cursor !== definition.index) throw new Error("Compiled skip order changed");
      await driver.skipped(cursor, id, reason); cursor++;
    }
  };
  const typed = async (id: string, kind: "merge" | "return", binding: ReadBinding, schema: Record<string, unknown>) => {
    let value: unknown, valid = false;
    try { value = resolveReadBinding(binding, state); valid = validateToolInput(schema, value).length === 0; } catch { /* Missing is not a default. */ }
    const output = await driver.value(cursor, id, kind, value, valid);
    if (!valid || !output) throw new Error(`Typed ${kind} ${id} failed; no dependent dispatch or implicit default`);
    return output;
  };
  const visit = async (block: ReadSequence): Promise<string | undefined> => {
    let returned: string | undefined;
    for (const node of block.nodes) {
      driver.beforeNode?.();
      if (returned) { await skip({ kind: "sequence", nodes: [node] }, { kind: "return", returnId: returned }); continue; }
      if (node.kind === "action") {
        const definition = definitions.get(node.nodeId);
        if (!definition || cursor !== definition.index) throw new Error("Compiled action order changed");
        state[node.nodeId] = await driver.action(definition.node, cursor); cursor++; continue;
      }
      if (node.kind === "return") { await typed(node.id, "return", node.output.value, node.output.schema); returned = node.id; continue; }
      let predicate: unknown;
      try { predicate = resolveReadBinding(node.predicate, state); } catch { /* Missing is not false. */ }
      if (typeof predicate !== "boolean") {
        await driver.condition(cursor, node.id, undefined);
        throw new Error(`Condition ${node.id} failed: predicate requires a present boolean; no implicit branch or tool dispatch`);
      }
      await driver.condition(cursor, node.id, predicate);
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
