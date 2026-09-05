import { expect, test } from "@jest/globals";
import { projectIterationEvidence, projectExecutionIterationEvidence, iterationPositionLabel } from "./iterationEvidence";
import { iterationFixture } from "./iterationEvidence.fixture";
const project = s => projectIterationEvidence(s.execution, s.timeline, s.context);
test("matching item attempts/answers, typed completions and return retain every invocation separately", () => {
  const s = iterationFixture(), before = JSON.stringify(s), model = project(s);
  expect(model.valid).toBe(true); expect(model.nodes.lookup.rows.map(row => row.invocationId)).toEqual(["each/0/lookup", "each/1/lookup"]);
  expect(model.nodes.lookup.rows.map(row => row.output.structuredContent.id)).toEqual(["Answer 1", "Answer 2"]); expect(model.hasFinal).toBe(true); expect(model.finalOutput).toEqual(["Answer 1", "Answer 2"]);
  expect(model.nodes.each.rows[0]).toMatchObject({ status: "DONE", completedItems: 2, count: 2 }); expect(JSON.stringify(s)).toBe(before);
  expect(projectExecutionIterationEvidence(s.execution, s.timeline)).toEqual(model);
});
test("legacy runs are not reinterpreted as collections", () => { expect(projectIterationEvidence({ status: "DONE" }, [])).toBeNull(); });
test.each(["source", "hash", "semantic", "compilation", "profile", "node", "address", "index", "owner", "duplicate-timeline", "source-index", "kind", "extra-output", "missing-owner", "invalid-source", "duplicate-source"])("changed %s evidence cannot project item answers", change => {
  const s = iterationFixture(), ledger = s.execution.iterationProgress, receipt = ledger.receipts["action:each/0/lookup"];
  if (change === "source") s.context.yaml += "changed";
  if (change === "hash") s.context.sourceHash = `sha256:${"c".repeat(64)}`;
  if (change === "semantic") ledger.semanticHash = `sha256:${"c".repeat(64)}`;
  if (change === "compilation") delete s.execution.workflowSnapshot.compilation;
  if (change === "profile") s.execution.workflowSnapshot.executionProfile = "structured-read-v1";
  if (change === "node") receipt.nodeId = "missing";
  if (change === "address") receipt.invocationId = "each/1/lookup";
  if (change === "index") receipt.iterations[0].index = 100;
  if (change === "owner") receipt.iterations[0].loopId = "other";
  if (change === "duplicate-timeline") s.timeline.push(s.timeline[1]);
  if (change === "source-index") receipt.sourceIndex = 1;
  if (change === "kind") receipt.kind = "condition";
  if (change === "extra-output") s.execution.stepOutputs.unrelated = { content: [] };
  if (change === "missing-owner") delete ledger.receipts["collection:each"];
  if (change === "invalid-source") s.context.flow.nodes[0].maxItems = 0;
  if (change === "duplicate-source") s.context.flow.nodes[0].body.nodes.push(s.context.flow.nodes[0].body.nodes[0]);
  expect(project(s).valid).toBe(false);
});
test.each(["attempt", "timeline", "output", "missing-output", "error-output"])("unmatched %s hides that answer and dependent item/aggregate/return, but keeps earlier answers", change => {
  const s = iterationFixture(), id = "each/1/lookup";
  if (change === "attempt") s.execution.readProgress.attempts[id].id = "wrong";
  if (change === "timeline") s.timeline = s.timeline.filter(entry => entry.invocationId !== id);
  if (change === "output") s.execution.stepOutputs[id] = { content: [], structuredContent: { id: "forged" } };
  if (change === "missing-output") delete s.execution.stepOutputs[id];
  if (change === "error-output") s.execution.stepOutputs[id] = { content: [], isError: true };
  const model = project(s); expect(model.valid).toBe(true); expect(model.nodes.lookup.rows[0].output.structuredContent.id).toBe("Answer 1");
  expect(model.nodes.lookup.rows[1]).toMatchObject({ status: "UNCONFIRMED", confirmed: false }); expect(model.nodes.lookup.rows[1].output).toBeUndefined();
  expect(model.nodes.each.rows.find(row => row.kind === "collection").output).toBeUndefined(); expect(model.nodes.answer.rows[0].output).toBeUndefined();
  // The final display can still be the last good read, never the forged full report.
  expect(model.hasFinal).toBe(false);
});
test("empty collections have zero typed completions and an explicit empty aggregate", () => {
  const s = iterationFixture(0), model = project(s); expect(model.valid).toBe(true); expect(model.nodes.each.rows[0]).toMatchObject({ count: 0, completedItems: 0, output: [] }); expect(model.finalOutput).toEqual([]);
});
test("a missing typed item completion cannot be concealed by the aggregate output", () => {
  const s = iterationFixture(); delete s.execution.iterationProgress.receipts["collection-item:each/1/each"]; delete s.execution.valueOutputs["each/1/each"];
  const model = project(s); expect(model.nodes.each.rows[0].status).toBe("UNCONFIRMED"); expect(model.nodes.each.rows[0].output).toBeUndefined(); expect(model.hasFinal).toBe(false);
});
test.each([false, 0, null])("explicit return %j is retained even when falsy", value => {
  const s = iterationFixture(0); s.execution.finalOutput = value; s.execution.valueOutputs.answer = { value }; s.timeline.at(-1).output = { value };
  const model = project(s); expect(model.hasFinal).toBe(true); expect(model.finalOutput).toBe(value);
});
test.each(["PREPARING", "DISPATCH_INTENT"])("recovery preserves earlier answers and uses the matching recovered %s outcome", status => {
  const s = iterationFixture(), id = "each/1/lookup"; s.execution.status = "RECOVERY_REQUIRED"; s.execution.iterationProgress.interruptedAt = "2026-10-05T01:00:00Z";
  s.execution.iterationProgress.receipts[`action:${id}`].status = status; s.execution.readProgress.attempts[id].status = status === "PREPARING" ? "FAILED" : "UNKNOWN";
  const timeline = s.timeline.find(entry => entry.invocationId === id); timeline.status = s.execution.readProgress.attempts[id].status; timeline.outcome = status === "PREPARING" ? "NOT_DISPATCHED" : "UNKNOWN"; delete timeline.output; delete s.execution.stepOutputs[id];
  const model = project(s); expect(model.nodes.lookup.rows[0].output).toBeTruthy(); expect(model.nodes.lookup.rows[1].status).toBe(status === "PREPARING" ? "FAILED" : "UNKNOWN"); expect(model.nodes.lookup.rows[1].output).toBeUndefined(); expect(model.hasFinal).toBe(false);
});
test("position labels are one-based, nested and explicitly reject invalid frames", () => {
  expect(iterationPositionLabel([{ loopId: "each", index: 1 }, { loopId: "inner", index: 0 }])).toBe("each · item 2 / inner · item 1");
  expect(iterationPositionLabel([{ loopId: "each", index: 100 }])).toBe("Item position unconfirmed"); expect(iterationPositionLabel({})).toBe("Item position unconfirmed");
});

test("a stale authoring layout cannot place genuine item evidence under a different source scope", () => {
  const s = iterationFixture(); s.flow.nodes[0].maxItems = 3; expect(project(s).valid).toBe(false);
});
test("source key ordering does not make the current structural view stale", () => {
  const s = iterationFixture(); s.context.flow = { nodes: s.flow.nodes, kind: "sequence" }; expect(project(s).valid).toBe(true);
});
test("a failed invalid-list boundary is a known stop, not a fabricated aggregate or item", () => {
  const s = iterationFixture(0); s.execution.status = "FAILED"; delete s.execution.finalOutput;
  const receipt = s.execution.iterationProgress.receipts["collection:each"]; receipt.status = "FAILED"; delete receipt.count;
  s.execution.iterationProgress.receipts = { "collection:each": receipt }; s.execution.valueOutputs = {};
  s.timeline = [{ ...s.timeline[0], status: "FAILED", output: undefined }];
  const model = project(s); expect(model.valid).toBe(true); expect(model.nodes.each.rows[0].status).toBe("FAILED"); expect(model.nodes.each.rows[0].output).toBeUndefined(); expect(model.hasFinal).toBe(false);
});
