import { expect, test, vi } from "vitest";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { canonicalJSONByteLength, exactJSONCacheKey, JSONProofCache } from "../src/core/json-proof-cache.js";

test("exact cloned JSON reuses a proof, while changed nested data does not", () => {
  const cache = new JSONProofCache<string>(), value = { run: "one", frames: [{ loopId: "rows", index: 0 }], answer: { value: false } };
  const compute = vi.fn(() => "sealed"); expect(cache.getOrCompute(value, compute)).toBe("sealed");
  expect(cache.getOrCompute(structuredClone(value), compute)).toBe("sealed"); expect(compute).toHaveBeenCalledTimes(1);
  for (const changed of [{ ...value, run: "two" }, { ...value, frames: [{ loopId: "rows", index: 1 }] }, { ...value, answer: { value: true } }]) expect(cache.get(changed)).toBeUndefined();
  expect(cache.get({ ...value, extra: "unconfirmed" })).toBeUndefined();
});

test("cache entries are byte keys, not references to mutable witnesses", () => {
  const cache = new JSONProofCache<true>(), value = { answer: "saved" }; cache.put(value, true); value.answer = "changed";
  expect(cache.get(value)).toBeUndefined(); expect(cache.get({ answer: "saved" })).toBe(true);
});

test("different property order is a conservative miss, not a substituted proof", () => {
  const cache = new JSONProofCache<true>(), left = { a: 1, b: 2 }, right = { b: 2, a: 1 };
  expect(canonicalJSONBytes(left)).toEqual(canonicalJSONBytes(right)); cache.put(left, true); expect(cache.get(right)).toBeUndefined();
});

test.each([
  [{ value: -0 }, { value: 0 }],
  [{ optional: undefined, value: null }, { value: null }],
  [[undefined, false], [null, false]],
  [Object.assign(Object.create(null), { value: "<&>\u2028\u2029😀" }), { value: "<&>\u2028\u2029😀" }],
])("equal supported serialization keys also have equal canonical bytes: %j", (left, right) => {
  expect(exactJSONCacheKey(left)).toBe(exactJSONCacheKey(right)); expect(canonicalJSONBytes(left)).toEqual(canonicalJSONBytes(right));
  const cache = new JSONProofCache<string>(); cache.put(left, "confirmed"); expect(cache.get(right)).toBe("confirmed");
});

test.each([new Date(0), new Map(), new Set(), /pattern/, Object.create({ answer: "inherited" }), 1n, NaN, Infinity, () => "value", Symbol("value")])("exotic/nonfinite values never shortcut the original calculation (case %#)", value => {
  const cache = new JSONProofCache<string>(), compute = vi.fn(() => "original"); expect(exactJSONCacheKey(value)).toBeUndefined();
  expect(cache.getOrCompute(value, compute)).toBe("original"); expect(cache.getOrCompute(value, compute)).toBe("original"); expect(compute).toHaveBeenCalledTimes(2);
});

test("accessors and serialization hooks are rejected without invoking them", () => {
  const getter = vi.fn(() => "concealed"), hook = vi.fn(() => ({ value: "concealed" }));
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter }), withHook = { value: "real", toJSON: hook };
  expect(exactJSONCacheKey(accessor)).toBeUndefined(); expect(exactJSONCacheKey(withHook)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled();
});

test("inherited serialization getters are rejected without being called", () => {
  const before = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"), getter = vi.fn(() => () => "concealed");
  try {
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get: getter });
    expect(exactJSONCacheKey({ value: "saved" })).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  } finally { if (before) Object.defineProperty(Object.prototype, "toJSON", before); else Reflect.deleteProperty(Object.prototype, "toJSON"); }
});

test("ignored array properties cannot alias a previously verified dense array", () => {
  const cache = new JSONProofCache<true>(); cache.put(["saved"], true);
  for (const field of ["map", "constructor", "extra"]) {
    const value = Object.assign(["saved"], { [field]: "not-plain-json" });
    expect(JSON.stringify(value)).toBe(JSON.stringify(["saved"])); expect(cache.get(value)).toBeUndefined();
  }
  const sparse = new Array(1); expect(exactJSONCacheKey(sparse)).toBeUndefined();
  const symbol = Object.assign({ value: "saved" }, { [Symbol("hook")]: "ignored" }); expect(exactJSONCacheKey(symbol)).toBeUndefined();
});

test("unsafe JSON-hook alias does not return a proof for different canonical data", () => {
  const cache = new JSONProofCache<true>(); cache.put({}, true); const date = new Date(0);
  // Both canonicalize to {}, but the fast key is intentionally refused.
  expect(canonicalJSONBytes(date)).toEqual(canonicalJSONBytes({})); expect(cache.get(date)).toBeUndefined();
  const alias = { private: "changed", toJSON: () => ({ answer: "saved" }) }; cache.put({ answer: "saved" }, true);
  expect(JSON.stringify(alias)).toBe(JSON.stringify({ answer: "saved" })); expect(cache.get(alias)).toBeUndefined();
});

test("proxy serialization traps cannot alias an inert JSON witness or be invoked by the key helper", () => {
  const trap = vi.fn((_target, field) => field === "toJSON" ? () => ({ answer: "saved" }) : "forged"), proxy = new Proxy({ answer: "forged" }, { get: trap });
  const cache = new JSONProofCache<true>(); cache.put({ answer: "saved" }, true);
  expect(cache.get(proxy)).toBeUndefined(); expect(exactJSONCacheKey(proxy)).toBeUndefined(); expect(trap).not.toHaveBeenCalled();
});

test("non-scalar runtime proofs are rejected even on uncacheable inputs", () => {
  const cache = new JSONProofCache<string>(); expect(() => cache.put({ value: "saved" }, {} as any)).toThrow("bounded scalar proofs");
  expect(() => cache.getOrCompute(new Date(0), () => ({} as any))).toThrow("bounded scalar proofs");
});

test("depth, node-count, cyclic and overlarge arrays are bounded cache misses", () => {
  let deep: unknown = "end"; for (let index = 0; index < 42; index++) deep = { value: deep };
  const cyclic: any = {}; cyclic.self = cyclic;
  for (const value of [deep, cyclic, Array.from({ length: 32768 }, () => false), new Array(32769)]) expect(exactJSONCacheKey(value)).toBeUndefined();
});

test("a throwing calculation is never saved", () => {
  const cache = new JSONProofCache<true>(), compute = vi.fn((): true => { throw new Error("invalid receipt"); });
  expect(() => cache.getOrCompute({ value: "untrusted" }, compute)).toThrow("invalid receipt");
  expect(() => cache.getOrCompute({ value: "untrusted" }, compute)).toThrow("invalid receipt"); expect(compute).toHaveBeenCalledTimes(2);
});

test("FIFO count eviction, scalar false proofs and explicit clear preserve bounded behavior", () => {
  const cache = new JSONProofCache<boolean>(1024, 2); cache.put({ id: 1 }, false); cache.put({ id: 2 }, true);
  expect(cache.get({ id: 1 })).toBe(false); cache.put({ id: 3 }, true);
  expect(cache.get({ id: 1 })).toBeUndefined(); expect(cache.get({ id: 2 })).toBe(true); expect(cache.get({ id: 3 })).toBe(true);
  cache.clear(); expect(cache.get({ id: 3 })).toBeUndefined(); cache.put({ id: 4 }, false); expect(cache.get({ id: 4 })).toBe(false);
});

test("UTF-8 key and proof bytes both count toward the budget", () => {
  const cache = new JSONProofCache<string>(22, 10); cache.put({ id: "😀" }, "small"); expect(cache.get({ id: "😀" })).toBe("small");
  cache.put({ id: "b" }, "small"); expect(cache.get({ id: "😀" })).toBeUndefined(); expect(cache.get({ id: "b" })).toBe("small");
  cache.put({ id: "c" }, "x".repeat(30)); expect(cache.get({ id: "c" })).toBeUndefined(); expect(cache.get({ id: "b" })).toBe("small");
  cache.put({ large: "x".repeat(30) }, "small"); expect(cache.get({ large: "x".repeat(30) })).toBeUndefined();
});

test("existing keys do not acquire a caller's replacement proof", () => {
  const cache = new JSONProofCache<string>(); cache.put({ id: 1 }, "original"); cache.put({ id: 1 }, "replacement"); expect(cache.get({ id: 1 })).toBe("original");
});

test.each([[0, 1], [1, 0], [-1, 1], [1.5, 1], [1, Infinity], [NaN, 1]])("invalid cache bounds %s/%s fail explicitly", (bytes, entries) => {
  expect(() => new JSONProofCache<true>(bytes, entries)).toThrow("bounded positive limits");
});

test.each([null, true, false, 0, -0, 1e30, "<&>\u2028\u2029😀", "\\u0026\"\n\\", [], [undefined, null, 1], { z: "<", a: "&" }, { "<key>\u2028": ["\u2029", "<&>😀"] }, new Date(0), Object.assign([1], { map: "unsafe" })])("optimized byte size matches the unchanged canonical serializer (case %#)", value => {
  if (Array.isArray(value) && Object.hasOwn(value, "map")) expect(() => canonicalJSONByteLength(value)).toThrow();
  else expect(canonicalJSONByteLength(value)).toBe(canonicalJSONBytes(value).length);
});

test("deterministically generated nested values keep exact canonical byte limits", () => {
  let seed = 17; const next = () => (seed = (seed * 48271) % 2147483647);
  const value = (depth: number): unknown => {
    const choice = next() % (depth ? 6 : 4);
    if (choice === 0) return null; if (choice === 1) return next() % 2 === 0; if (choice === 2) return (next() - 1073741823) / 17;
    if (choice === 3) return ["<&>", "\u2028\u2029😀", '"\\\n', "invoice", "", "a&b<c>d"][next() % 6];
    if (choice === 4) return Array.from({ length: next() % 4 }, () => value(depth - 1));
    return { z: value(depth - 1), "<&>😀": value(depth - 1), a: value(depth - 1) };
  };
  for (let index = 0; index < 250; index++) { const item = value(4); expect(canonicalJSONByteLength(item)).toBe(canonicalJSONBytes(item).length); }
});
