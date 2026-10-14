import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { compileReadWorkflow, assertCompiledReadMatches } from "../src/workflows/compiled-read.js";
import { parseReadControlFlow, assertReadFlowCompletion, assertReadValueBoundary, readFlowOutcomes } from "../src/workflows/read-control-flow.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { applyWorkflowCommand, workflowCommandSchema, selectedNodePatchSchema, selectedNodePatchVersion } from "../src/workflows/commands.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";

const role = "Platform Admin";
const tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["admin"], output_schema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } } });
const block = (...nodes: any[]) => ({ kind: "sequence", nodes });
const action = (nodeId: string) => ({ kind: "action", nodeId });
const ref = (nodeId: string, path = ["structuredContent", "id"]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const source = (): any => ({ name: "Merged read", trigger: { type: "manual" }, steps: ["yes", "no", "after"].map(id => ({ id, action: "read", parameters: { id: id === "after" ? "{{gate.value}}" : id } })), metadata: { notes: "Owner data", controlFlow: { schemaVersion: "read-control-flow/v2", root: block({ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: block(action("yes")), else: block(action("no")), merge: { schema: { type: "string" }, then: ref("yes"), else: ref("no") } }, action("after"), { kind: "return", id: "answer", output: { schema: { type: "string" }, value: ref("after") } }) } } });
const compile = (value = source()) => compileReadWorkflow(stringify(value), [tool], role);

test("typed merges and returns are versioned, pinned executable meaning, not layout metadata", () => {
  const plan = compile();
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-read-ir/v3", compilerVersion: "read-compiler/v3" });
  const changed = source(); changed.metadata.notes = "Different presentation";
  expect(compile(changed).semanticHash).toBe(plan.semanticHash);
  changed.metadata.controlFlow.root.nodes[0].merge.then = { kind: "literal", value: "explicit" };
  expect(compile(changed).semanticHash).not.toBe(plan.semanticHash);
  const forged = structuredClone(plan); (forged.ir.flow!.nodes[0] as any).merge.then.value = "forged";
  expect(() => assertCompiledReadMatches(forged, plan)).toThrow();
  const old = source(); old.metadata.controlFlow.schemaVersion = "read-control-flow/v1";
  expect(() => parseReadControlFlow(old.metadata.controlFlow)).toThrow(/v2/);
});

test.each([
  (value: any) => value.metadata.controlFlow.root.nodes[0].merge.then = ref("no"),
  (value: any) => value.metadata.controlFlow.root.nodes[0].merge.else = ref("yes"),
  (value: any) => value.metadata.controlFlow.root.nodes[0].merge.then = ref("gate", ["value"]),
  (value: any) => value.metadata.controlFlow.root.nodes[0].merge.then = ref("after"),
  (value: any) => value.metadata.controlFlow.root.nodes[0].merge.then = { kind: "literal", value: 42 },
  (value: any) => value.metadata.controlFlow.root.nodes[2].output.value = ref("yes"),
  (value: any) => value.metadata.controlFlow.root.nodes[2].output.schema = { type: "number" },
  (value: any) => value.metadata.controlFlow.root.nodes[2].output.schema = { oneOf: [{ type: "string" }] },
])("invalid typed/sibling/forward value binding fails before dispatch", modify => {
  const value = source(); modify(value); expect(() => compile(value)).toThrow();
});

test("completion requires exact typed receipts and distinguishes return skips from unselected branches", () => {
  const value = source(); value.metadata.controlFlow.root.nodes[0].then.nodes.push({ kind: "return", id: "early", output: { schema: { type: "string" }, value: ref("yes") } });
  const flow = compile(value).ir.flow!, decisions = { gate: { status: "DONE", selected: "then" as const } }, values = { early: { kind: "return", status: "DONE" } }, attempts = { yes: { status: "DONE" }, no: { status: "SKIPPED" }, after: { status: "SKIPPED" } };
  const outcomes = readFlowOutcomes(flow, decisions, values);
  expect(outcomes.returned).toBe("early");
  expect(outcomes.skipped.get("no")).toEqual({ kind: "branch", conditionId: "gate", selected: "then" });
  expect(outcomes.skipped.get("after")).toEqual({ kind: "return", returnId: "early" });
  expect(() => assertReadFlowCompletion(flow, decisions, attempts, values)).not.toThrow();
  expect(() => assertReadFlowCompletion(flow, decisions, attempts, {})).toThrow();
  expect(() => assertReadFlowCompletion(flow, decisions, attempts, { ...values, gate: { kind: "merge", status: "DONE" } })).toThrow();
  expect(() => assertReadFlowCompletion(flow, decisions, { ...attempts, after: { status: "DONE" } }, values)).toThrow();
});

test("value authoring upgrades explicitly, preserves owner data/actions and limits return model patches", () => {
  let value = source(); delete value.metadata.controlFlow.root.nodes[0].merge; value.metadata.controlFlow.root.nodes.pop(); value.metadata.controlFlow.schemaVersion = "read-control-flow/v1";
  value.steps[2].parameters.id = "after";
  let yaml = stringify(value);
  const edit = (command: unknown) => { yaml = applyWorkflowCommand(yaml, workflowCommandSchema.parse(command)); };
  edit({ type: "setConditionMerge", nodeId: "gate", merge: source().metadata.controlFlow.root.nodes[0].merge });
  edit({ type: "addReturn", nodeId: "answer", beforeNodeId: null, output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  edit({ type: "updateReturn", nodeId: "answer", patch: { output: { schema: { type: "number" }, value: { kind: "literal", value: 0 } } } });
  const saved = parseWorkflowYAMLStrict(yaml);
  expect(saved.steps).toEqual(value.steps); expect(saved.metadata!.notes).toBe("Owner data");
  expect(parseReadControlFlow(saved.metadata!.controlFlow)).toMatchObject({ schemaVersion: "read-control-flow/v2", root: { nodes: [expect.anything(), expect.anything(), { kind: "return", id: "answer", output: { value: { value: 0 } } }] } });
  expect(selectedNodePatchVersion({ kind: "return" })).toBe("prompt/return-patch/v1");
  expect(() => selectedNodePatchSchema({ kind: "return" }).parse({ action: "read" })).toThrow();
  expect(() => selectedNodePatchSchema({ kind: "return" }).parse({ output: source().metadata.controlFlow.root.nodes[2].output, id: "escape" })).toThrow();
  edit({ type: "removeReturn", nodeId: "answer" }); edit({ type: "setConditionMerge", nodeId: "gate", merge: null });
  expect(parseWorkflowYAMLStrict(yaml).steps).toEqual(value.steps);
  expect(compileReadWorkflow(yaml, [tool], role).ir.schemaVersion).toBe("workflow-read-ir/v3");
});

test("typed authoring hints expose only declared merged values and branch-local choices in their own scope", () => {
  const guide = readAuthoringContract(parseWorkflowYAMLStrict(stringify(source())), [tool], role, "hash");
  expect(guide.executionProfile).toBe("structured-read-v1");
  expect(guide.nodes.find(node => node.nodeId === "after")!.dataSources.map(source => source.expression)).toContain("{{gate.value}}");
  expect(guide.nodes.find(node => node.nodeId === "after")!.dataSources.every(source => !["yes", "no"].includes(source.binding.nodeId!))).toBe(true);
  expect(guide.conditions![0]!.mergeSources.then.some(source => source.binding.nodeId === "yes")).toBe(true);
  expect(guide.conditions![0]!.mergeSources.then.some(source => source.binding.nodeId === "no")).toBe(false);
  expect(guide.returns![0]!.dataSources.some(source => source.binding.nodeId === "after")).toBe(true);
});

test("value checkpoints cannot jump over an earlier merge or confirm the wrong branch attempts", () => {
  const flow = compile().ir.flow!, decisions = { gate: { status: "DONE", selected: "then" as const } }, attempts = { yes: { status: "DONE" }, no: { status: "SKIPPED" }, after: { status: "DONE" } };
  expect(() => assertReadValueBoundary(flow, "answer", "return", decisions, attempts, {})).toThrow(/Earlier typed/);
  expect(() => assertReadValueBoundary(flow, "gate", "merge", decisions, { ...attempts, no: { status: "DONE" } }, {})).toThrow(/Unselected/);
  expect(() => assertReadValueBoundary(flow, "answer", "return", decisions, attempts, { gate: { kind: "merge", status: "DONE" } })).not.toThrow();
});
