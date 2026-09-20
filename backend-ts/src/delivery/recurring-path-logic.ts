type Choice = { rank: number; yes: number; no: number };

/** Reduced ordered decision DAG for denial-only all-path authoring proof.
 * IDs 0/1 are false/true. It never evaluates a predicate or grants authority.
 * Shared choices stay shared; no expansion into every Boolean combination. */
export class RecurringPathLogic {
  readonly #ranks: Map<string, number>;
  readonly #nodes = new Map<number, Choice>();
  readonly #unique = new Map<string, number>();
  readonly #applied = new Map<string, number>();
  #visits = 0;
  constructor(ids: readonly string[]) {
    if (ids.length > 100 || new Set(ids).size !== ids.length) throw new Error("Recurring provenance exceeds its unique decision bound");
    this.#ranks = new Map(ids.map((id, rank) => [id, rank]));
  }
  variable(id: string): number {
    const rank = this.#ranks.get(id);
    if (rank === undefined) throw new Error("Recurring provenance has an unknown decision");
    return this.choice(rank, 1, 0);
  }
  and(left: number, right: number): number { return this.apply("and", left, right); }
  or(left: number, right: number): number { return this.apply("or", left, right); }
  not(value: number): number { return this.apply("xor", value, 1); }
  implies(left: number, right: number): boolean { return this.and(left, this.not(right)) === 0; }
  get stateCount(): number { return this.#nodes.size; }
  private choice(rank: number, yes: number, no: number): number {
    if (yes === no) return yes;
    const key = `${rank}:${yes}:${no}`, saved = this.#unique.get(key);
    if (saved !== undefined) return saved;
    if (this.#nodes.size >= 20_000) throw new Error("Recurring provenance exceeds its decision-state budget");
    const id = this.#nodes.size + 2; this.#nodes.set(id, { rank, yes, no }); this.#unique.set(key, id); return id;
  }
  private apply(kind: "and" | "or" | "xor", first: number, second: number): number {
    const left = Math.min(first, second), right = Math.max(first, second), key = `${kind}:${left}:${right}`;
    const saved = this.#applied.get(key); if (saved !== undefined) return saved;
    if (++this.#visits > 100_000) throw new Error("Recurring provenance exceeds its proof-operation budget");
    if (kind === "and" && (left === 0 || right === 0)) return 0;
    if (kind === "and" && left === 1) return right;
    if (kind === "or" && left === 1) return 1;
    if (kind === "or" && left === 0 || kind === "xor" && left === 0) return right;
    if (left === right) return kind === "xor" ? 0 : left;
    const a = this.#nodes.get(left), b = this.#nodes.get(right), rank = Math.min(a?.rank ?? Infinity, b?.rank ?? Infinity);
    const yes = this.apply(kind, a?.rank === rank ? a.yes : left, b?.rank === rank ? b.yes : right);
    const no = this.apply(kind, a?.rank === rank ? a.no : left, b?.rank === rank ? b.no : right);
    const result = this.choice(rank, yes, no); this.#applied.set(key, result); return result;
  }
}
