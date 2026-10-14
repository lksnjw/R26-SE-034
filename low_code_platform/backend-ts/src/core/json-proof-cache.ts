import { canonicalJSONBytes } from "./canonical-json.js";
import { types } from "node:util";

/** A cache key may bypass canonicalization only when equal bytes guarantee
 * equal canonical JSON. Reject custom prototypes, accessors and toJSON hooks;
 * those can stringify differently from the canonical serializer. */
export function exactJSONCacheKey(value: unknown): string | undefined {
  let nodes = 0;
  const safe = (item: unknown, depth: number): boolean => {
    if (++nodes > 32768 || depth > 40) return false;
    if (item === null || item === undefined || ["string", "boolean"].includes(typeof item)) return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object") return false;
    if (types.isProxy(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    if (Array.isArray(item) && prototype !== Array.prototype) return false;
    // Do not invoke inherited serialization hooks, or getters in sparse array
    // slots. A miss still uses the caller's original proof calculation.
    for (let parent = prototype; parent !== null; parent = Object.getPrototypeOf(parent)) {
      if (Object.getOwnPropertyDescriptor(parent, "toJSON")) return false;
    }
    if (Object.getOwnPropertySymbols(item).length) return false;
    const names = Object.getOwnPropertyNames(item);
    if (Array.isArray(item)) {
      if (item.length > 32768) return false;
      // Canonicalization uses Array.map; named properties such as map or
      // constructor can change its behavior even though stringify ignores them.
      if (names.length !== item.length + 1) return false;
      for (let index = 0; index < item.length; index++) if (!Object.hasOwn(item, index)) return false;
    }
    for (const name of names) {
      const property = Object.getOwnPropertyDescriptor(item, name)!;
      if (property.get || property.set || !safe(property.value, depth + 1)) return false;
    }
    return true;
  };
  try { return safe(value, 0) ? JSON.stringify(value) : undefined; } catch { return undefined; }
}

/** Sorting inert JSON keys changes order, not byte count. Account for the
 * canonical serializer's Go escapes without allocating a sorted deep clone.
 * Exotic/unsafe data uses the unchanged canonical serializer instead. */
export function canonicalJSONByteLength(value: unknown): number {
  const json = exactJSONCacheKey(value); if (json === undefined) return canonicalJSONBytes(value).length;
  let overhead = 0;
  for (const match of json.matchAll(/[<>&\u2028\u2029]/g)) overhead += match[0].charCodeAt(0) > 127 ? 3 : 5;
  return Buffer.byteLength(json) + overhead;
}

/** Per-worker, bounded, exact-byte memoization. A changed serialized witness
 * is never a hit. This grants no policy/authority or cacheable
 * runtime state; callers must continue all volatile-context checks. */
export class JSONProofCache<T extends string | boolean> {
  readonly #entries = new Map<string, { value: T; bytes: number }>();
  #bytes = 0;
  constructor(readonly maxBytes = 2_000_000, readonly maxEntries = 512) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Proof cache requires bounded positive limits");
  }
  get(value: unknown): T | undefined { const key = exactJSONCacheKey(value); return key === undefined ? undefined : this.#entries.get(key)?.value; }
  put(value: unknown, proof: T): void {
    const key = exactJSONCacheKey(value); if (key === undefined) return;
    this.insert(key, proof);
  }
  /** Calculate a proof once on a miss. Throwing/unsafe results are never cached;
   * an unsafe key still executes the original calculation, without a shortcut. */
  getOrCompute(value: unknown, compute: () => T): T {
    const key = exactJSONCacheKey(value), cached = key === undefined ? undefined : this.#entries.get(key);
    if (cached) return cached.value;
    const proof = compute(); this.assertProof(proof); if (key !== undefined) this.insert(key, proof); return proof;
  }
  private assertProof(proof: T): void {
    if (typeof proof !== "string" && typeof proof !== "boolean") throw new Error("Proof cache accepts only bounded scalar proofs");
  }
  private insert(key: string, proof: T): void {
    this.assertProof(proof);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(proof)); if (bytes > this.maxBytes) return;
    if (this.#entries.has(key)) return;
    while (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) {
      const oldest = this.#entries.keys().next().value as string | undefined; if (oldest === undefined) break;
      this.#bytes -= this.#entries.get(oldest)!.bytes; this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value: proof, bytes }); this.#bytes += bytes;
  }
  clear(): void { this.#entries.clear(); this.#bytes = 0; }
}
