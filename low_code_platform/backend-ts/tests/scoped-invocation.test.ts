import { expect, test } from "vitest";
import { ScopedInvocationIndex } from "../src/workflows/scoped-invocation.js";
import type { ReadSequence } from "../src/workflows/read-control-flow.js";

const sequence = (...nodes: any[]): ReadSequence => ({ kind: "sequence", nodes });
const action = (nodeId: string) => ({ kind: "action", nodeId });
const value = { schema: { type: "string" }, value: { kind: "literal", value: "fixture" } };
const loop = (id: string, body: ReadSequence, maxItems = 3) => ({ kind: "foreach", id, maxItems, body,
  items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [] } }, collect: value });
const protect = (id: string, body: ReadSequence, handler: ReadSequence) => ({ kind: "protect", id, body, handler,
  onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output: { schema: { type: "string" }, success: value.value, handled: value.value } });
const root = () => sequence(
  protect("outer", sequence(
    loop("each", sequence(
      protect("inner", sequence(action("lookup")), sequence(action("fallback"))),
      loop("nested", sequence(action("detail")), 2)
    ))
  ), sequence(action("outer_fallback"))),
  action("after")
);

test("loop iterations retain separate action identities and static source positions", () => {
  const index = new ScopedInvocationIndex(root());
  const first = index.resolveAddress("each/0/lookup"), second = index.resolveAddress("each/1/lookup");
  expect(first).toMatchObject({ profile: "scoped-invocation/v1", nodeId: "lookup", kind: "action", actionIndex: 0,
    protectedBodies: [{ protectedId: "inner", invocationId: "each/0/inner" }, { protectedId: "outer", invocationId: "outer" }] });
  expect(second.invocationId).not.toBe(first.invocationId); expect(second.actionIndex).toBe(first.actionIndex);
  expect(index.resolveAddress("after").actionIndex).toBe(4);
});

test("a handler is outside its own body; enclosing body identity uses its own exact loop prefix", () => {
  const index = new ScopedInvocationIndex(root());
  expect(index.resolveAddress("each/2/fallback").protectedBodies).toEqual([{ protectedId: "outer", invocationId: "outer" }]);
  expect(index.resolveAddress("outer_fallback").protectedBodies).toEqual([]);
  expect(index.resolveAddress("each/2/nested/1/detail").iterations).toEqual([{ loopId: "each", index: 2 }, { loopId: "nested", index: 1 }]);
});

test("collection start/completion and per-item boundaries are distinct exact identities", () => {
  const index = new ScopedInvocationIndex(root());
  expect(index.resolveAddress("each").iterations).toEqual([]);
  expect(index.resolveAddress("each/2/each", true).iterations).toEqual([{ loopId: "each", index: 2 }]);
  expect(index.resolveAddress("each/2/nested").iterations).toEqual([{ loopId: "each", index: 2 }]);
  expect(index.resolveAddress("each/2/nested/1/nested", true).iterations).toHaveLength(2);
  expect(() => index.resolveAddress("each/2/each")).toThrow();
  expect(() => index.resolveAddress("each/0/lookup", true)).toThrow();
});

test.each(["lookup", "each/3/lookup", "each/-1/lookup", "each/01/lookup", "each/1.0/lookup", "each/NaN/lookup",
  "each/0/nested/2/detail", "nested/1/each/0/detail", "each/0/nested/0/lookup", "each/0/after", "each/0/missing", "each/0/lookup/"])("non-owned or non-canonical address %s is refused", address => {
  expect(() => new ScopedInvocationIndex(root()).resolveAddress(address)).toThrow();
});

test("caller mutations and extra iteration fields cannot alter captured scope", () => {
  const tree = root(), index = new ScopedInvocationIndex(tree);
  (tree.nodes[0] as any).body.nodes[0].maxItems = 100;
  expect(() => index.resolveAddress("each/4/lookup")).toThrow();
  const identity = index.resolveAddress("each/0/lookup"); identity.iterations[0]!.index = 99; identity.protectedBodies[0]!.protectedId = "fake";
  expect(index.resolveAddress("each/0/lookup").protectedBodies[0]!.protectedId).toBe("inner");
  expect(() => index.resolve("lookup", [{ loopId: "each", index: 0, approval: true } as any])).toThrow();
});

test.each([sequence(action("same"), action("same")), sequence(loop("same", sequence(action("same"))))])("duplicate action or structural ownership is refused", tree => {
  expect(() => new ScopedInvocationIndex(tree)).toThrow(/duplicate/);
});

test("static body ownership creates no handler-selection or execution authority", () => {
  const result = new ScopedInvocationIndex(root()).resolveAddress("each/1/lookup");
  expect(Object.keys(result).sort()).toEqual(["actionIndex", "invocationId", "iterations", "kind", "nodeId", "profile", "protectedBodies"]);
  expect(JSON.stringify(result)).not.toMatch(/admission|approval|selected|receipt|capability|operationKey/);
});
