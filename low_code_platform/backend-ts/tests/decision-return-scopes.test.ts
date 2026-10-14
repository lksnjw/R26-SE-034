import { expect, test } from "vitest";
import { decisionReturnScopes } from "../src/workflows/decision-return-scopes.js";
import type { ReadSequence } from "../src/workflows/read-control-flow.js";

const seq = (...nodes: ReadSequence["nodes"]): ReadSequence => ({ kind: "sequence", nodes });
const action = (nodeId: string): ReadSequence["nodes"][number] => ({ kind: "action", nodeId });
const answer = (id: string): ReadSequence["nodes"][number] => ({ kind: "return", id, output: { schema: { type: "string" }, value: { kind: "literal", value: id } } });
const gate = (id: string, yes: ReadSequence, no: ReadSequence): ReadSequence["nodes"][number] => ({ kind: "if", id, predicate: { kind: "literal", value: true }, then: yes, else: no });
const effects = new Set(["send", "other"]);

test("calendar scopes keep report ownership and one terminal answer without granting runtime authority", () => {
  const result = decisionReturnScopes(seq(action("report"), action("send"), answer("accepted")), effects);
  expect(result.maxEffects).toBe(1); expect(result.unreachable).toEqual([]); expect(result.hasCondition).toBe(false);
  expect([...result.predecessors.get("send")!]).toEqual(["report"]);
});
test.each(["early", "both"])("%s Returns make the later declared delivery unreachable", mode => {
  const early = mode === "early" ? answer("early") : gate("choice", seq(answer("yes")), seq(answer("no")));
  const result = decisionReturnScopes(seq(action("report"), early, action("send")), effects);
  expect(result.unreachable).toEqual(["send"]); expect(result.predecessors.has("send")).toBe(false); expect(result.maxEffects).toBe(0);
});
test.each([true, false])("only continuing branches can reach a parent effect; inverse=%s", inverse => {
  const ended = seq(action("send"), answer("accepted")), continuing = seq();
  const result = decisionReturnScopes(seq(action("report"), gate("choice", inverse ? ended : continuing, inverse ? continuing : ended), action("other"), answer("other_answer")), effects);
  expect(result.maxEffects).toBe(1); expect(result.unreachable).toEqual([]);
  expect([...result.predecessors.get("other")!]).toEqual(["report"]);
});
test("terminated paths retain their effect bound while continuing paths add later effects", () => {
  const result = decisionReturnScopes(seq(gate("choice", seq(action("send"), action("other"), answer("done")), seq()), action("send")), effects);
  expect(result.maxEffects).toBe(2);
});
test("branch-local reports never become sibling or parent report evidence", () => {
  const result = decisionReturnScopes(seq(gate("choice", seq(action("yes_report"), action("send"), answer("yes_answer")), seq(action("no_report"))), action("other")), effects);
  expect([...result.predecessors.get("send")!]).toEqual(["yes_report"]);
  expect([...result.predecessors.get("other")!]).toEqual([]);
});
test("unreachable nested work and answers remain explicit diagnostics", () => {
  const result = decisionReturnScopes(seq(answer("end"), gate("late", seq(action("send"), answer("late_yes")), seq(action("other"))), answer("late_final")), effects);
  expect(result.unreachable).toEqual(["send", "late_yes", "other", "late_final"]); expect(result.maxEffects).toBe(0);
});
test.each(["merge", "collection", "depth", "budget"])("unsupported calendar %s is denied, even if after Return", damage => {
  let root = seq(answer("end"));
  if (damage === "merge") root.nodes.push({ ...gate("join", seq(), seq()), merge: { schema: { type: "string" }, then: { kind: "literal", value: "yes" }, else: { kind: "literal", value: "no" } } } as any);
  if (damage === "collection") root.nodes.push({ kind: "foreach" } as any);
  if (damage === "depth") { root = seq(action("leaf")); for (let i = 0; i < 10; i++) root = seq(gate(`nested_${i}`, root, seq())); }
  if (damage === "budget") root = seq(...Array.from({ length: 2001 }, (_, i) => action(`node_${i}`)));
  expect(() => decisionReturnScopes(root, effects)).toThrow();
});
test("many independent decisions are traversed structurally without enumerating boolean combinations", () => {
  const root = seq(...Array.from({ length: 100 }, (_, i) => gate(`gate_${i}`, seq(action(`yes_${i}`)), seq(action(`no_${i}`)))), answer("end"));
  expect(decisionReturnScopes(root).predecessors.size).toBe(200);
});
