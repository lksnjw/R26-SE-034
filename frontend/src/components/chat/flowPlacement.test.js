import { expect, test } from "@jest/globals";
import { flowPlacementModel, canPlaceNode, movePlacementPreview } from "./flowPlacement";

const action = nodeId => ({ kind: "action", nodeId });
const sequence = (...nodes) => ({ kind: "sequence", nodes });
const output = { schema: { type: "boolean" }, value: { kind: "literal", value: false } };
const flow = sequence({ kind: "if", id: "gate", predicate: { kind: "literal", value: true },
  then: sequence({ kind: "foreach", id: "each", maxItems: 3, items: { schema: { type: "array" }, value: { kind: "literal", value: [] } }, collect: output, body: sequence(action("first")) }),
  else: sequence({ kind: "return", id: "answer", output }) }, action("last"));
const steps = ["first", "last"].map(id => ({ id, source: { id, action: "read", parameters: { value: id } } }));

test("bounded placement projection identifies exact root, branch, body and empty-scope endpoints", () => {
  const model = flowPlacementModel(flow, steps, true);
  expect(model.valid).toBe(true); expect(model.nodes.get("gate").subtreeIds).toEqual(["gate", "each", "first", "answer"]);
  expect(model.placements.find(item => item.key === "each:body|first")).toMatchObject({ beforeNodeId: "first", destination: { loopId: "each", scope: "body" }, owners: ["gate", "each"] });
  expect(model.placements.find(item => item.key === "gate:else|$end").label).toContain("If no · end");
  const empty = structuredClone(flow); empty.nodes[0].else.nodes = [];
  expect(flowPlacementModel(empty, steps).placements.some(item => item.key === "gate:else|$end")).toBe(true);
});

test("whole-subtree preview uses readable exact location and preserves source objects", () => {
  const before = JSON.stringify(flow), model = flowPlacementModel(flow, steps), result = movePlacementPreview(model, "gate", "root|$end");
  expect(result.command).toEqual({ type: "moveNode", nodeId: "gate", beforeNodeId: null });
  expect(result.after.preservedNodes).toEqual(["gate", "each", "first", "answer"]);
  expect(result.after.location).toBe("Main sequence · end"); expect(JSON.stringify(flow)).toBe(before);
});

test("collection/return moves target named scope and before-structural positions", () => {
  const model = flowPlacementModel(flow, steps);
  expect(movePlacementPreview(model, "answer", "each:body|first").command).toEqual({ type: "moveNode", nodeId: "answer", beforeNodeId: "first", destination: { loopId: "each", scope: "body" } });
  expect(movePlacementPreview(model, "last", "gate:then|each").command).toEqual({ type: "moveNode", nodeId: "last", beforeNodeId: "each", destination: { conditionId: "gate", branch: "then" } });
});

test.each([["gate", "gate:then|$end"], ["gate", "each:body|first"], ["each", "each:body|$end"], ["gate", "root|last"], ["answer", "gate:else|$end"], ["last", "root|last"], ["missing", "root|$end"], ["gate", "foreign|$end"]])("self/descendant/no-op/missing placement %s to %s never becomes a command", (id, key) => {
  const model = flowPlacementModel(flow, steps); expect(canPlaceNode(model, id, key)).toBe(false); expect(() => movePlacementPreview(model, id, key)).toThrow();
});

test("unconfirmed structural source cannot be flattened into editable source-order targets", () => {
  expect(flowPlacementModel(undefined, steps, true).valid).toBe(false);
  const model = flowPlacementModel(undefined, steps); expect(model.valid).toBe(true);
  expect(movePlacementPreview(model, "last", "root|first").command).toEqual({ type: "moveNode", nodeId: "last", beforeNodeId: "first" });
});

test.each([sequence(action("first"), action("first")), sequence(action("last"), action("first")), sequence(action("missing")), sequence(null), sequence({ kind: "action" }), sequence({ kind: "script", id: "unknown" }), sequence({ ...flow.nodes[0], predicate: { kind: "literal", value: "false" } })])("malformed or ownership/order-mismatched structure exposes no editable targets", bad => {
  const model = flowPlacementModel(bad, steps, true); expect(model.valid).toBe(false); expect(model.placements).toEqual([]);
});

test("depth/count budgets and synthesized source IDs fail visibly instead of partial placement", () => {
  let deep = sequence(action("first"), action("last"));
  for (let index = 0; index < 9; index++) deep = sequence({ ...flow.nodes[0], id: `gate${index}`, then: deep, else: sequence() });
  expect(flowPlacementModel(deep, steps).valid).toBe(false);
  expect(flowPlacementModel(undefined, Array.from({ length: 201 }, (_, index) => ({ id: `node${index}` }))).valid).toBe(false);
  expect(flowPlacementModel(undefined, [{ id: "generated", source: { action: "read" } }]).valid).toBe(false);
});
