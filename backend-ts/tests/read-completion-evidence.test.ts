import { expect, test } from "vitest";
import { stringify } from "yaml";
import { compileReadWorkflow } from "../src/workflows/compiled-read.js";
import { toolSchema } from "../src/registry/schemas.js";
import { ReadCompletionEvidence, ReadEvidenceLimit, selectedReadEvidenceYAML, type CompletedRead } from "../src/workflows/read-completion-evidence.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import type { ReadVisit } from "../src/workflows/read-interpreter.js";

const role = "Platform Admin", tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } });
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes }), action = (nodeId: string) => ({ kind: "action", nodeId });
const loop = (id: string, body: any) => ({ kind: "foreach", id, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: ["a", "b"].map(value => ({ kind: "literal", value })) } }, maxItems: 3, body, collect: { schema: { type: "string" }, value: { kind: "literal", value: "confirmed" } } });
const visit = (nodeId: string, ...frames: Array<[string, number]>): ReadVisit => ({ invocationId: [...frames.flatMap(([id, index]) => [id, String(index)]), nodeId].join("/"), iterations: frames.map(([loopId, index]) => ({ loopId, index })) });
function setup(nested = false) {
  const blueprint: any = { name: "Evidence", description: "Only actual confirmed reads", trigger: { type: "manual" }, steps: ["global", "read", "inside", "after", "laterRead"].map(id => ({ id, action: "read", parameters: { id } })), metadata: { note: "preserve", controlFlow: { schemaVersion: "read-control-flow/v3", root: seq(action("global"), loop("outer", seq(...(nested ? [loop("inner", seq(action("read")))] : [action("read")]), action("inside"))), action("after"), loop("later", seq(action("laterRead")))) } } };
  const plan = compileReadWorkflow(stringify(blueprint), [tool], role); return { plan, blueprint, evidence: new ReadCompletionEvidence(plan) };
}

test("same item/enclosing reads are visible, previous item reads require completed owning collections", () => {
  const { evidence: e } = setup(); e.actionCompleted("global", { id: "global" }, visit("global")); e.collectionStarted("outer", 2, visit("outer"));
  expect(e.prior("read", visit("read", ["outer", 0])).map(item => item.visit.invocationId)).toEqual(["global"]);
  e.actionCompleted("read", { id: "invoice-a" }, visit("read", ["outer", 0])); expect(e.prior("inside", visit("inside", ["outer", 0])).map(item => item.nodeId)).toEqual(["global", "read"]);
  e.itemCompleted("outer", visit("outer", ["outer", 0])); expect(e.prior("read", visit("read", ["outer", 1])).map(item => item.nodeId)).toEqual(["global"]);
  e.actionCompleted("read", { id: "invoice-b" }, visit("read", ["outer", 1])); e.itemCompleted("outer", visit("outer", ["outer", 1]));
  expect(() => e.prior("after", visit("after"))).toThrow("incomplete collection"); e.collectionCompleted("outer", visit("outer"));
  expect(e.prior("after", visit("after")).map(item => [item.visit.invocationId, item.args])).toEqual([["global", { id: "global" }], ["outer/0/read", { id: "invoice-a" }], ["outer/1/read", { id: "invoice-b" }]]);
});

test("empty or all-skipped collections can complete but never invent a successful read", () => {
  for (const count of [0, 2]) {
    const { evidence: e } = setup(); e.collectionStarted("outer", count, visit("outer"));
    for (let index = 0; index < count; index++) e.itemCompleted("outer", visit("outer", ["outer", index]));
    e.collectionCompleted("outer", visit("outer")); expect(e.prior("after", visit("after"))).toEqual([]);
  }
});

test("nested completion exposes child reads only in the same enclosing item, then outside after the outer closes", () => {
  const { evidence: e } = setup(true); e.collectionStarted("outer", 2, visit("outer"));
  for (const index of [0, 1]) {
    e.collectionStarted("inner", 1, visit("inner", ["outer", index]));
    expect(e.prior("read", visit("read", ["outer", index], ["inner", 0]))).toEqual([]);
    e.actionCompleted("read", { id: String(index) }, visit("read", ["outer", index], ["inner", 0]));
    e.itemCompleted("inner", visit("inner", ["outer", index], ["inner", 0])); e.collectionCompleted("inner", visit("inner", ["outer", index]));
    expect(e.prior("inside", visit("inside", ["outer", index])).map(item => item.visit.invocationId)).toEqual([`outer/${index}/inner/0/read`]);
    e.itemCompleted("outer", visit("outer", ["outer", index]));
  }
  e.collectionCompleted("outer", visit("outer")); expect(e.prior("after", visit("after")).map(item => item.visit.invocationId)).toEqual(["outer/0/inner/0/read", "outer/1/inner/0/read"]);
});

test("a completed earlier collection is visible inside a different subsequent collection", () => {
  const { evidence: e } = setup(); e.collectionStarted("outer", 1, visit("outer")); e.actionCompleted("read", { id: "first" }, visit("read", ["outer", 0]));
  e.itemCompleted("outer", visit("outer", ["outer", 0])); e.collectionCompleted("outer", visit("outer")); e.collectionStarted("later", 1, visit("later"));
  expect(e.prior("laterRead", visit("laterRead", ["later", 0])).map(item => item.visit.invocationId)).toEqual(["outer/0/read"]);
});

test("started collections cannot be skipped by root queries, sibling starts or premature aggregates", () => {
  const { evidence: e } = setup(true); e.collectionStarted("outer", 2, visit("outer"));
  expect(() => e.collectionCompleted("outer", visit("outer"))).toThrow("unconfirmed collection");
  expect(() => e.collectionStarted("later", 1, visit("later"))).toThrow("incomplete collection");
  e.collectionStarted("inner", 1, visit("inner", ["outer", 0]));
  expect(() => e.itemCompleted("outer", visit("outer", ["outer", 0]))).toThrow("incomplete collection");
  expect(() => e.prior("inside", visit("inside", ["outer", 0]))).toThrow("incomplete collection");
});

test.each([-1, 4, 1.5, NaN, Infinity])("collection count %s is not completion authority", count => {
  const { evidence: e } = setup(); expect(() => e.collectionStarted("outer", count, visit("outer"))).toThrow();
});

test.each(["missing-start", "wrong-loop", "wrong-address", "wrong-index", "undeclared", "root-escape"])("%s cannot provide scoped read evidence", damage => {
  const { evidence: e } = setup(); if (damage !== "missing-start") e.collectionStarted("outer", 2, visit("outer"));
  const point = damage === "wrong-loop" ? visit("read", ["later", 0]) : damage === "wrong-index" ? visit("read", ["outer", 1]) : damage === "root-escape" ? visit("after") : damage === "undeclared" ? visit("missing", ["outer", 0]) : visit("read", ["outer", 0]);
  if (damage === "wrong-address") point.invocationId = "outer/00/read";
  expect(() => e.prior(damage === "root-escape" ? "after" : damage === "undeclared" ? "missing" : "read", point)).toThrow();
});

test("duplicate reads, repeated/skipped item indices and closed scopes cannot be reused", () => {
  const { evidence: e } = setup(); e.collectionStarted("outer", 1, visit("outer"));
  expect(() => e.collectionStarted("outer", 1, visit("outer"))).toThrow();
  e.actionCompleted("read", { id: "one" }, visit("read", ["outer", 0])); expect(() => e.actionCompleted("read", { id: "replay" }, visit("read", ["outer", 0]))).toThrow();
  expect(() => e.itemCompleted("outer", visit("outer", ["outer", 1]))).toThrow(); e.itemCompleted("outer", visit("outer", ["outer", 0]));
  expect(() => e.itemCompleted("outer", visit("outer", ["outer", 0]))).toThrow(); e.collectionCompleted("outer", visit("outer"));
  expect(() => e.collectionCompleted("outer", visit("outer"))).toThrow(); expect(() => e.prior("inside", visit("inside", ["outer", 0]))).toThrow();
});

test("private argument/frame records and returned evidence are independently cloned", () => {
  const { evidence: e } = setup(); e.collectionStarted("outer", 1, visit("outer")); const args = { id: "original" }, point = visit("read", ["outer", 0]);
  e.actionCompleted("read", args, point); args.id = "forged"; (point.iterations as any)[0].index = 9;
  const returned = e.prior("inside", visit("inside", ["outer", 0])); returned[0]!.args.id = "changed";
  expect(e.prior("inside", visit("inside", ["outer", 0]))[0]).toMatchObject({ args: { id: "original" }, visit: { iterations: [{ loopId: "outer", index: 0 }] } });
});

test("private completion snapshots retain nested item visibility and independent concrete arguments on restore", () => {
  const { plan, evidence } = setup(true); evidence.collectionStarted("outer", 2, visit("outer")); evidence.collectionStarted("inner", 1, visit("inner", ["outer", 0]));
  evidence.actionCompleted("read", { id: "a" }, visit("read", ["outer", 0], ["inner", 0])); evidence.itemCompleted("inner", visit("inner", ["outer", 0], ["inner", 0])); evidence.collectionCompleted("inner", visit("inner", ["outer", 0]));
  const snapshot = evidence.snapshot(), restored = new ReadCompletionEvidence(plan, snapshot);
  snapshot.completed[0]![1].args.id = "changed"; expect(restored.prior("inside", visit("inside", ["outer", 0]))[0]!.args).toEqual({ id: "a" });
  restored.itemCompleted("outer", visit("outer", ["outer", 0])); restored.collectionStarted("inner", 1, visit("inner", ["outer", 1]));
  expect(restored.prior("read", visit("read", ["outer", 1], ["inner", 0]))).toEqual([]);
  expect(evidence.prior("inside", visit("inside", ["outer", 0]))[0]!.args).toEqual({ id: "a" });
});

test("warm completion forks preserve independent collection counters, return cloning and cumulative argument limits", () => {
  const { evidence } = setup(); evidence.collectionStarted("outer", 2, visit("outer")); evidence.actionCompleted("read", { id: "x".repeat(600_000) }, visit("read", ["outer", 0]));
  const copy = evidence.fork(); copy.itemCompleted("outer", visit("outer", ["outer", 0]));
  expect(copy.prior("read", visit("read", ["outer", 1]))).toEqual([]); expect(evidence.prior("inside", visit("inside", ["outer", 0]))).toHaveLength(1);
  expect(() => copy.actionCompleted("read", { id: "x".repeat(600_000) }, visit("read", ["outer", 1]))).toThrow(ReadEvidenceLimit);
  const view = evidence.prior("inside", visit("inside", ["outer", 0])); view[0]!.args.id = "changed";
  expect(evidence.prior("inside", visit("inside", ["outer", 0]))[0]!.args.id).toHaveLength(600_000);
});

test.each(["duplicate", "index", "source", "parent", "count", "items", "profile"])("malformed private completion %s is rejected without granting prerequisites", damage => {
  const { plan, evidence } = setup(); evidence.collectionStarted("outer", 1, visit("outer")); evidence.actionCompleted("read", { id: "a" }, visit("read", ["outer", 0]));
  const snapshot = evidence.snapshot();
  if (damage === "duplicate") snapshot.completed.push(snapshot.completed[0]!);
  if (damage === "index") (snapshot.completed[0]![1].visit.iterations as any)[0].index = 3;
  if (damage === "source") snapshot.completed[0]![1].sourceIndex = 99;
  if (damage === "parent") snapshot.collections = [];
  if (damage === "count") snapshot.collections[0]![1].count = 4;
  if (damage === "items") snapshot.collections[0]![1].completed = true;
  if (damage === "profile") (snapshot as any).profile = "other";
  expect(() => new ReadCompletionEvidence(plan, snapshot)).toThrow();
});

test("constructor scope/limit projections cannot be mutated through the original plan", () => {
  const { evidence: e, plan } = setup(); (plan.ir.flow!.nodes[1] as any).maxItems = 0; plan.ir.root.nodes[1]!.id = "forged";
  e.collectionStarted("outer", 3, visit("outer")); expect(e.prior("read", visit("read", ["outer", 0]))).toEqual([]);
});

test.each(["bytes", "depth", "nonfinite"])("%s evidence is bounded before insertion", damage => {
  const { evidence: e } = setup(); let value: unknown = damage === "bytes" ? "x".repeat(1_000_000) : Infinity;
  if (damage === "depth") { value = "end"; for (let index = 0; index < 34; index++) value = { next: value }; }
  expect(() => e.actionCompleted("global", { value }, visit("global"))).toThrow(ReadEvidenceLimit); expect(e.prior("after", visit("after"))).toEqual([]);
});

test("expanded verifier projection preserves every repeated invocation and concrete argument set in observed order", () => {
  const { evidence: e, blueprint } = setup(); e.collectionStarted("outer", 2, visit("outer"));
  for (const index of [0, 1]) { e.actionCompleted("read", { id: String(index) }, visit("read", ["outer", index])); e.itemCompleted("outer", visit("outer", ["outer", index])); }
  e.collectionCompleted("outer", visit("outer")); const before = structuredClone(blueprint);
  const prefix = parseWorkflowYAMLStrict(selectedReadEvidenceYAML(blueprint, "after", { id: "current" }, visit("after"), e.prior("after", visit("after"))));
  expect(prefix.steps.map(step => [step.id, step.action, step.parameters])).toEqual([["outer/0/read", "read", { id: "0" }], ["outer/1/read", "read", { id: "1" }], ["after", "read", { id: "current" }]]);
  expect(prefix.metadata).toEqual({ note: "preserve" }); expect(blueprint).toEqual(before);
});

test.each(["duplicate", "source-index", "node-id", "address"])("projection rejects %s identities rather than manufacturing source steps", damage => {
  const { blueprint } = setup(); const prior: CompletedRead[] = [{ nodeId: "read", sourceIndex: 1, args: { id: "first" }, visit: visit("read", ["outer", 0]) }];
  if (damage === "duplicate") prior.push(structuredClone(prior[0]!)); if (damage === "source-index") prior[0]!.sourceIndex = 0; if (damage === "node-id") prior[0]!.nodeId = "unknown"; if (damage === "address") prior[0]!.visit.invocationId = "outer/1/read";
  expect(() => selectedReadEvidenceYAML(blueprint, "after", { id: "current" }, visit("after"), prior)).toThrow();
});

test("projection preserves unresolved-requirement blockers and bounds expanded arguments", () => {
  const { blueprint } = setup(); blueprint.metadata.unresolved_requirements = ["Delivery is not implemented"];
  expect(parseWorkflowYAMLStrict(selectedReadEvidenceYAML(blueprint, "after", { id: "current" }, visit("after"), [])).metadata!.unresolved_requirements).toEqual(["Delivery is not implemented"]);
  expect(() => selectedReadEvidenceYAML(blueprint, "after", { id: "x".repeat(1_000_000) }, visit("after"), [])).toThrow(ReadEvidenceLimit);
});
