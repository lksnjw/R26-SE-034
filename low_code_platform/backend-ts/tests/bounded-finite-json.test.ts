import { expect, test, vi } from "vitest";
import { assertBoundedFiniteJSON, boundedFiniteJSONBytes } from "../src/core/bounded-finite-json.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";

test.each([null, true, false, 0, -0, 1.25, "&<>\u2028\u2029", [1, "two", null], { z: 1, a: { value: "<&>" } },
  Object.assign(Object.create(null), { value: "safe" })])("bounded bytes preserve normative canonical JSON %#", value => {
  expect(boundedFiniteJSONBytes(value)).toEqual(canonicalJSONBytes(value));
  expect(assertBoundedFiniteJSON(value)).toBeUndefined();
});
test("shared JSON aliases stay duplicated canonically, without losing fields", () => {
  const shared = { output: { text: "<ERP & model>" }, items: [1, 2] }, value = { one: shared, two: shared, list: [shared, shared] };
  const bytes = boundedFiniteJSONBytes(value);
  expect(bytes).toEqual(canonicalJSONBytes(value));
  shared.output.text = "changed after capture";
  expect(bytes.toString()).toContain("\\u003cERP \\u0026 model\\u003e");
});
test.each([undefined, NaN, Infinity, -Infinity, 1n, () => null, Symbol("bad"), new Date(), new Map(), /invalid/, new Array(1),
  { value: undefined }, Object.create({ inherited: true })])("non-finite/non-JSON input stays rejected %#", value => {
  expect(() => boundedFiniteJSONBytes(value)).toThrow(); expect(() => assertBoundedFiniteJSON(value)).toThrow();
});
test("accessors cannot execute before or during canonical encoding", () => {
  const accessor = vi.fn(() => "must not read"), value = Object.defineProperty({}, "value", { enumerable: true, get: accessor });
  expect(() => boundedFiniteJSONBytes(value)).toThrow(/accessors/); expect(accessor).not.toHaveBeenCalled();
  expect(() => assertBoundedFiniteJSON(value)).toThrow(/accessors/); expect(accessor).not.toHaveBeenCalled();
});
test.each(["hidden", "symbol", "array-field", "cycle", "depth", "key-size"])("descriptor/structure %s cannot lose data", damage => {
  let value: any = {};
  if (damage === "hidden") Object.defineProperty(value, "secret", { value: true, enumerable: false });
  if (damage === "symbol") value[Symbol("hidden")] = true;
  if (damage === "array-field") { value = [1]; value.hidden = true; }
  if (damage === "cycle") value.self = value;
  if (damage === "depth") for (let at = 0; at < 65; at++) value = { next: value };
  if (damage === "key-size") value["a".repeat(16385)] = true;
  expect(() => boundedFiniteJSONBytes(value)).toThrow(); expect(() => assertBoundedFiniteJSON(value)).toThrow();
});
test("byte/node bounds use the complete same canonical encoded value", () => {
  const value = { text: "<&>" }, size = canonicalJSONBytes(value).length;
  expect(boundedFiniteJSONBytes(value, size, 2).length).toBe(size);
  expect(() => boundedFiniteJSONBytes(value, size - 1, 2)).toThrow(/byte bounds/);
  expect(() => boundedFiniteJSONBytes(value, size, 1)).toThrow(/structural bounds/);
});
test.each([[0, 1], [32_000_001, 1], [NaN, 1], [1.5, 1], [1, 0], [1, 2_000_001], [1, Infinity]])("invalid bounds stay denied %#", (bytes, nodes) => {
  expect(() => boundedFiniteJSONBytes(null, bytes, nodes)).toThrow(/Invalid finite JSON bounds/);
});
