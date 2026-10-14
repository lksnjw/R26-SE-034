import { expect, test } from "vitest";
import { ReportKeyLineage } from "../src/workflows/report-key-lineage.js";
import type { ReadBinding } from "../src/workflows/compiled-read.js";
import type { ReadSequence } from "../src/workflows/read-control-flow.js";

const seq = (...nodes: ReadSequence["nodes"]): ReadSequence => ({ kind: "sequence", nodes });
const action = (nodeId: string): ReadSequence["nodes"][number] => ({ kind: "action", nodeId });
const ref = (nodeId: string, ...path: string[]): ReadBinding => ({ kind: "ref", source: "nodeOutput", nodeId, path });
function fixture() {
  const gate: Extract<ReadSequence["nodes"][number], { kind: "if" }> = { kind: "if", id: "gate",
    predicate: { kind: "ref", source: "workflowInput", path: ["selected"] }, then: seq(action("yes")), else: seq(action("no")),
    merge: { schema: { type: "object" },
      then: { kind: "object", fields: { invoice: ref("yes", "structuredContent") } },
      else: { kind: "object", fields: { invoice: ref("no", "structuredContent") } } } };
  return { gate, root: seq(gate, action("orders")), projections: ["yes", "no"].map(nodeId => ({ nodeId, path: ["structuredContent", "orderIds"] })) };
}
test("whole report field projects exact keys for both branch histories", () => {
  const s = fixture(), proof = new ReportKeyLineage(s.root, s.projections);
  for (const id of ["yes", "no"]) expect(proof.matches(ref("gate", "value", "invoice", "orderIds"), id, "orders")).toBe(true);
  expect(proof.matches(ref("gate", "value", "invoice", "items"), "yes", "orders")).toBe(false);
});
test("direct key references remain eligible only on their owning paths", () => {
  const s = fixture(); s.gate.then.nodes.push(action("ownOrders"));
  const proof = new ReportKeyLineage(s.root, s.projections);
  expect(proof.matches(ref("yes", "structuredContent", "orderIds"), "yes", "ownOrders")).toBe(true);
  expect(proof.matches(ref("yes", "structuredContent", "orderIds"), "no", "orders")).toBe(false);
});
test.each(["literal", "input", "template", "constructed array", "model", "wrong sibling", "wrong field", "element"])(
  "key provenance rejects %s on the otherwise valid No alternative", damage => {
    const s = fixture();
    const values: Record<string, ReadBinding> = {
      literal: { kind: "literal", value: "order-1" },
      input: { kind: "ref", source: "workflowInput", path: ["orderIds"] },
      template: { kind: "template", parts: [ref("no", "structuredContent", "orderIds") as any] },
      "constructed array": { kind: "array", items: [ref("no", "structuredContent", "orderIds")] },
      model: ref("analysis", "structuredContent", "orderIds"),
      "wrong sibling": ref("yes", "structuredContent", "orderIds"),
      "wrong field": ref("no", "structuredContent", "items"),
      element: ref("no", "structuredContent", "orderIds", "0"),
    };
    s.gate.merge!.then = ref("yes", "structuredContent", "orderIds");
    s.gate.merge!.else = values[damage]!;
    const proof = new ReportKeyLineage(s.root, s.projections);
    expect(proof.matches(ref("gate", "value"), "yes", "orders")).toBe(true);
    expect(proof.matches(ref("gate", "value"), "no", "orders")).toBe(false);
  });
test("nested joins preserve only the exact selected key field", () => {
  const s = fixture(), outer: Extract<ReadSequence["nodes"][number], { kind: "if" }> = {
    kind: "if", id: "outer", predicate: { kind: "literal", value: true }, then: seq(s.gate), else: seq(action("outside")),
    merge: { schema: { type: "object" }, then: { kind: "object", fields: { payload: ref("gate", "value") } },
      else: { kind: "object", fields: { payload: { kind: "object", fields: { invoice: ref("outside", "structuredContent") } } } } } };
  const proof = new ReportKeyLineage(seq(outer, action("orders")), [...s.projections, { nodeId: "outside", path: ["structuredContent", "orderIds"] }]);
  for (const id of ["yes", "no", "outside"]) expect(proof.matches(ref("outer", "value", "payload", "invoice", "orderIds"), id, "orders")).toBe(true);
});
test("a terminated No path cannot confer vacuous key authority", () => {
  const s = fixture(); s.gate.else.nodes.push({ kind: "return", id: "stop", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  const proof = new ReportKeyLineage(s.root, s.projections);
  expect(proof.matches(ref("gate", "value", "invoice", "orderIds"), "yes", "orders")).toBe(true);
  expect(proof.matches(ref("gate", "value", "invoice", "orderIds"), "no", "orders")).toBe(false);
});
test("a common primary must be the exact source on every continuing path", () => {
  const s = fixture(); s.root.nodes.unshift(action("common"));
  s.gate.merge!.then = ref("common", "structuredContent", "orderIds");
  s.gate.merge!.else = ref("no", "structuredContent", "orderIds");
  const proof = new ReportKeyLineage(s.root, [...s.projections, { nodeId: "common", path: ["structuredContent", "orderIds"] }]);
  expect(proof.matches(ref("gate", "value"), "common", "orders")).toBe(false);
});
test("cyclic structural key sources fail closed within a bounded resolver", () => {
  const s = fixture(); s.gate.merge!.then = ref("gate", "value"); s.gate.merge!.else = ref("gate", "value");
  expect(() => new ReportKeyLineage(s.root, s.projections).matches(ref("gate", "value"), "yes", "orders")).toThrow(/cyclic/);
});
