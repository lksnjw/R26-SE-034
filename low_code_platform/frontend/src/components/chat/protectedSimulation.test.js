import { expect, test } from "@jest/globals";
import { simulationFixturePayload, validProtectedTraceEntry } from "./protectedSimulation";

test("loop model fixtures use exact node kind and never become MCP envelopes", () => {
  const result = simulationFixturePayload({ "each/0/answer": { enabled: true, fields: { summary: "Test" }, text: "Not model output", failure: true }, unused: { enabled: false } }, [{ id: "answer", kind: "analysis" }]);
  expect(result).toEqual({ outputs: { "each/0/answer": { structuredContent: { summary: "Test" } } }, failures: {} });
});

test("fault fixtures omit retained success fields and use exact item addresses", () => {
  expect(simulationFixturePayload({ "each/1/read": { enabled: true, businessFault: true, fields: { stale: true }, text: "Retained" } }, [{ id: "read" }])).toEqual({ outputs: {}, failures: { "each/1/read": { kind: "business-read-error", code: "ERP_RESOURCE_NOT_FOUND" } } });
});

test("protected trace requires exact node kind and lexical loop ownership, never invented iterations", () => {
  const record = { authoring: { controlFlow: { kind: "sequence", nodes: [{ kind: "foreach", id: "each", maxItems: 2,
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "read" }] } }] } } };
  const entry = { nodeId: "read", kind: "action", outcome: "SUPPLIED_READ_OUTPUT", sourceIndex: 0, iterations: [{ loopId: "each", index: 1 }] };
  expect(validProtectedTraceEntry(entry, record)).toBe(true);
  for (const changed of [{ kind: "protect" }, { iterations: [] }, { iterations: [{ loopId: "invented", index: 1 }] }, { iterations: [{ loopId: "each", index: 2 }] }])
    expect(validProtectedTraceEntry({ ...entry, ...changed }, record)).toBe(false);
  expect(validProtectedTraceEntry({ ...entry, outcome: "NOT_EVALUATED", iterations: [] }, record)).toBe(true);
});
