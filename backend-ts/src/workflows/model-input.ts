import type { ReadBinding, ReadReference } from "./compiled-read.js";

export type CompiledModelInput = ReadReference | { kind: "object"; fields: Record<string, ReadReference> };

export function modelInputReferences(binding: ReadBinding): ReadReference[] | null {
  if (binding.kind === "ref") return [binding];
  if (binding.kind !== "object" || Object.keys(binding.fields).length < 1 || Object.keys(binding.fields).length > 8 ||
      Object.values(binding.fields).some(value => value.kind !== "ref")) return null;
  return Object.values(binding.fields) as ReadReference[];
}

/** Named inputs have one shared budget, not a fresh limit for every source.
 * Count nested array entries too, so object wrappers cannot hide large reports.
 * Historical single-reference plans retain their original accounting. */
export function modelInputItemCount(binding: CompiledModelInput, value: unknown): number {
  if (binding.kind === "ref") return Array.isArray(value) ? value.length : value !== null && typeof value === "object" ? Object.keys(value).length : 1;
  let visits = 0;
  const count = (item: unknown, depth: number): number => {
    if (++visits > 32768 || depth > 32) throw new Error("Model input exceeds supported traversal bounds");
    if (Array.isArray(item)) return item.length + item.reduce<number>((sum, child) => sum + (child !== null && typeof child === "object" ? nested(child, depth + 1) : 0), 0);
    if (item !== null && typeof item === "object") {
      const values = Object.values(item);
      return values.reduce<number>((sum, child) => sum + count(child, depth + 1), 0);
    }
    return 1;
  };
  const nested = (item: unknown, depth: number): number => {
    if (Array.isArray(item)) return count(item, depth);
    if (++visits > 32768 || depth > 32) throw new Error("Model input exceeds supported traversal bounds");
    return item !== null && typeof item === "object" ? Object.values(item).reduce<number>((sum, child) =>
      sum + (child !== null && typeof child === "object" ? nested(child, depth + 1) : 0), 0) : 0;
  };
  return Object.values(value as Record<string, unknown>).reduce<number>((sum, source) => sum + count(source, 0), 0);
}
