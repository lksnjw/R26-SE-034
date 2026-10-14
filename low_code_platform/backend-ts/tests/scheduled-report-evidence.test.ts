import { expect, test, vi } from "vitest";
import { compileScheduledReportEvidence, scheduledReportHistories, selectScheduledReportEvidence } from "../src/runner/scheduled-report-evidence.js";
import type { ReadSequence } from "../src/workflows/read-control-flow.js";

const seq = (...nodes: ReadSequence["nodes"]): ReadSequence => ({ kind: "sequence", nodes });
const action = (nodeId: string): ReadSequence["nodes"][number] => ({ kind: "action", nodeId });
const returned = (): ReadSequence["nodes"][number] => ({ kind: "return", id: "answer", output: { schema: { type: "string" }, value: { kind: "literal", value: "Explicit no effect" } } });
const choice = (id: string, yes: ReadSequence, no: ReadSequence, merge = true): ReadSequence["nodes"][number] => ({ kind: "if", id,
  predicate: { kind: "ref", source: "workflowInput", path: [id] }, then: yes, else: no,
  ...(merge ? { merge: { schema: { type: "string" }, then: { kind: "literal", value: "yes" }, else: { kind: "literal", value: "no" } } } : {}) });
function compile(root: ReadSequence, reports = ["yes", "no"]) {
  const histories = scheduledReportHistories(root, new Set(reports), new Set(["send"]));
  const validate = vi.fn((ids: readonly string[]) => { if (!ids.length || ids.length > 2) throw new Error("Complete report evidence required"); return [...ids]; });
  return { evidence: compileScheduledReportEvidence(histories.get("send")!, validate), validate };
}
const progress = (id: string, selected: "then" | "else"): any => ({ decisions: { [id]: { status: "DONE", selected } }, values: { [id]: { kind: "merge", status: "DONE" } } });

test.each(["then", "else"] as const)("join proves both alternatives, then requires only selected %s reports", selected => {
  const { evidence, validate } = compile(seq(choice("gate", seq(action("yes")), seq(action("no"))), action("send")));
  expect(validate.mock.calls.map(call => call[0])).toEqual([["yes"], ["no"]]);
  expect(selectScheduledReportEvidence(evidence, progress("gate", selected))).toEqual([selected === "then" ? "yes" : "no"]);
});
test.each([true, false])("a merged summary cannot substitute absent complete report evidence; explicit merge=%s", merge => {
  expect(() => compile(seq(choice("gate", seq(action("yes")), seq(), merge), action("send")))).toThrow("Complete report evidence required");
});
test("continuing paths retain ordered common primary and selected related reports", () => {
  const { evidence, validate } = compile(seq(action("primary"), choice("gate", seq(action("yes")), seq(action("no"))), action("send")), ["primary", "yes", "no"]);
  expect(validate.mock.calls.map(call => call[0])).toEqual([["primary", "yes"], ["primary", "no"]]);
  expect(selectScheduledReportEvidence(evidence, progress("gate", "else"))).toEqual(["primary", "no"]);
});
test("a returned alternative cannot borrow its continuing sibling's coverage to send later", () => {
  const { evidence } = compile(seq(choice("gate", seq(returned()), seq(action("no"))), action("send")));
  expect(selectScheduledReportEvidence(evidence, progress("gate", "else"))).toEqual(["no"]);
  expect(() => selectScheduledReportEvidence(evidence, progress("gate", "then"))).toThrow("terminated");
});
test.each(["decision missing", "decision pending", "selection invalid", "merge missing", "merge failed", "not a merge"])("selected coverage fails closed: %s", damage => {
  const { evidence } = compile(seq(choice("gate", seq(action("yes")), seq(action("no"))), action("send"))), state = progress("gate", "then");
  if (damage === "decision missing") delete state.decisions.gate;
  if (damage === "decision pending") state.decisions.gate.status = "PENDING";
  if (damage === "selection invalid") state.decisions.gate.selected = "invented";
  if (damage === "merge missing") delete state.values.gate;
  if (damage === "merge failed") state.values.gate.status = "FAILED";
  if (damage === "not a merge") state.values.gate.kind = "return";
  expect(() => selectScheduledReportEvidence(evidence, state)).toThrow("acknowledged");
});
test("nested joins select exact receipts without materializing inactive alternatives", () => {
  const { evidence } = compile(seq(choice("outer", seq(choice("inner", seq(action("yes")), seq(action("no")))), seq(action("outside"))), action("send")), ["yes", "no", "outside"]);
  const state = progress("outer", "then"); Object.assign(state.decisions, progress("inner", "else").decisions); Object.assign(state.values, progress("inner", "else").values);
  expect(selectScheduledReportEvidence(evidence, state)).toEqual(["no"]);
});
test("independent no-report choices share prefixes rather than enumerate 2^100 outcomes", () => {
  const decisions = Array.from({ length: 100 }, (_, i) => choice(`gate${i}`, seq(), seq()));
  const { evidence, validate } = compile(seq(action("yes"), ...decisions, action("send")));
  expect(validate).toHaveBeenCalledTimes(1); expect(selectScheduledReportEvidence(evidence, {})).toEqual(["yes"]);
});
test.each(["third report", "collection", "depth", "visits"])("calendar history fails closed on unsupported %s", damage => {
  let root = seq(action("yes"), action("no"), action("third"), action("send"));
  if (damage === "collection") root = seq({ kind: "foreach" } as any);
  if (damage === "depth") { root = seq(action("yes"), action("send")); for (let i = 0; i < 10; i++) root = seq(choice(`gate${i}`, root, seq())); }
  if (damage === "visits") root = seq(...Array.from({ length: 2001 }, (_, i) => action(`node${i}`)));
  expect(() => compile(root, ["yes", "no", "third"])).toThrow();
});
