import { createHash } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { resolveReadBinding, type ReadBinding } from "./compiled-read.js";
import { actionOrder, childSequences, parseReadControlFlow, structuralNodes, type ReadSequence } from "./read-control-flow.js";
import { readBindingSchema } from "./read-values.js";
import { ReadValueBudget } from "./read-value-budget.js";
import { validateToolInput, validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { ScopedInvocationIndex } from "./scoped-invocation.js";
import { protectedMachineSnapshotSchema, type ProtectedMachinePlan, type ProtectedMachineSnapshot, type ProtectedMachinePoint,
  type ProtectedMachineFrame, type ProtectedMachineResult, type ProtectedMachineFault, type ProtectedMachineSkip, type StructuralMachineNode } from "./protected-machine-state.js";

const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
/** Bound before recursive decoding; finite JSON only, never an opaque object
 * or caller-provided function. The final journal will authenticate this DATA. */
export function boundProtectedMachineJSON(value: unknown): void {
  let count = 0; const active = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (++count > 131072 || depth > 64) throw new Error("Protected machine data exceeds structural bounds");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || active.has(item) || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new Error("Protected machine data must be finite JSON");
    if (Object.getOwnPropertySymbols(item).length || Array.isArray(item) && Object.keys(item).length !== item.length)
      throw new Error("Protected machine data cannot contain symbols or sparse arrays");
    active.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor) || key.length > 16384 ||
          Array.isArray(item) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw new Error("Protected machine data cannot invoke accessors or lose fields");
      visit(descriptor.value, depth + 1);
    }
    active.delete(item);
  };
  visit(value, 0);
  if (canonicalJSONBytes(value).length > 4000000) throw new Error("Protected machine data exceeds byte bounds");
}

/** Non-authorizing pure semantics plan; never a publication or operation IR.
 * Tool/model schemas, review, classification and dispatch stay with the future
 * separately versioned compiler/worker. Source hashes are immutable identity. */
export function protectedMachinePlan(sourceHash: string, flow: ReadSequence, actions: ProtectedMachinePlan["actions"], inputSchema?: Record<string, unknown>): ProtectedMachinePlan {
  boundProtectedMachineJSON({ sourceHash, flow, actions, ...(inputSchema ? { inputSchema } : {}) });
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceHash)) throw new Error("Protected machine requires an exact source identity");
  const root = parseReadControlFlow({ schemaVersion: "read-control-flow/v4", root: flow }).root;
  new ScopedInvocationIndex(root);
  if (structuralNodes(root).length > 100) throw new Error("Protected machine exceeds structural node bounds");
  const order = actionOrder(root);
  if (actions.length > 200 || order.length !== actions.length || order.some((id, index) => actions[index]?.id !== id))
    throw new Error("Protected machine actions must retain exact source ownership and order");
  const visit = (block: ReadSequence, loopDepth: number, depth: number): number => {
    if (depth > 8) throw new Error("Protected machine exceeds eight authored scopes");
    return block.nodes.reduce((total, node) => {
      if (node.kind === "return" && loopDepth) throw new Error("Return in a collection body requires separate qualified semantics");
      const children = childSequences(node).reduce((sum, child) => sum + visit(child, loopDepth + (node.kind === "foreach" ? 1 : 0), depth + 1), 0);
      return total + 1 + (node.kind === "foreach" ? node.maxItems * (children + 1) : children);
    }, 0);
  };
  if (visit(root, 0, 0) > 2000) throw new Error("Protected machine exceeds declared visit budget");
  if (inputSchema && (inputSchema.type !== "object" || validateToolSchemaProfile(inputSchema).length)) throw new Error("Unsupported machine input schema");
  const body = { profile: "protected-machine-plan/v1" as const, flow: root,
    actions: actions.map(action => ({ id: action.id, input: readBindingSchema.parse(action.input) })), ...(inputSchema ? { inputSchema: structuredClone(inputSchema) } : {}) };
  return { ...body, sourceHash, semanticHash: `sha256:${createHash("sha256").update(canonicalJSONBytes(body)).digest("hex")}` };
}

/** Pure incremental continuation. Accept/fail means the caller has already
 * confirmed its exact saved boundary; these methods cannot establish that
 * evidence. Raw snapshots must never be restored from HTTP/model input. No
 * broker, repository, provider, approval, network or retry exists here. */
export class ProtectedMachine {
  readonly #plan: ProtectedMachinePlan;
  readonly #blocks: ReadSequence[] = [];
  readonly #blockIds = new Map<ReadSequence, number>();
  readonly #nodes = new Map<string, StructuralMachineNode>();
  readonly #actions: Map<string, ReadBinding>;
  readonly #ownership: ScopedInvocationIndex;
  readonly #loops = new Map<string, string[]>();
  #state: ProtectedMachineSnapshot;
  constructor(plan: ProtectedMachinePlan, input: Record<string, unknown>, checkpoint?: ProtectedMachineSnapshot) {
    boundProtectedMachineJSON(plan);
    const captured = protectedMachinePlan(plan.sourceHash, plan.flow, plan.actions, plan.inputSchema);
    if (plan.profile !== captured.profile || !same(plan, captured)) throw new Error("Protected machine plan identity or fields changed");
    this.#plan = captured; this.#ownership = new ScopedInvocationIndex(captured.flow);
    this.#actions = new Map(captured.actions.map(action => [action.id, action.input]));
    const register = (block: ReadSequence, loops: string[]) => {
      this.#blockIds.set(block, this.#blocks.length); this.#blocks.push(block);
      for (const node of block.nodes) {
        this.#loops.set(node.kind === "action" ? node.nodeId : node.id, loops);
        if (node.kind === "action") continue;
        this.#nodes.set(node.id, node);
        for (const child of childSequences(node)) register(child, node.kind === "foreach" ? [...loops, node.id] : loops);
      }
    }; register(captured.flow, []);
    boundProtectedMachineJSON(checkpoint ?? input);
    if (!checkpoint && (!input || Array.isArray(input) || typeof input !== "object" || captured.inputSchema && validateToolInput(captured.inputSchema, input).length))
      throw new Error("Protected machine input does not match its declared object contract");
    this.#state = checkpoint ? protectedMachineSnapshotSchema.parse(checkpoint) as ProtectedMachineSnapshot :
      { profile: "protected-machine/v1", sourceHash: captured.sourceHash, semanticHash: captured.semanticHash, sequence: 0, visits: 0,
        values: { input: new ReadValueBudget().clone(input, 0) }, iterations: [], frames: [{ kind: "sequence", block: 0, index: 0, result: {} }], status: "RUNNING" };
    this.validateSnapshot();
  }
  private validateSnapshot() {
    const state = this.#state;
    if (state.sourceHash !== this.#plan.sourceHash || state.semanticHash !== this.#plan.semanticHash || !Object.hasOwn(state.values, "input") ||
        !state.values.input || Array.isArray(state.values.input) || typeof state.values.input !== "object" ||
        this.#plan.inputSchema && validateToolInput(this.#plan.inputSchema, state.values.input).length ||
        Object.keys(state.values).some(id => id !== "input" && !this.#nodes.has(id) && !this.#actions.has(id)) ||
        state.status === "DONE" && (state.frames.length || state.pending || state.failure) || state.status === "FAILED" && (!state.failure || state.frames.length || state.pending) ||
        state.status === "RUNNING" && (!state.frames.length || state.failure)) throw new Error("Protected continuation identity or terminal state is inconsistent");
    const active: Array<{ loopId: string; index: number }> = [];
    for (const frame of state.frames) {
      if (frame.kind === "sequence") {
        if (!this.#blocks[frame.block] || frame.index > this.#blocks[frame.block]!.nodes.length) throw new Error("Protected continuation block position changed");
      } else if (frame.kind === "skip") {
        if (frame.index > frame.ids.length || frame.ids.some(id => !this.#actions.has(id))) throw new Error("Protected continuation skip position changed");
      } else {
        const node = this.#nodes.get(frame.id);
        if (node?.kind !== frame.kind || new Set(frame.outer).size !== frame.outer.length || frame.outer.some(id => !Object.hasOwn(state.values, id)))
          throw new Error("Protected continuation scope owner changed");
        if (frame.kind === "foreach") {
          if (node.kind !== "foreach" || frame.collected.length !== frame.index || frame.index > node.maxItems ||
              frame.items && (frame.items.length > node.maxItems || frame.index > frame.items.length) || frame.phase !== "start" && !frame.items)
            throw new Error("Protected continuation collection position changed");
          new ReadValueBudget(frame.budget);
          if (["body", "collect"].includes(frame.phase)) active.push({ loopId: frame.id, index: frame.index });
        }
        if (frame.kind === "if" && frame.phase !== "predicate" && !frame.selected) throw new Error("Protected continuation decision has no selected branch");
        if (frame.kind === "protect" && frame.handled !== Boolean(frame.selectedFault)) throw new Error("Protected continuation handler has no exact fault");
      }
    }
    if (!same(active, state.iterations)) throw new Error("Protected continuation iteration frames changed");
    if (state.pending) {
      const pending = state.pending;
      if (pending.sequence !== state.sequence || !same(pending.iterations, state.iterations) || pending.invocationId !== this.address(pending.nodeId) ||
          pending.scope !== (pending.kind === "skip" && this.#loops.get(pending.nodeId)?.length !== active.length ? "unentered-template" : "invocation"))
        throw new Error("Protected continuation pending boundary changed");
      if (pending.scope === "invocation") this.#ownership.resolve(pending.nodeId, pending.iterations, pending.kind === "collection-item");
      const owner = state.frames.at(-1)!;
      const phases: Partial<Record<ProtectedMachinePoint["kind"], string>> = { condition: "predicate", merge: "merge", "collection-start": "start",
        "collection-item": "collect", "collection-complete": pending.outcome === "FAILED" ? "finish" : "complete",
        "protected-start": "start", "protected-select": "select", "protected-complete": "complete" };
      if (pending.kind === "action" || pending.kind === "return") {
        const declaration = owner.kind === "sequence" ? this.#blocks[owner.block]!.nodes[owner.index - 1] : undefined;
        if (!declaration || (declaration.kind === "action" ? declaration.nodeId : declaration.id) !== pending.nodeId ||
            declaration.kind !== (pending.kind === "action" ? "action" : "return")) throw new Error("Pending action has no exact sequence owner");
      } else if (pending.kind === "skip") {
        if (owner.kind !== "skip" || owner.ids[owner.index] !== pending.nodeId || !same(owner.reason, pending.reason)) throw new Error("Pending skip has no exact template owner");
      } else if (owner.kind === "sequence" || owner.kind === "skip" || owner.id !== pending.nodeId || owner.phase !== phases[pending.kind])
        throw new Error("Pending control has no exact phase owner");
    }
  }
  snapshot(): ProtectedMachineSnapshot { boundProtectedMachineJSON(this.#state); return structuredClone(this.#state); }
  fork(): ProtectedMachine { return new ProtectedMachine(this.#plan, {}, this.snapshot()); }
  private before() { if (this.#state.visits >= 5000) throw new Error("Protected continuation exceeds visit bounds"); this.#state.visits++; }
  private address(id: string) { return [...this.#state.iterations.flatMap(frame => [frame.loopId, String(frame.index)]), id].join("/"); }
  private point(point: Omit<ProtectedMachinePoint, "invocationId" | "iterations" | "sequence" | "scope">) {
    const template = point.kind === "skip" && this.#loops.get(point.nodeId)!.length !== this.#state.iterations.length;
    if (!template) this.#ownership.resolve(point.nodeId, this.#state.iterations, point.kind === "collection-item");
    this.#state.pending = { ...point, invocationId: this.address(point.nodeId), iterations: structuredClone(this.#state.iterations), sequence: this.#state.sequence,
      scope: template ? "unentered-template" : "invocation" };
    return structuredClone(this.#state.pending);
  }
  private resolve(binding: ReadBinding) { return resolveReadBinding(binding, this.#state.values); }
  private typed(nodeId: string, kind: ProtectedMachinePoint["kind"], binding: ReadBinding, schema: Record<string, unknown>, extra: Partial<ProtectedMachinePoint> = {}) {
    let value: unknown, valid = false;
    try { value = this.resolve(binding); valid = !validateToolInput(schema, value).length; } catch { /* Missing/limited is not a default or catchable read fault. */ }
    return this.point({ kind, nodeId, valid, ...(value === undefined ? {} : { value }), ...extra });
  }
  private sequence(block: ReadSequence) { this.#state.frames.push({ kind: "sequence", block: this.#blockIds.get(block)!, index: 0, result: {} }); }
  private skip(block: ReadSequence, reason: ProtectedMachineSkip) { this.#state.frames.push({ kind: "skip", ids: actionOrder(block), index: 0, reason }); }
  private cleanup(outer: string[]) { const keep = new Set(outer); for (const id of Object.keys(this.#state.values)) if (!keep.has(id)) delete this.#state.values[id]; }
  private propagate(result: ProtectedMachineResult) {
    const parent = this.#state.frames.at(-1);
    if (parent?.kind === "sequence") parent.result = structuredClone(result);
    else if (Object.keys(result).length) throw new Error("Protected continuation result has no sequence owner");
  }
  private popSequence(frame: Extract<ProtectedMachineFrame, { kind: "sequence" }>) {
    this.#state.frames.pop(); const parent = this.#state.frames.at(-1);
    if (!parent) { this.#state.status = frame.result.fault ? "FAILED" : "DONE"; if (frame.result.fault) this.#state.failure = frame.result.fault; return; }
    if (parent.kind === "if") { parent.result = frame.result; parent.phase = parent.selected === "then" ? "skip" : "merge"; }
    else if (parent.kind === "foreach") { parent.result = frame.result; parent.phase = frame.result.fault ? "complete" : "collect"; if (frame.result.returned) throw new Error("Collection body cannot Return"); }
    else if (parent.kind === "protect") {
      parent.result = frame.result;
      if (parent.phase === "body" && frame.result.fault) parent.phase = "select";
      else if (parent.phase === "body") { parent.phase = "complete"; this.skip((this.#nodes.get(parent.id) as Extract<StructuralMachineNode, { kind: "protect" }>).handler,
        frame.result.returned ? { kind: "return", returnId: frame.result.returned } : { kind: "body-succeeded", protectedId: parent.id }); }
      else if (parent.phase === "handler") parent.phase = "complete";
      else throw new Error("Protected continuation body has an invalid owner phase");
    } else throw new Error("Protected continuation sequence has no structural owner");
  }
  peek(): ProtectedMachinePoint | null {
    if (this.#state.status !== "RUNNING") return null;
    if (this.#state.pending) return structuredClone(this.#state.pending);
    for (let transitions = 0; transitions < 40000; transitions++) {
      if (this.#state.frames.length > 40) throw new Error("Protected continuation exceeds frame bounds");
      const frame = this.#state.frames.at(-1);
      if (!frame) throw new Error("Running protected continuation has no frame");
      if (frame.kind === "sequence") {
        const block = this.#blocks[frame.block]!;
        if (frame.index === block.nodes.length) { this.popSequence(frame); if (this.#state.status !== "RUNNING") return null; continue; }
        this.before(); const node = block.nodes[frame.index++]!;
        if (frame.result.returned || frame.result.fault) { this.skip({ kind: "sequence", nodes: [node] }, frame.result.returned ?
          { kind: "return", returnId: frame.result.returned } : { kind: "body-aborted", fault: frame.result.fault! }); continue; }
        if (node.kind === "action") {
          let args: unknown; try { args = this.resolve(this.#actions.get(node.nodeId)!); } catch { /* invalid pending boundary, never implicit fault */ }
          return this.point({ kind: "action", nodeId: node.nodeId, valid: args !== undefined, ...(args === undefined ? {} : { arguments: args }) });
        }
        if (node.kind === "return") return this.typed(node.id, "return", node.output.value, node.output.schema);
        if (node.kind === "if") this.#state.frames.push({ kind: "if", id: node.id, phase: "predicate", outer: Object.keys(this.#state.values), result: {} });
        else if (node.kind === "foreach") this.#state.frames.push({ kind: "foreach", id: node.id, phase: "start", outer: Object.keys(this.#state.values),
          index: 0, collected: [], budget: { bytes: 0, nodes: 0 }, result: {} });
        else this.#state.frames.push({ kind: "protect", id: node.id, phase: "start", outer: Object.keys(this.#state.values), result: {}, handled: false });
        continue;
      }
      if (frame.kind === "skip") {
        if (frame.index === frame.ids.length) { this.#state.frames.pop(); continue; }
        this.before(); return this.point({ kind: "skip", nodeId: frame.ids[frame.index]!, reason: frame.reason, valid: true });
      }
      const node = this.#nodes.get(frame.id)!;
      if (frame.kind === "if" && node.kind === "if") {
        if (frame.phase === "predicate") {
          let value: unknown; try { value = this.resolve(node.predicate); } catch { /* Missing is not false. */ }
          return this.point({ kind: "condition", nodeId: node.id, valid: typeof value === "boolean", ...(typeof value === "boolean" ? { selected: value ? "then" : "else" } : {}) });
        }
        if (frame.phase === "selected") { frame.phase = "merge"; this.sequence(node[frame.selected!]); continue; }
        if (frame.phase === "skip") { frame.phase = frame.selected === "then" ? "merge" : "selected"; this.skip(node[frame.selected === "then" ? "else" : "then"],
          { kind: "branch", conditionId: node.id, selected: frame.selected! }); continue; }
        if (frame.phase === "merge") { if (!Object.keys(frame.result).length && node.merge) return this.typed(node.id, "merge", node.merge[frame.selected!], node.merge.schema); frame.phase = "finish"; continue; }
        this.cleanup(frame.outer); if (frame.output) this.#state.values[node.id] = frame.output; this.#state.frames.pop(); this.propagate(frame.result); continue;
      }
      if (frame.kind === "foreach" && node.kind === "foreach") {
        if (frame.phase === "start") {
          let items: unknown, valid = false; try { items = this.resolve(node.items.value); valid = Array.isArray(items) && items.length <= node.maxItems && !validateToolInput(node.items.schema, items).length; } catch { /* not empty */ }
          if (valid) frame.items = items as unknown[];
          return this.point({ kind: "collection-start", nodeId: node.id, valid, ...(Array.isArray(items) ? { count: items.length } : {}), ...(valid ? { value: items } : {}) });
        }
        if (frame.phase === "item") {
          if (frame.index === frame.items!.length) { frame.phase = "complete"; continue; }
          this.before(); this.#state.iterations.push({ loopId: node.id, index: frame.index });
          this.#state.values[node.id] = { item: frame.items![frame.index], index: frame.index }; frame.phase = "body"; this.sequence(node.body); continue;
        }
        if (frame.phase === "collect") return this.typed(node.id, "collection-item", node.collect.value, node.collect.schema);
        if (frame.phase === "complete") {
          if (frame.result.fault) { this.#state.iterations.pop(); this.cleanup(frame.outer); frame.phase = "finish";
            return this.point({ kind: "collection-complete", nodeId: node.id, valid: true, outcome: "FAILED", fault: frame.result.fault }); }
          return this.point({ kind: "collection-complete", nodeId: node.id, valid: true, outcome: "SUCCEEDED", count: frame.collected.length, value: frame.collected });
        }
        if (frame.phase !== "finish") throw new Error("Collection continuation has an invalid phase");
        this.cleanup(frame.outer); if (frame.output) this.#state.values[node.id] = frame.output;
        this.#state.frames.pop(); this.propagate(frame.result); continue;
      }
      if (frame.kind !== "protect" || node.kind !== "protect") throw new Error("Protected continuation node kind changed");
      if (frame.phase === "start") return this.point({ kind: "protected-start", nodeId: node.id, valid: true });
      if (frame.phase === "body") { this.sequence(node.body); continue; }
      if (frame.phase === "select") return this.point({ kind: "protected-select", nodeId: node.id, valid: true, fault: frame.result.fault! });
      if (frame.phase === "handler") { this.sequence(node.handler); continue; }
      if (frame.phase === "complete") {
        const outcome = frame.result.fault ? "FAILED" : frame.result.returned ? "RETURNED" : frame.handled ? "HANDLED_ERROR" : "SUCCEEDED";
        if (outcome === "SUCCEEDED" || outcome === "HANDLED_ERROR") return this.typed(node.id, "protected-complete", node.output[frame.handled ? "handled" : "success"], node.output.schema, { outcome });
        return this.point({ kind: "protected-complete", nodeId: node.id, valid: true, outcome, ...(frame.result.fault ? { fault: frame.result.fault } : {}) });
      }
      this.cleanup(frame.outer); if (frame.output) this.#state.values[node.id] = frame.output;
      this.#state.frames.pop(); this.propagate(frame.result);
    }
    throw new Error("Protected continuation exceeds internal transition bounds");
  }
  /** Pure acceptance only, not a storage ACK or authorizing receipt. */
  accept(output?: unknown): void {
    const point = this.#state.pending, frame = this.#state.frames.at(-1);
    if (this.#state.status !== "RUNNING" || !point?.valid || !frame || this.#state.sequence >= 5000) throw new Error("No valid pending protected boundary");
    if (output !== undefined) boundProtectedMachineJSON(output);
    let typed: { value: unknown } | undefined;
    const hasTyped = ["merge", "return", "collection-item"].includes(point.kind) || point.kind === "collection-complete" && point.outcome !== "FAILED" ||
      point.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(point.outcome!);
    if (hasTyped) {
      if (!output || typeof output !== "object" || Array.isArray(output) || Object.keys(output).join("|") !== "value" || !same((output as { value: unknown }).value, point.value))
        throw new Error("Typed acceptance differs from the exact pending value");
      typed = { value: new ReadValueBudget().clone(point.value, 0) };
    } else if (point.kind !== "action" && output !== undefined) throw new Error("Control acceptance cannot inject a value");
    if (point.kind === "action" && frame.kind === "sequence") this.#state.values[point.nodeId] = new ReadValueBudget().clone(output, 0);
    else if (point.kind === "skip" && frame.kind === "skip") frame.index++;
    else if (point.kind === "condition" && frame.kind === "if") { frame.selected = point.selected!; frame.phase = point.selected === "then" ? "selected" : "skip"; }
    else if (point.kind === "return" && frame.kind === "sequence") { frame.result = { returned: point.nodeId }; this.#state.result = typed!; }
    else if (point.kind === "merge" && frame.kind === "if") { frame.output = typed!; frame.phase = "finish"; }
    else if (point.kind === "collection-start" && frame.kind === "foreach") {
      frame.phase = frame.items!.length ? "item" : "complete";
      if (!frame.items!.length) this.skip((this.#nodes.get(frame.id) as Extract<StructuralMachineNode, { kind: "foreach" }>).body, { kind: "empty-collection", loopId: frame.id });
    } else if (point.kind === "collection-item" && frame.kind === "foreach") {
      const budget = new ReadValueBudget(frame.budget), value = budget.clone(typed!.value, 1);
      frame.collected.push(value); frame.budget = budget.checkpoint(); this.#state.iterations.pop(); this.cleanup(frame.outer); frame.index++; frame.phase = "item";
    } else if (point.kind === "collection-complete" && frame.kind === "foreach") { if (typed) frame.output = typed; else delete frame.output; frame.phase = "finish"; }
    else if (point.kind === "protected-start" && frame.kind === "protect") frame.phase = "body";
    else if (point.kind === "protected-select" && frame.kind === "protect") {
      this.cleanup(frame.outer); frame.handled = true; frame.selectedFault = structuredClone(point.fault!); frame.result = {};
      this.#state.values[frame.id] = { error: { code: point.fault!.code, failedNodeId: point.fault!.failedNodeId } }; frame.phase = "handler";
    } else if (point.kind === "protected-complete" && frame.kind === "protect") { if (typed) frame.output = typed; else delete frame.output; frame.phase = "finish"; }
    else throw new Error("Pending protected boundary has an incompatible owner");
    this.#state.sequence++;
    delete this.#state.pending;
  }
  /** A caller must first prove the exact definitely-failed reviewed read and
   * persist its failed intent. Arbitrary exceptions never enter this method. */
  fail(fault: ProtectedMachineFault): void {
    boundProtectedMachineJSON(fault);
    const point = this.#state.pending, frame = this.#state.frames.at(-1);
    if (this.#state.status !== "RUNNING" || !point?.valid || point.kind !== "action" || frame?.kind !== "sequence" || this.#state.sequence >= 5000 ||
        Object.keys(fault).sort().join("|") !== "code|failedInvocationId|failedNodeId" || fault.code !== "ERP_RESOURCE_NOT_FOUND" ||
        fault.failedNodeId !== point.nodeId || fault.failedInvocationId !== point.invocationId) throw new Error("Read fault does not match the exact pending action");
    frame.result = { fault: structuredClone(fault) }; this.#state.sequence++; delete this.#state.pending;
  }
  /** Unknown outcomes, cancellation and safeguard denials do not route to a handler. */
  halt(): void { if (this.#state.status === "RUNNING") this.#state.status = "HALTED"; }
}
