import { resolveReadBinding, type CompiledReadPlan, type ReadBinding } from "./compiled-read.js";
import { actionOrder, assertNoProtectedScopes, type ReadSequence, type ReadControlNode, type ReadSkipReason } from "./read-control-flow.js";
import { type ReadVisit, type ReadIteration, ReadCollectionFailure } from "./read-interpreter.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { ReadValueBudget } from "./read-value-budget.js";

type Condition = Extract<ReadControlNode, { kind: "if" }>;
type Collection = Extract<ReadControlNode, { kind: "foreach" }>;
export type ReadMachinePoint = { kind: "action" | "condition" | "skip" | "merge" | "return" | "collection-item" | "collection"; nodeId: string; sourceIndex: number; visit: ReadVisit;
  valid: boolean; arguments?: Record<string, unknown>; value?: unknown; selected?: "then" | "else"; reason?: ReadSkipReason; count?: number; phase?: "start" | "complete" };
type SequenceFrame = { kind: "sequence"; block: number; index: number; returned?: string };
type ConditionFrame = { kind: "if"; id: string; phase: "predicate" | "selected" | "skip" | "merge" | "finish"; selected?: "then" | "else"; outer: string[]; returned?: string; merged?: { value: unknown } };
type CollectionFrame = { kind: "foreach"; id: string; phase: "start" | "item" | "body" | "collect" | "complete" | "finish"; start: number; end: number; outer: string[];
  items?: unknown[]; index: number; collected: unknown[]; budget: { bytes: number; nodes: number }; output?: { value: unknown } };
type SkipFrame = { kind: "skip"; ids: string[]; index: number; reason: ReadSkipReason };
type Frame = SequenceFrame | ConditionFrame | CollectionFrame | SkipFrame;
export type ReadMachineSnapshot = { profile: "read-machine/v1"; sourceHash: string; semanticHash: string; cursor: number; visits: number;
  values: Record<string, unknown>; iterations: ReadIteration[]; frames: Frame[]; pending?: ReadMachinePoint; done: boolean };

/** Pure resumable semantics; a snapshot is DATA, not authority. Durable callers
 * must authenticate it against the run and committed evidence before restore.
 * No SDK/repository/network, and no replay of earlier bindings after restore. */
export class ReadMachine {
  readonly #plan: CompiledReadPlan;
  readonly #blocks: ReadSequence[] = [];
  readonly #blockIDs = new Map<ReadSequence, number>();
  readonly #nodes = new Map<string, Exclude<ReadControlNode, { kind: "action" }>>();
  readonly #actions: Map<string, { node: CompiledReadPlan["ir"]["root"]["nodes"][number]; index: number }>;
  #state: ReadMachineSnapshot;
  constructor(plan: CompiledReadPlan, input: Record<string, unknown>, checkpoint?: ReadMachineSnapshot) {
    if (plan.ir.flow) assertNoProtectedScopes(plan.ir.flow);
    this.#plan = structuredClone(plan); this.#actions = new Map(this.#plan.ir.root.nodes.map((node, index) => [node.id, { node, index }]));
    const root = this.#plan.ir.flow ?? { kind: "sequence" as const, nodes: this.#plan.ir.root.nodes.map(node => ({ kind: "action" as const, nodeId: node.id })) };
    const register = (block: ReadSequence) => {
      this.#blockIDs.set(block, this.#blocks.length); this.#blocks.push(block);
      for (const node of block.nodes) if (node.kind !== "action") { this.#nodes.set(node.id, node); if (node.kind === "if") { register(node.then); register(node.else); } else if (node.kind === "foreach") register(node.body); }
    }; register(root);
    this.#state = checkpoint ? structuredClone(checkpoint) : { profile: "read-machine/v1", sourceHash: plan.sourceHash, semanticHash: plan.semanticHash, cursor: 0, visits: 0,
      values: { input: structuredClone(input) }, iterations: [], frames: [{ kind: "sequence", block: 0, index: 0 }], done: false };
    const saved = this.#state;
    if (saved.profile !== "read-machine/v1" || saved.sourceHash !== plan.sourceHash || saved.semanticHash !== plan.semanticHash || !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 || saved.cursor > plan.ir.root.nodes.length ||
        !Number.isSafeInteger(saved.visits) || saved.visits < 0 || saved.visits > 5000 || !Array.isArray(saved.frames) || saved.frames.length > 40 || !Array.isArray(saved.iterations) || saved.iterations.length > 8 ||
        !saved.values || Array.isArray(saved.values) || typeof saved.values !== "object" || typeof saved.done !== "boolean") throw new Error("Invalid read machine checkpoint identity or bounds");
    const address = (id: string, frames: readonly ReadIteration[]) => [...frames.flatMap(frame => [frame.loopId, String(frame.index)]), id].join("/");
    if (!Object.hasOwn(saved.values, "input") || saved.iterations.some(frame => !frame || this.#nodes.get(frame.loopId)?.kind !== "foreach" || !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index >= (this.#nodes.get(frame.loopId) as Collection).maxItems) || new Set(saved.iterations.map(frame => frame.loopId)).size !== saved.iterations.length) throw new Error("Invalid read machine iteration scope");
    for (const frame of saved.frames) {
      if (!frame || typeof frame !== "object") throw new Error("Invalid read machine frame");
      if (frame.kind === "sequence") { if (!Number.isSafeInteger(frame.block) || !this.#blocks[frame.block] || !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index > this.#blocks[frame.block]!.nodes.length) throw new Error("Invalid read machine block position"); }
      else if (frame.kind === "if" || frame.kind === "foreach") {
        if (this.#nodes.get(frame.id)?.kind !== frame.kind || !Array.isArray(frame.outer) || frame.outer.some(key => typeof key !== "string") || new Set(frame.outer).size !== frame.outer.length) throw new Error("Invalid read machine owner");
        if (frame.kind === "if") { if (!["predicate", "selected", "skip", "merge", "finish"].includes(frame.phase) || frame.phase !== "predicate" && !["then", "else"].includes(frame.selected!)) throw new Error("Invalid read machine condition phase"); }
        else {
          const node = this.#nodes.get(frame.id) as Collection;
          if (!["start", "item", "body", "collect", "complete", "finish"].includes(frame.phase) || !Number.isSafeInteger(frame.start) || frame.start < 0 || !Number.isSafeInteger(frame.end) || frame.end !== frame.start + actionOrder(node.body).length || frame.end > plan.ir.root.nodes.length || !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index > node.maxItems || !Array.isArray(frame.collected) || frame.collected.length !== frame.index || frame.phase !== "start" && (!Array.isArray(frame.items) || frame.items.length > node.maxItems || frame.index > frame.items.length)) throw new Error("Invalid read machine collection position");
          if (!frame.budget) throw new Error("Missing read machine aggregate budget"); new ReadValueBudget(frame.budget);
        }
      } else if (frame.kind === "skip") { if (!Array.isArray(frame.ids) || frame.ids.some(id => !this.#actions.has(id)) || !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index > frame.ids.length || !frame.reason || !["branch", "return", "empty-collection"].includes(frame.reason.kind)) throw new Error("Invalid read machine skip position"); }
      else throw new Error("Invalid read machine frame");
    }
    if (saved.pending && (!saved.frames.length || !["action", "condition", "skip", "merge", "return", "collection-item", "collection"].includes(saved.pending.kind) || typeof saved.pending.valid !== "boolean" || saved.pending.sourceIndex !== saved.cursor || !saved.pending.visit || saved.pending.visit.invocationId !== address(saved.pending.nodeId, saved.iterations) || JSON.stringify(saved.pending.visit.iterations) !== JSON.stringify(saved.iterations) || !this.#actions.has(saved.pending.nodeId) && !this.#nodes.has(saved.pending.nodeId))) throw new Error("Invalid read machine pending boundary");
    if (saved.done && (saved.frames.length || saved.pending || saved.cursor !== plan.ir.root.nodes.length)) throw new Error("Incomplete read machine cannot be terminal");
  }
  snapshot(): ReadMachineSnapshot { return structuredClone(this.#state); }
  fork(): ReadMachine { return new ReadMachine(this.#plan, {}, this.#state); }
  private before() { if (++this.#state.visits > 5000) throw new ReadCollectionFailure("COLLECTION_VISIT_LIMIT"); }
  private location(id: string): ReadVisit { const iterations = this.#state.iterations.map(frame => ({ ...frame })); return { invocationId: [...iterations.flatMap(frame => [frame.loopId, String(frame.index)]), id].join("/"), iterations }; }
  private resolve(binding: ReadBinding): unknown { return resolveReadBinding(binding, this.#state.values); }
  private point(point: Omit<ReadMachinePoint, "sourceIndex" | "visit">): ReadMachinePoint {
    const value = { ...point, sourceIndex: this.#state.cursor, visit: this.location(point.nodeId) }; this.#state.pending = value; return structuredClone(value);
  }
  private typed(id: string, kind: "merge" | "return" | "collection-item", binding: ReadBinding, schema: Record<string, unknown>) {
    let value: unknown, valid = false; try { value = this.resolve(binding); valid = !validateToolInput(schema, value).length; } catch { /* Missing is not a default. */ }
    return this.point({ kind, nodeId: id, valid, ...(value === undefined ? {} : { value }) });
  }
  private sequence(block: ReadSequence) { this.#state.frames.push({ kind: "sequence", block: this.#blockIDs.get(block)!, index: 0 }); }
  private skip(block: ReadSequence, reason: ReadSkipReason) { this.#state.frames.push({ kind: "skip", ids: actionOrder(block), index: 0, reason }); }
  private cleanup(outer: string[]) { const keep = new Set(outer); for (const key of Object.keys(this.#state.values)) if (!keep.has(key)) delete this.#state.values[key]; }
  private popSequence(frame: SequenceFrame) {
    this.#state.frames.pop(); const parent = this.#state.frames.at(-1);
    if (parent?.kind === "if") { if (frame.returned) parent.returned = frame.returned; parent.phase = parent.selected === "then" ? "skip" : "merge"; }
    else if (parent?.kind === "foreach") { if (frame.returned || this.#state.cursor !== parent.end) throw new Error("Collection body did not complete its declared scope"); parent.phase = "collect"; }
  }
  peek(): ReadMachinePoint | null {
    if (this.#state.pending) return structuredClone(this.#state.pending);
    for (let transitions = 0; transitions < 40_000; transitions++) {
      const frame = this.#state.frames.at(-1);
      if (!frame) { if (this.#state.cursor !== this.#plan.ir.root.nodes.length) throw new Error("Compiled machine did not account for every action"); this.#state.done = true; return null; }
      if (frame.kind === "sequence") {
        const block = this.#blocks[frame.block]!;
        if (frame.index === block.nodes.length) { this.popSequence(frame); continue; }
        const node = block.nodes[frame.index++]!; this.before();
        if (frame.returned) { this.skip({ kind: "sequence", nodes: [node] }, { kind: "return", returnId: frame.returned }); continue; }
        if (node.kind === "action") {
          const action = this.#actions.get(node.nodeId); if (!action || action.index !== this.#state.cursor) throw new Error("Compiled machine action order changed");
          let args: Record<string, unknown> | undefined; try { args = this.resolve(action.node.inputs) as Record<string, unknown>; } catch { /* Driver records invalid arguments. */ }
          return this.point({ kind: "action", nodeId: node.nodeId, valid: !!args, ...(args ? { arguments: args } : {}) });
        }
        if (node.kind === "return") return this.typed(node.id, "return", node.output.value, node.output.schema);
        if (node.kind === "if") { this.#state.frames.push({ kind: "if", id: node.id, phase: "predicate", outer: Object.keys(this.#state.values) }); continue; }
        this.#state.frames.push({ kind: "foreach", id: node.id, phase: "start", start: this.#state.cursor, end: this.#state.cursor + actionOrder(node.body).length,
          outer: Object.keys(this.#state.values), index: 0, collected: [], budget: { bytes: 0, nodes: 0 } }); continue;
      }
      if (frame.kind === "skip") {
        if (frame.index === frame.ids.length) { this.#state.frames.pop(); const parent = this.#state.frames.at(-1);
          if (parent?.kind === "if") parent.phase = parent.selected === "then" ? "merge" : "selected";
          else if (parent?.kind === "foreach") parent.phase = "complete"; continue; }
        this.before(); const id = frame.ids[frame.index]!, action = this.#actions.get(id);
        if (!action || action.index !== this.#state.cursor) throw new Error("Compiled machine skip order changed");
        return this.point({ kind: "skip", nodeId: id, reason: frame.reason, valid: true });
      }
      if (frame.kind === "if") {
        const node = this.#nodes.get(frame.id) as Condition;
        if (frame.phase === "predicate") {
          let value: unknown; try { value = this.resolve(node.predicate); } catch { /* Missing is not false. */ }
          return this.point({ kind: "condition", nodeId: node.id, valid: typeof value === "boolean", ...(typeof value === "boolean" ? { selected: value ? "then" : "else" } : {}) });
        }
        if (frame.phase === "selected") { this.sequence(frame.selected === "then" ? node.then : node.else); continue; }
        if (frame.phase === "skip") { this.skip(frame.selected === "then" ? node.else : node.then, { kind: "branch", conditionId: node.id, selected: frame.selected! }); continue; }
        if (frame.phase === "merge") { if (!frame.returned && node.merge) return this.typed(node.id, "merge", node.merge[frame.selected!], node.merge.schema); frame.phase = "finish"; continue; }
        if (frame.phase !== "finish") throw new Error("Invalid conditional continuation phase");
        this.cleanup(frame.outer); if (frame.merged) this.#state.values[node.id] = frame.merged; this.#state.frames.pop();
        const parent = this.#state.frames.at(-1); if (frame.returned && parent?.kind === "sequence") parent.returned = frame.returned; continue;
      }
      const node = this.#nodes.get(frame.id) as Collection;
      if (frame.phase === "start") {
        let items: unknown, valid = false; try { items = this.resolve(node.items.value); valid = Array.isArray(items) && !validateToolInput(node.items.schema, items).length; } catch { /* Missing is not an empty collection. */ }
        const count = Array.isArray(items) ? items.length : undefined; if (valid) frame.items = items as unknown[];
        return this.point({ kind: "collection", nodeId: node.id, phase: "start", valid: valid && count! <= node.maxItems, ...(count === undefined ? {} : { count }), ...(valid ? { value: items } : {}) });
      }
      if (frame.phase === "item") {
        if (frame.index === frame.items!.length) { frame.phase = "complete"; continue; }
        this.before(); this.#state.cursor = frame.start; this.#state.iterations.push({ loopId: node.id, index: frame.index });
        this.#state.values[node.id] = { item: frame.items![frame.index], index: frame.index }; frame.phase = "body"; this.sequence(node.body); continue;
      }
      if (frame.phase === "collect") return this.typed(node.id, "collection-item", node.collect.value, node.collect.schema);
      if (frame.phase === "complete") { this.#state.cursor = frame.end; return this.point({ kind: "collection", nodeId: node.id, phase: "complete", valid: true, value: frame.collected }); }
      if (frame.phase !== "finish") throw new Error("Invalid collection continuation phase");
      this.#state.values[node.id] = frame.output!; this.#state.frames.pop();
    }
    throw new Error("Read machine exceeded bounded internal transitions");
  }
  /** Advance only after the caller confirms the corresponding saved result.
   * Invalid or missing points are never accepted as implicit completion. */
  accept(output?: unknown): void {
    const point = this.#state.pending, frame = this.#state.frames.at(-1);
    if (!point || !point.valid || !frame) throw new Error("No valid pending read machine point");
    if (point.kind === "action") { if (frame.kind !== "sequence") throw new Error("Invalid action continuation owner"); this.#state.values[point.nodeId] = structuredClone(output); this.#state.cursor++; }
    else if (point.kind === "skip") { if (frame.kind !== "skip") throw new Error("Invalid skip continuation owner"); frame.index++; this.#state.cursor++; }
    else if (point.kind === "condition") { if (frame.kind !== "if" || !point.selected) throw new Error("Invalid condition continuation owner"); frame.selected = point.selected; frame.phase = point.selected === "then" ? "selected" : "skip"; }
    else if (point.kind === "collection" && point.phase === "start") {
      if (frame.kind !== "foreach" || !frame.items) throw new Error("Invalid collection start continuation");
      frame.phase = "item"; if (!frame.items.length) this.skip((this.#nodes.get(frame.id) as Collection).body, { kind: "empty-collection", loopId: frame.id });
    } else {
      if (!output || typeof output !== "object" || !Object.hasOwn(output, "value")) throw new Error("Typed continuation needs its exact value envelope");
      const typed = structuredClone(output) as { value: unknown };
      if (point.kind === "return") { if (frame.kind !== "sequence") throw new Error("Invalid return continuation owner"); frame.returned = point.nodeId; }
      else if (point.kind === "merge") { if (frame.kind !== "if") throw new Error("Invalid merge continuation owner"); frame.merged = typed; frame.phase = "finish"; }
      else if (point.kind === "collection-item") {
        if (frame.kind !== "foreach") throw new Error("Invalid item continuation owner"); const budget = new ReadValueBudget(frame.budget); frame.collected.push(budget.clone(typed.value, 1)); frame.budget = budget.checkpoint();
        this.#state.iterations.pop(); this.cleanup(frame.outer); frame.index++; frame.phase = "item";
      } else if (point.kind === "collection") { if (frame.kind !== "foreach") throw new Error("Invalid aggregate continuation owner"); frame.output = typed; frame.phase = "finish"; }
      else throw new Error("Invalid typed continuation kind");
    }
    delete this.#state.pending;
  }
}
