import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { compileReadWorkflow } from "../src/workflows/compiled-read.js";
import { parseReadControlFlow, assertReadFlowCompletion, assertReadValueBoundary } from "../src/workflows/read-control-flow.js";
import { parseReadFixtures, simulateReadWorkflow } from "../src/workflows/read-simulation.js";
import { inspectReadWorkflow } from "../src/runner/read-workflow.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { draftFlow, saveDraftFlow } from "../src/workflows/draft-control-edits.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { selectedNodePatchSchema } from "../src/workflows/commands.js";

const role = "Platform Admin", tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes });
const action = (nodeId: string) => ({ kind: "action", nodeId });
const ref = (nodeId: string, path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const array = { type: "array", items: { type: "string" } };
function source(): any { return { name: "Invoice collection", description: "Read a bounded supplied list", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id"], additionalProperties: false } } }, required: ["rows"], additionalProperties: false } } }, steps: [{ id: "read", action: "read", parameters: { id: "{{each.item.id}}" } }, { id: "after", action: "read", parameters: { id: "after" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: seq({ kind: "foreach", id: "each", items: { schema: { type: "array", items: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id"], additionalProperties: false } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, maxItems: 3, body: seq(action("read")), collect: { schema: { type: "string" }, value: ref("read", ["structuredContent", "id"]) } }, action("after"), { kind: "return", id: "answer", output: { schema: array, value: ref("each", ["value"]) } }) } } }; }
const output = (id: string) => ({ content: [], structuredContent: { id } });
test("collection owners use a dedicated partial patch instead of ordinary action chat semantics", () => {
  const patch = selectedNodePatchSchema({ kind: "foreach" });
  expect(patch.parse({ maxItems: 2 })).toEqual({ maxItems: 2 });
  for (const value of [{}, { action: "read" }, { parameters: { id: "other" } }, { body: seq() }, { id: "other", maxItems: 2 }, { maxItems: 0 }, { maxItems: 101 }, { maxItems: 1.5 }])
    expect(patch.safeParse(value).success).toBe(false);
});
async function simulate(src: any, input: any, outputs: Record<string, unknown>) { const yaml = stringify(src); return simulateReadWorkflow(yaml, input, parseReadFixtures({ profile: "read-fixtures/v2", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs }), [tool], role); }

test("collection compilation has immutable v4 identity, bounded item scope and denies unqualified live execution", () => {
  const src = source(), plan = compileReadWorkflow(stringify(src), [tool], role);
  expect(plan.ir.schemaVersion).toBe("workflow-read-ir/v4"); expect(plan.ir.compilerVersion).toBe("read-compiler/v4");
  expect(plan.ir.root.nodes.map(node => node.id)).toEqual(["read", "after"]); expect(inspectReadWorkflow(src, [tool], role)).toContain("Collection execution requires reviewed SDK entry and qualified private record storage; fixture simulation remains available");
  src.metadata.controlFlow.root.nodes[0].maxItems = 2; expect(compileReadWorkflow(stringify(src), [tool], role).semanticHash).not.toBe(plan.semanticHash);
  expect(() => assertReadFlowCompletion(plan.ir.flow!, {}, {})).toThrow(/iteration/); expect(() => assertReadValueBoundary(plan.ir.flow!, "answer", "return", {}, {}, {})).toThrow(/iteration/);
});

test("per-iteration responses preserve actual arguments and distinct answers without overwriting", async () => {
  const value = await simulate(source(), { rows: [{ id: "invoice-a" }, { id: "invoice-b" }] }, { "each/0/read": output("first"), "each/1/read": output("second"), after: output("after") });
  expect(value).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: ["first", "second"], stepOutputs: { "each/0/read": output("first"), "each/1/read": output("second") }, valueOutputs: { each: { value: ["first", "second"] }, "each/0/each": { value: "first" }, "each/1/each": { value: "second" } } });
  expect(value.trace.filter(entry => entry.kind === "action").map(entry => [entry.invocationId, entry.arguments])).toEqual([["each/0/read", { id: "invoice-a" }], ["each/1/read", { id: "invoice-b" }], ["after", { id: "after" }]]);
});

test("an empty collection has an explicit empty result and no body fixture requirement", async () => {
  const value = await simulate(source(), { rows: [] }, { after: output("after"), "each/0/read": output("unused") });
  expect(value).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: [], usedFixtureIds: ["after"], unusedFixtureIds: ["each/0/read"] }); expect(value.trace.find(entry => entry.nodeId === "read")).toMatchObject({ outcome: "EMPTY_COLLECTION" });
});

test.each([undefined, null, {}, "rows", [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]])("missing/invalid/oversized collection %j fails without evaluating the body", async rows => {
  const src = source(); delete src.trigger.config; const value = await simulate(src, rows === undefined ? {} : { rows }, {});
  expect(value.outcome).toBe("SIMULATED_STOPPED"); expect(value.usedFixtureIds).toEqual([]); expect(value.trace.every(entry => entry.kind === "collection")).toBe(true);
});

test("missing later iteration does not reuse a prior answer or claim a complete collection", async () => {
  const value = await simulate(source(), { rows: [{ id: "a" }, { id: "b" }] }, { "each/0/read": output("first"), after: output("not-used") });
  expect(value).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "MISSING_FIXTURE", stepOutputs: { "each/0/read": output("first") }, usedFixtureIds: ["each/0/read"], unusedFixtureIds: ["after"] }); expect(value.valueOutputs.each).toBeUndefined(); expect(value.trace.at(-1)).toMatchObject({ invocationId: "each/1/read", arguments: { id: "b" } });
});

test.each(["item-escape", "local-escape", "self-result", "wrong-item-type", "return-in-body", "excess-budget", "old-profile"])("compiler rejects collection %s", damage => {
  const src = source(), loop = src.metadata.controlFlow.root.nodes[0];
  if (damage === "item-escape") src.steps[1].parameters.id = "{{each.item.id}}";
  if (damage === "local-escape") src.steps[1].parameters.id = "{{read.structuredContent.id}}";
  if (damage === "self-result") loop.collect.value = ref("each", ["value"]);
  if (damage === "wrong-item-type") { loop.items.schema.items.properties.id.type = "integer"; src.trigger.config.inputSchema.properties.rows.items.properties.id.type = "integer"; }
  if (damage === "return-in-body") loop.body.nodes.push({ kind: "return", id: "early", output: { schema: { type: "string" }, value: { kind: "literal", value: "early" } } });
  if (damage === "excess-budget") { loop.maxItems = 100; loop.body.nodes = seq(...Array.from({ length: 30 }, (_, i) => ({ kind: "if", id: `gate${i}`, predicate: { kind: "literal", value: false }, then: seq(), else: seq() })), action("read")).nodes; }
  if (damage === "old-profile") src.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
  expect(() => compileReadWorkflow(stringify(src), [tool], role)).toThrow();
});

test("nested collections bind only the current item and retain full iteration paths", async () => {
  const src = source(), outer = src.metadata.controlFlow.root.nodes[0]; delete src.trigger.config;
  outer.items.schema = { type: "array", items: { type: "array", items: { type: "string" } } }; outer.collect = { schema: array, value: ref("inner", ["value"]) };
  outer.body = seq({ kind: "foreach", id: "inner", items: { schema: array, value: ref("each", ["item"]) }, maxItems: 3, body: seq(action("read")), collect: { schema: { type: "string" }, value: ref("read", ["structuredContent", "id"]) } });
  src.steps[0].parameters.id = "{{inner.item}}"; src.metadata.controlFlow.root.nodes[2].output.schema = { type: "array", items: array };
  const value = await simulate(src, { rows: [["a", "b"], ["c"]] }, { "each/0/inner/0/read": output("A"), "each/0/inner/1/read": output("B"), "each/1/inner/0/read": output("C"), after: output("after") });
  expect(value).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: [["A", "B"], ["C"]] });
  expect(value.trace.find(entry => entry.invocationId === "each/1/inner/0/read")).toMatchObject({ arguments: { id: "c" }, iterations: [{ loopId: "each", index: 1 }, { loopId: "inner", index: 0 }] });
});

test("draft structural round trip preserves collection ownership and v3 after removing all loop nodes", () => {
  const src = source(), root = draftFlow(src); expect(root.nodes[0]!.kind).toBe("foreach"); saveDraftFlow(src, root); expect(src.metadata.controlFlow.schemaVersion).toBe("read-control-flow/v3");
  src.steps = [src.steps[1]]; root.nodes = [root.nodes[1]!]; saveDraftFlow(src, root); expect(src.metadata.controlFlow.schemaVersion).toBe("read-control-flow/v3");
});

test.each(["read", "each/3/read", "other/0/read", "each/00/read", "each/-1/read", "each/0/other", "each/0/read/extra", "__proto__/0/read"])("wrong or ambiguous fixture address %s is rejected", async address => {
  await expect(simulate(source(), { rows: [] }, { [address]: output("bad") })).rejects.toThrow();
});

test("v1 fixtures cannot pretend one answer covers every collection iteration", async () => {
  const yaml = stringify(source()); await expect(simulateReadWorkflow(yaml, { rows: [] }, parseReadFixtures({ profile: "read-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: {} }), [tool], role)).rejects.toThrow(/per-iteration/);
  expect(() => parseReadControlFlow({ ...source().metadata.controlFlow, schemaVersion: "read-control-flow/v1" })).toThrow();
});

test("authoring offers current loop item/index only inside its body, and collected values only after completion", () => {
  const value = readAuthoringContract(source(), [tool], role, "registry");
  expect(value.executionProfile).toBe("collection-simulation-only");
  expect(value.nodes[0]!.dataSources.map(item => item.expression)).toContain("{{each.item.id}}");
  expect(value.nodes[0]!.dataSources.map(item => item.expression)).not.toContain("{{each.value}}");
  expect(value.nodes[1]!.dataSources.map(item => item.expression)).toContain("{{each.value}}");
  expect(value.nodes[1]!.dataSources.map(item => item.expression)).not.toContain("{{each.item.id}}");
});

test("selected-path prerequisites from one iteration cannot authorize an unselected action in the next", async () => {
  const src = source(), loop = src.metadata.controlFlow.root.nodes[0]; src.steps.splice(1, 0, { id: "dependent", action: "read", parameters: { id: "dependent" } });
  loop.body = seq({ kind: "if", id: "gate", predicate: ref("each", ["item", "enabled"]), then: seq(action("read")), else: seq(), merge: { schema: { type: "string" }, then: ref("read", ["structuredContent", "id"]), else: ref("each", ["item", "id"]) } }, action("dependent")); loop.collect.value = ref("gate", ["value"]);
  const yaml = stringify(src), fixtures = parseReadFixtures({ profile: "read-fixtures/v2", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: { "each/0/read": output("first"), "each/0/dependent": output("ok"), "each/1/dependent": output("not-used") } });
  const result = await simulateReadWorkflow(yaml, { rows: [{ id: "a", enabled: true }, { id: "b", enabled: false }] }, fixtures, [tool], role, (id, _args, prior) => id !== "dependent" || prior.some(item => item.nodeId === "read"));
  expect(result).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "SELECTED_PATH_RULE_BLOCKED", usedFixtureIds: ["each/0/read", "each/0/dependent"] });
  expect(result.trace.at(-1)).toMatchObject({ invocationId: "each/1/dependent" });
});
