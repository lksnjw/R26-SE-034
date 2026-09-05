import { expect, test } from "vitest";
import { initialState, type Execution } from "../src/repository/store.js";
import { splitRuntimeState, assembleRuntimeState, checkpointRecords, recordKey } from "../src/storage/execution-record-layout.js";

function state() {
  const value = initialState(); value.executions.run = { id: "run", workflowId: "wf", workflowName: "Example", status: "DONE", startedAt: "2026-10-05T00:00:00Z", completedAt: null, durationMs: 0,
    costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "owner", name: "Owner" }, finalOutput: false,
    readProgress: { profile: "read-progress-v1", epoch: 1, nextStepIndex: 1, lastSequence: 1, persistence: "durable", attempts: { node: { id: "attempt", nodeId: "node", stepIndex: 0, status: "DONE", startedAt: "now" } } },
    iterationProgress: { profile: "read-iterations/v1", sourceHash: "source", semanticHash: "semantic", inputBinding: "input", admittedRole: "owner", receipts: { "action:node": { kind: "action", nodeId: "node", invocationId: "node", sourceIndex: 0, status: "DONE", iterations: [], recordedAt: "now", seal: "sealed" } } },
    stepOutputs: { node: { content: [], structuredContent: { value: 0 } } }, valueOutputs: { answer: { value: null } } };
  value.timelines.run = [{ id: "one", output: { value: false } }, { id: "two" }]; value.timelines.empty = [];
  value.executionEvents.run = [{ version: 1, executionId: "run", workflowId: "wf", sequence: 1, timestamp: "now", type: "done", payload: {} }]; value.executionLogs.run = [{ message: "done" }];
  value.readJobs.run = { version: 1, executionId: "run", actorId: "owner", admittedRole: "owner", state: "FINISHED", requestFingerprint: "request", connectionFingerprint: "connection", idempotencyScope: "scope", createdAt: "now", inputCiphertext: "encrypted" };
  value.auditLogs = [{ id: "a" }, { id: "b" }]; value.settings.private = { secret: "preserved" }; return value;
}

test("normalizes attempts/receipts/answers/values/events/private jobs and reconstructs the exact aggregate without mutating its records", () => {
  const original = state(), records = splitRuntimeState(original), before = structuredClone(records);
  expect(assembleRuntimeState(records)).toEqual(original); expect(records).toEqual(before);
  const meta = records.find(record => record.path[0] === "executions")!.value as Execution;
  expect(meta.stepOutputs).toEqual({}); expect(meta.valueOutputs).toEqual({}); expect(meta.readProgress!.attempts).toEqual({}); expect(meta.iterationProgress!.receipts).toEqual({});
  expect(records.find(record => record.path[0] === "root")!.value).not.toHaveProperty("executions");
});
test.each(["missing-entry", "orphan-output", "unknown", "duplicate", "wrong-run", "extra-entry", "embedded-output", "array-length", "missing-root", "missing-audit", "missing-parent"])("malformed %s records fail closed rather than dropping evidence", damage => {
  let records = splitRuntimeState(state());
  if (damage === "missing-entry") records = records.filter(record => record.path[0] !== "timeline-entry" || record.path[2] !== "1");
  if (damage === "orphan-output") records.push({ profile: "runtime-record/v1", path: ["outputs", "missing", "node"], value: false });
  if (damage === "unknown") records.push({ profile: "runtime-record/v1", path: ["unknown"], value: true });
  if (damage === "duplicate") records.push(records[0]!);
  if (damage === "wrong-run") (records.find(record => record.path[0] === "executions")!.value as Execution).id = "different";
  if (damage === "extra-entry") records.push({ profile: "runtime-record/v1", path: ["timeline-entry", "run", "2"], value: {} });
  if (damage === "embedded-output") (records.find(record => record.path[0] === "executions")!.value as Execution).stepOutputs = { hidden: false };
  if (damage === "array-length") records.find(record => record.path[0] === "timelines" && record.path[1] === "run")!.value = -1;
  if (damage === "missing-root") records = records.filter(record => record.path[0] !== "root");
  if (damage === "missing-audit") records = records.filter(record => record.path[0] !== "auditLogs");
  if (damage === "missing-parent") delete (records.find(record => record.path[0] === "executions")!.value as Execution).readProgress;
  expect(() => assembleRuntimeState(records)).toThrow();
});
test("record keys preserve object-member names and separators without path collisions", () => {
  const value = state(); value.executions.run!.stepOutputs = JSON.parse('{"__proto__":{"safe":true},"a/b":0,"constructor":false}');
  const records = splitRuntimeState(value); expect(assembleRuntimeState(records)).toEqual(value);
  expect(recordKey(["a/b", "c"])).not.toBe(recordKey(["a", "b/c"]));
});
test("scoped partitions contain only the selected run and new audit entries, not the root or old audit history", () => {
  const value = state(), records = checkpointRecords({ executionId: "run", execution: value.executions.run!, timeline: value.timelines.run!, logs: value.executionLogs.run!, events: value.executionEvents.run!, job: value.readJobs.run!,
    auditStart: 2, auditAppend: [{ id: "new" }] });
  expect(records.some(record => record.path[0] === "root")).toBe(false); expect(records.filter(record => record.path[0] === "audit-entry").map(record => record.path)).toEqual([["audit-entry", "2"]]);
  expect(records.find(record => record.path[0] === "auditLogs")!.value).toBe(3);
});
