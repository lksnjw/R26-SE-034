import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { parseReadFixtures, simulateReadWorkflow } from "../src/workflows/read-simulation.js";
import { resolveReadBinding, type ReadBinding } from "../src/workflows/compiled-read.js";
import { workflowContentHash } from "../src/parser/workflow.js";

const role = "Platform Admin", tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
const action = (nodeId: string) => ({ kind: "action", nodeId }), block = (...nodes: any[]) => ({ kind: "sequence", nodes });
const ref = (nodeId: string, path = ["structuredContent", "id"]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const source = (): any => ({ name: "Simulated branches", description: "Use supplied test data only", trigger: { type: "manual" }, steps: ["yes", "no", "after"].map(id => ({ id, action: "read", parameters: { id: id === "after" ? "{{gate.value}}" : id } })), metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: block({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: block(action("yes")), else: block(action("no")), merge: { schema: { type: "string" }, then: ref("yes"), else: ref("no") } }, action("after"), { kind: "return", id: "answer", output: { schema: { type: "string" }, value: ref("after") } }) } } });
const result = (id: string) => ({ content: [], structuredContent: { id } });
const fixture = (yaml: string, outputs: Record<string, unknown>) => parseReadFixtures({ profile: "read-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs });

test.each([true, false])("fixture evaluation takes the selected branch and resolves its explicit merge, enabled=%s", async enabled => {
  const yaml = stringify(source()), outputs = { yes: result("actual-yes"), no: result("actual-no"), after: result("final") };
  const input = { enabled }, data = fixture(yaml, outputs), before = structuredClone({ input, data });
  const value = await simulateReadWorkflow(yaml, input, data, [tool], role);
  expect(value).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: "final", valueOutputs: { gate: { value: enabled ? "actual-yes" : "actual-no" }, answer: { value: "final" } } });
  expect(value.trace.find(entry => entry.nodeId === "after")!.arguments).toEqual({ id: enabled ? "actual-yes" : "actual-no" });
  expect(value.usedFixtureIds).toEqual([enabled ? "yes" : "no", "after"]); expect(value.unusedFixtureIds).toEqual([enabled ? "no" : "yes"]);
  expect(value.trace.find(entry => entry.nodeId === (enabled ? "no" : "yes"))).toMatchObject({ outcome: "NOT_SELECTED", sourceIndex: enabled ? 1 : 0 });
  expect({ input, data }).toEqual(before); expect(value.trace.every(entry => entry.outcome !== "DONE")).toBe(true);
});

test.each([undefined, null, "false", 0, {}])("invalid predicate %j stops before any fixture action, never selecting false", async enabled => {
  const yaml = stringify(source()), value = await simulateReadWorkflow(yaml, enabled === undefined ? {} : { enabled }, fixture(yaml, {}), [tool], role);
  expect(value).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "PREDICATE_INVALID", failedNodeId: "gate", usedFixtureIds: [] }); expect(value.trace).toHaveLength(1);
});

test.each([false, 0, null])("root return preserves %j and does not require/evaluate unused branch fixtures", async final => {
  const src = source(); src.metadata.controlFlow.root.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: final === null ? "null" : typeof final }, value: { kind: "literal", value: final } } });
  const yaml = stringify(src), value = await simulateReadWorkflow(yaml, {}, fixture(yaml, {}), [tool], role);
  expect(value).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: final, usedFixtureIds: [] });
  expect(value.trace.map(entry => [entry.nodeId, entry.outcome])).toEqual([["early", "SIMULATED_VALUE"], ["yes", "AFTER_RETURN"], ["no", "AFTER_RETURN"], ["after", "AFTER_RETURN"]]);
});

test("missing selected fixture retains preceding simulation evidence without invented output", async () => {
  const yaml = stringify(source()), value = await simulateReadWorkflow(yaml, { enabled: true }, fixture(yaml, { yes: result("actual") }), [tool], role);
  expect(value).toMatchObject({ outcome: "SIMULATED_STOPPED", failedNodeId: "after", reason: "MISSING_FIXTURE", stepOutputs: { yes: result("actual") }, valueOutputs: { gate: { value: "actual" } } });
  expect(value.stepOutputs.after).toBeUndefined(); expect(value.trace.at(-1)!.arguments).toEqual({ id: "actual" });
});

test.each([{ content: [], structuredContent: {} }, { content: [], structuredContent: { id: 7 } }])("missing/wrong merge data %j stops later fixture use", async output => {
  const yaml = stringify(source()), value = await simulateReadWorkflow(yaml, { enabled: true }, fixture(yaml, { yes: output, after: result("not used") }), [tool], role);
  expect(value).toMatchObject({ outcome: "SIMULATED_STOPPED", failedNodeId: "gate", reason: "VALUE_INVALID", usedFixtureIds: ["yes"], unusedFixtureIds: ["after"] }); expect(value.valueOutputs.gate).toBeUndefined();
});

test.each([{ content: [], isError: true }, { content: "wrong" }, { content: [{ type: "html", text: "unsafe" }] }])("fixture failure/malformed output %j does not become a simulated answer", async output => {
  const yaml = stringify(source()), value = await simulateReadWorkflow(yaml, { enabled: true }, fixture(yaml, { yes: output }), [tool], role);
  expect(value.outcome).toBe("SIMULATED_STOPPED"); expect(value.stepOutputs).toEqual({}); expect(value.valueOutputs).toEqual({});
});

test("output schema and selected-path rule checks are not bypassed by fixtures", async () => {
  const yaml = stringify(source()), data = fixture(yaml, { yes: result("actual") });
  const strict = toolSchema.parse({ ...tool, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } } });
  expect(await simulateReadWorkflow(yaml, { enabled: true }, data, [strict], role)).toMatchObject({ reason: "FIXTURE_OUTPUT_INVALID" });
  expect(await simulateReadWorkflow(yaml, { enabled: true }, data, [tool], role, () => false)).toMatchObject({ reason: "SELECTED_PATH_RULE_BLOCKED" });
});

test("fixture credential fields are redacted before trace, bindings and returned values", async () => {
  const yaml = stringify(source()), value = await simulateReadWorkflow(yaml, { enabled: true }, fixture(yaml, { yes: { content: [], structuredContent: { id: "actual", api_token: "private-value" } }, after: result("done") }), [tool], role);
  expect(value.outcome).toBe("SIMULATED_COMPLETE"); expect(JSON.stringify(value)).not.toContain("private-value");
});

test("expanded references hit a bounded value budget before multiplying fixture data", () => {
  const ref: ReadBinding = { kind: "ref", source: "workflowInput", path: ["large"] };
  expect(() => resolveReadBinding({ kind: "array", items: Array.from({ length: 30 }, () => ref) }, { input: { large: "x".repeat(100000) } })).toThrow(/byte limits/);
  expect(() => resolveReadBinding({ kind: "template", parts: Array.from({ length: 30 }, () => ref) }, { input: { large: "x".repeat(100000) } })).toThrow(/byte limits/);
});

test("expanded references bound depth, node count and finite JSON while preserving falsey values", () => {
  const reference: ReadBinding = { kind: "ref", source: "workflowInput", path: ["value"] };
  let deep: unknown = 1; for (let i = 0; i < 34; i++) deep = { next: deep };
  expect(() => resolveReadBinding(reference, { input: { value: deep } })).toThrow(/structural limits/);
  expect(() => resolveReadBinding(reference, { input: { value: Array(32769).fill(null) } })).toThrow(/structural limits/);
  expect(() => resolveReadBinding(reference, { input: { value: Infinity } })).toThrow(/finite JSON/);
  for (const value of [false, 0, "", null]) expect(resolveReadBinding(reference, { input: { value } })).toEqual(value);
});

test("fixture schema bounds before recursive processing and rejects unknown profiles/keys/nodes", async () => {
  const yaml = stringify(source());
  expect(() => parseReadFixtures({ profile: "other", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: {} })).toThrow();
  expect(() => parseReadFixtures({ profile: "read-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: {}, approved: true })).toThrow();
  expect(() => fixture(yaml, { yes: result("x".repeat(512000)) })).toThrow(/byte limits/);
  await expect(simulateReadWorkflow(yaml, {}, fixture(yaml, { unknown: result("x") }), [tool], role)).rejects.toThrow(/declared action/);
});
