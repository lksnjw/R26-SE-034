import { expect, test } from "vitest";
import { generatedReturnCoverageIssues } from "../src/synthesis/return-coverage.js";
import type { WorkflowBlueprint } from "../src/models/schemas.js";

const seq = (...nodes: any[]) => ({ kind: "sequence", nodes }), action = (nodeId: string) => ({ kind: "action", nodeId });
const ret = (id: string) => ({ kind: "return", id, output: { schema: { type: "string" }, value: { kind: "literal", value: "Requested result" } } });
const gate = (then: any, otherwise: any) => ({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["include"] }, then, else: otherwise });
const issues = (root: any) => generatedReturnCoverageIssues({ name: "Coverage fixture", trigger: { type: "manual" }, steps: [], metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root } } });

test("both branches returning make the next requested action structurally unreachable", () => {
  expect(issues(seq(action("read"), gate(seq(ret("yes")), seq(ret("no"))), action("send")))).toEqual([expect.stringContaining("Generated step send is unreachable")]);
});
test("one returning branch still permits the other path to perform later work", () => {
  expect(issues(seq(action("read"), gate(seq(ret("yes")), seq()), action("send"), ret("result")))).toEqual([]);
});
test("nested definite termination propagates without borrowing sibling outcomes", () => {
  expect(issues(seq(gate(seq(gate(seq(ret("first")), seq(ret("second")))), seq(ret("third"))), action("late")))).toEqual([expect.stringContaining("Generated step late is unreachable")]);
});
test("an earlier root return rejects all later branches and return outputs", () => {
  const result = issues(seq(ret("root"), gate(seq(action("one"), ret("later")), seq(action("two")))));
  expect(result).toEqual([expect.stringContaining("step one"), expect.stringContaining("step two"), expect.stringContaining("return later")]);
});
test("do not model-decide a declared predicate or suppress a possible outcome", () => {
  const node = gate(seq(ret("yes")), seq(action("read"))); node.predicate = { kind: "literal", value: true } as any;
  expect(issues(seq(node, action("possible")))).toEqual([]);
});
test("absent or invalid flow remains the strict compiler responsibility", () => {
  expect(generatedReturnCoverageIssues({} as WorkflowBlueprint)).toEqual([]);
  expect(generatedReturnCoverageIssues({ name: "Invalid fixture", trigger: { type: "manual" }, steps: [], metadata: { controlFlow: { root: {} } } })).toEqual([]);
});
test("a no-return workflow keeps existing synthesis coverage", () => {
  expect(issues(seq(action("read"), gate(seq(action("yes")), seq(action("no"))), action("send")))).toEqual([]);
});
