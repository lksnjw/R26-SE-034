import { stringify } from "yaml";
import type { WorkflowBlueprint } from "../models/schemas.js";
import type { CompiledReadPlan } from "./compiled-read.js";
import type { ReadIteration, ReadVisit } from "./read-interpreter.js";
import type { ReadSequence } from "./read-control-flow.js";
import { ReadValueBudget } from "./read-value-budget.js";

export type CompletedRead = { nodeId: string; sourceIndex: number; args: Record<string, unknown>; visit: ReadVisit };
export class ReadEvidenceLimit extends Error { constructor() { super("Read completion evidence exceeds bounded limits"); } }
const address = (id: string, frames: readonly ReadIteration[]) => [...frames.flatMap(frame => [frame.loopId, String(frame.index)]), id].join("/");
const prefix = (left: readonly ReadIteration[], right: readonly ReadIteration[]) => left.every((frame, index) => frame.loopId === right[index]?.loopId && frame.index === right[index]?.index);
type Collection = { loopId: string; frames: readonly ReadIteration[]; count: number; items: number; completed: boolean };

/** Local interpreter evidence only, never a capability or accepted serialized
 * checkpoint. Drivers call these methods AFTER confirming an action or typed
 * value. Durable drivers must reconstruct it from authenticated receipts.
 * Prior item reads remain invisible while their owning collection is open. */
export class ReadCompletionEvidence {
  readonly #actions = new Map<string, number>();
  readonly #owners = new Map<string, readonly string[]>();
  readonly #loops = new Map<string, number>();
  readonly #collections = new Map<string, Collection>();
  readonly #completed = new Map<string, CompletedRead>();
  readonly #arguments = new ReadValueBudget();
  constructor(plan: CompiledReadPlan) {
    plan.ir.root.nodes.forEach((node, index) => this.#actions.set(node.id, index));
    const visit = (block: ReadSequence, owners: readonly string[]): void => {
      for (const node of block.nodes) {
        if (node.kind === "action") this.#owners.set(node.nodeId, [...owners]);
        else if (node.kind === "foreach") { this.#owners.set(node.id, [...owners]); this.#loops.set(node.id, node.maxItems); visit(node.body, [...owners, node.id]); }
        else if (node.kind === "if") { visit(node.then, owners); visit(node.else, owners); }
      }
    };
    if (plan.ir.flow) visit(plan.ir.flow, []); else plan.ir.root.nodes.forEach(node => this.#owners.set(node.id, []));
  }
  private scope(id: string, visit: ReadVisit, owners = this.#owners.get(id), except?: string): void {
    const frames = visit.iterations;
    if (!owners || !Array.isArray(frames) || frames.length !== owners.length || frames.length > 8 ||
        frames.some((frame, index) => frame.loopId !== owners[index] || !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index > 99) || visit.invocationId !== address(id, frames)) throw new Error("Read evidence has an invalid declared invocation scope");
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!, owner = this.#collections.get(address(frame.loopId, frames.slice(0, index)));
      if (!owner || owner.completed || frame.index !== owner.items || frame.index >= owner.count) throw new Error("Read evidence is outside the current collection item");
    }
    for (const [key, collection] of this.#collections) if (!collection.completed && key !== except) {
      if (!prefix(collection.frames, frames) || frames[collection.frames.length]?.loopId !== collection.loopId) throw new Error("Read evidence cannot escape an incomplete collection");
    }
  }
  collectionStarted(loopId: string, count: number, visit: ReadVisit): void {
    this.scope(loopId, visit);
    const limit = this.#loops.get(loopId);
    if (this.#collections.size >= 5000) throw new ReadEvidenceLimit();
    if (limit === undefined || !Number.isSafeInteger(count) || count < 0 || count > limit || this.#collections.has(visit.invocationId)) throw new Error("Read evidence requires a unique bounded collection start");
    this.#collections.set(visit.invocationId, { loopId, frames: structuredClone(visit.iterations), count, items: 0, completed: false });
  }
  itemCompleted(loopId: string, visit: ReadVisit): void {
    const owners = this.#owners.get(loopId); this.scope(loopId, visit, owners && [...owners, loopId]);
    const frame = visit.iterations.at(-1), collection = this.#collections.get(address(loopId, visit.iterations.slice(0, -1)));
    if (!frame || !collection || frame.loopId !== loopId || frame.index !== collection.items) throw new Error("Read evidence lacks its exact completed item");
    collection.items++;
  }
  collectionCompleted(loopId: string, visit: ReadVisit): void {
    const collection = this.#collections.get(visit.invocationId);
    this.scope(loopId, visit, this.#owners.get(loopId), visit.invocationId);
    if (!collection || collection.completed || collection.loopId !== loopId || collection.items !== collection.count) throw new Error("Read evidence cannot complete an unconfirmed collection");
    collection.completed = true;
  }
  prior(nodeId: string, visit: ReadVisit): readonly CompletedRead[] {
    this.assertAction(nodeId, visit);
    const visible = [...this.#completed.values()].filter(item => {
      const frames = item.visit.iterations;
      if (prefix(frames, visit.iterations)) return true;
      let common = 0;
      while (common < frames.length && frames[common]?.loopId === visit.iterations[common]?.loopId && frames[common]?.index === visit.iterations[common]?.index) common++;
      return frames.slice(common).every((frame, offset) => this.#collections.get(address(frame.loopId, frames.slice(0, common + offset)))?.completed === true);
    });
    return structuredClone(visible);
  }
  private assertAction(nodeId: string, visit: ReadVisit): void {
    this.scope(nodeId, visit);
    if (!this.#actions.has(nodeId) || this.#completed.has(visit.invocationId)) throw new Error("Read evidence requires a new declared action");
  }
  actionCompleted(nodeId: string, args: Record<string, unknown>, visit: ReadVisit): void {
    this.assertAction(nodeId, visit);
    if (this.#completed.size >= 5000) throw new ReadEvidenceLimit();
    if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("Read evidence requires concrete object arguments");
    let bounded: Record<string, unknown>;
    try { bounded = this.#arguments.clone(args, 0) as Record<string, unknown>; } catch { throw new ReadEvidenceLimit(); }
    this.#completed.set(visit.invocationId, { nodeId, sourceIndex: this.#actions.get(nodeId)!, args: bounded, visit: structuredClone(visit) });
  }
}

/** Denial-only expanded verification view. Preserve every visible invocation
 * and concrete argument set in observed order, not one Map entry per node.
 * This is NEVER the source used to mint a token or SDK capability. */
export function selectedReadEvidenceYAML(blueprint: WorkflowBlueprint, nodeId: string, args: Record<string, unknown>, visit: ReadVisit, prior: readonly CompletedRead[]): string {
  const index = blueprint.steps.findIndex(step => step.id === nodeId);
  if (index < 0) throw new Error("Selected read evidence has no source action");
  if (prior.length > 5000) throw new ReadEvidenceLimit();
  const seen = new Set<string>(), budget = new ReadValueBudget();
  const records = [...prior, { nodeId, sourceIndex: index, args, visit }];
  const steps = records.map(record => {
    const step = blueprint.steps[record.sourceIndex];
    if (!step || step.id !== record.nodeId || record.visit.invocationId !== address(record.nodeId, record.visit.iterations) || seen.has(record.visit.invocationId)) throw new Error("Selected read evidence has changed or duplicate source identities");
    seen.add(record.visit.invocationId);
    let parameters: Record<string, unknown>;
    try { parameters = budget.clone(record.args, 0) as Record<string, unknown>; } catch { throw new ReadEvidenceLimit(); }
    return { id: record.visit.invocationId, action: step.action, ...(step.kind === undefined ? {} : { kind: step.kind }), parameters };
  });
  const metadata = { ...blueprint.metadata }; delete metadata.controlFlow;
  const yaml = stringify({ ...blueprint, metadata, steps });
  if (Buffer.byteLength(yaml) > 2_000_000) throw new ReadEvidenceLimit();
  return yaml;
}
