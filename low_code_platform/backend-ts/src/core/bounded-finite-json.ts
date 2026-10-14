import { canonicalJSONBytes } from "./canonical-json.js";

/** Shared descriptor-safe private JSON bound. Default limits preserve the
 * protected-machine/v1 contract; larger normalized ledgers remain bounded. */
export function assertBoundedFiniteJSON(value: unknown, bytes = 4_000_000, nodes = 131072): void {
  boundedFiniteJSONBytes(value, bytes, nodes);
}

/** Return the same canonical bytes used for the bound, after all descriptor,
 * finite-value, depth and cardinality checks. Callers can hash/compare these
 * bytes without sorting the same captured immutable JSON repeatedly. */
export function boundedFiniteJSONBytes(value: unknown, bytes = 4_000_000, nodes = 131072): Buffer {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32_000_000 || !Number.isSafeInteger(nodes) || nodes < 1 || nodes > 2_000_000)
    throw new Error("Invalid finite JSON bounds");
  let count = 0; const active = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (++count > nodes || depth > 64) throw new Error("Protected machine data exceeds structural bounds");
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
  const encoded = canonicalJSONBytes(value);
  if (encoded.length > bytes) throw new Error("Protected machine data exceeds byte bounds");
  return encoded;
}
