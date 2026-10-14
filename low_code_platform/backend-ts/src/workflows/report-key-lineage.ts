import type { ReadBinding } from "./compiled-read.js";
import { controlNodes, type ReadSequence } from "./read-control-flow.js";
import { DecisionPathLogic } from "./decision-path-logic.js";

export type ReportKeyProjection = { nodeId: string; path: readonly string[] };

/** Exact field lineage through typed joins, never value equality, templating or
 * model interpretation. Callers retain lexical/schema/contract validation and
 * must separately check selected acknowledged report/merge receipts at dispatch. */
export class ReportKeyLineage {
  readonly logic: DecisionPathLogic;
  readonly available = new Map<string, number>();
  readonly #merges;
  readonly #projections;
  readonly #memo = new Map<string, Map<string, number>>();
  readonly #resolving = new Set<string>();
  #sourceVisits = 0;
  constructor(root: ReadSequence, projections: readonly ReportKeyProjection[]) {
    const conditions = controlNodes(root);
    this.logic = new DecisionPathLogic(conditions.map(node => node.id));
    this.#merges = new Map(conditions.filter(node => node.merge).map(node => [node.id, node]));
    this.#projections = new Map(projections.map(value => [value.nodeId, value.path]));
    let visits = 0;
    const visit = (block: ReadSequence, entered: number, depth: number): number => {
      if (depth > 8) throw new Error("Report key lineage exceeds eight nested scopes");
      let active = entered;
      for (const node of block.nodes) {
        if (++visits > 2000) throw new Error("Report key lineage exceeds its structural visit budget");
        if (node.kind === "action") this.available.set(node.nodeId, active);
        else if (node.kind === "return") active = 0;
        else if (node.kind === "if") {
          const choice = this.logic.variable(node.id);
          active = this.logic.or(visit(node.then, this.logic.and(active, choice), depth + 1),
            visit(node.else, this.logic.and(active, this.logic.not(choice)), depth + 1));
          if (node.merge) this.available.set(node.id, active);
        } else throw new Error("Report key lineage does not support collections");
      }
      return active;
    };
    visit(root, 1, 0);
  }
  matches(binding: ReadBinding | undefined, primaryId: string, consumerId: string): boolean {
    if (!binding) return false;
    const required = this.logic.and(this.available.get(primaryId) ?? 0, this.available.get(consumerId) ?? 0);
    return required !== 0 && this.logic.implies(required, this.binding(binding).get(primaryId) ?? 0);
  }
  private binding(value: ReadBinding, path: readonly string[] = []): Map<string, number> {
    if (++this.#sourceVisits > 20_000) throw new Error("Report key lineage exceeds its source-resolution budget");
    if (value.kind === "ref") return value.source === "nodeOutput" && value.nodeId ? this.reference(value.nodeId, [...value.path, ...path]) : new Map();
    // Selecting a field within a structural wrapper is allowed. Constructing,
    // concatenating or selecting elements from a key array is not a projection.
    if (value.kind === "object" && path.length && value.fields[path[0]!]) return this.binding(value.fields[path[0]!]!, path.slice(1));
    return new Map();
  }
  private reference(id: string, path: readonly string[]): Map<string, number> {
    const key = JSON.stringify([id, path]), saved = this.#memo.get(key);
    if (saved) return saved;
    if (this.#resolving.has(key) || this.#resolving.size >= 32) throw new Error("Report key lineage has cyclic or over-deep sources");
    this.#resolving.add(key);
    const result = new Map<string, number>(), projection = this.#projections.get(id), active = this.available.get(id) ?? 0;
    if (projection && projection.length === path.length && projection.every((part, index) => part === path[index])) result.set(id, active);
    else {
      const merge = this.#merges.get(id);
      if (merge && path[0] === "value") {
        const choice = this.logic.variable(id);
        for (const [branch, guard] of [["then", choice], ["else", this.logic.not(choice)]] as const)
          for (const [source, evidence] of this.binding(merge.merge![branch], path.slice(1)))
            result.set(source, this.logic.or(result.get(source) ?? 0, this.logic.and(active, this.logic.and(guard, evidence))));
      }
    }
    this.#resolving.delete(key); this.#memo.set(key, result); return result;
  }
}
