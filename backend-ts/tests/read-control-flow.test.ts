import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { compileReadWorkflow, assertCompiledReadMatches } from "../src/workflows/compiled-read.js";
import { actionOrder, assertReadFlowCompletion, assertSelectedReadNode, parseReadControlFlow } from "../src/workflows/read-control-flow.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { applyWorkflowCommand, workflowCommandSchema } from "../src/workflows/commands.js";

const role = "Platform Admin";
const tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["admin"], output_schema: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, additionalProperties: false } } });
const action = (nodeId: string) => ({ kind: "action" as const, nodeId });
const sequence = (...nodes: any[]) => ({ kind: "sequence" as const, nodes });
const source = () => ({ name: "Read flow", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false } } }, steps: ["yes", "no", "after"].map(id => ({ id, action: "read", parameters: { id } })), metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: sequence({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: sequence(action("yes")), else: sequence(action("no")) }, action("after")) }, positions: { gate: { x: 3, y: 4 } } } });
const compile = (value: any = source()) => compileReadWorkflow(stringify(value), [tool], role);

test("versioned tree is canonical execution meaning while action declarations remain exact verifier bindings", () => {
  const plan = compile();
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-read-ir/v2", compilerVersion: "read-compiler/v2", flow: source().metadata.controlFlow.root });
  expect(actionOrder(plan.ir.flow!)).toEqual(["yes", "no", "after"]);
  const changed = source(); changed.metadata.positions.gate.x = 99;
  expect(compile(changed).semanticHash).toBe(plan.semanticHash);
  const branch = source(); branch.metadata.controlFlow.root.nodes[0].predicate = { kind: "literal", value: false };
  expect(compile(branch).semanticHash).not.toBe(plan.semanticHash);
  const forged = structuredClone(plan); (forged.ir.flow!.nodes[0] as any).predicate = { kind: "literal", value: false };
  expect(() => assertCompiledReadMatches(forged, plan)).toThrow();
});

test.each([
  (value: any) => value.metadata.controlFlow.root.nodes.push(action("yes")),
  (value: any) => value.metadata.controlFlow.root.nodes.pop(),
  (value: any) => value.metadata.controlFlow.root.nodes[0].then.nodes[0].nodeId = "unknown",
  (value: any) => value.metadata.controlFlow.root.nodes[0].id = "yes",
  (value: any) => value.metadata.controlFlow.root.nodes[0].predicate = { kind: "literal", value: "true" },
  (value: any) => value.metadata.controlFlow.root.nodes[0].predicate = { kind: "ref", source: "workflowInput", path: ["__proto__"] },
  (value: any) => value.metadata.controlFlow.root.nodes[0].predicate = { kind: "ref", source: "nodeOutput", nodeId: "yes", path: ["structuredContent", "enabled"] },
  (value: any) => value.metadata.controlFlow.root.nodes[0].onError = "continue",
  (value: any) => value.metadata.controlFlow.schemaVersion = "unknown",
])("invalid/ambiguous structure fails compilation before dispatch: %j", modify => {
  const value = source(); modify(value); expect(() => compile(value)).toThrow();
});

test.each(["no", "after"])("branch output yes cannot escape into %s", id => {
  const value = source(); value.steps.find(step => step.id === id)!.parameters.id = "{{yes.structuredContent.id}}";
  expect(() => compile(value)).toThrow(/branch-local/);
});

test("outer outputs enter both branches, but only predecessors within the same branch remain locally available", () => {
  const value = source();
  value.steps.unshift({ id: "lookup", action: "read", parameters: { id: "lookup" } });
  value.metadata.controlFlow.root.nodes.unshift(action("lookup"));
  value.metadata.controlFlow.root.nodes[1].predicate = { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "enabled"] };
  value.steps[1]!.parameters.id = "{{lookup.structuredContent.id}}"; value.steps[2]!.parameters.id = "{{lookup.structuredContent.id}}";
  expect(compile(value).ir.flow).toBeTruthy();
  const authoring = readAuthoringContract(value, [tool], role, "hash");
  expect(authoring.nodes.find(node => node.nodeId === "no")!.dataSources.some(item => item.binding.nodeId === "yes")).toBe(false);
  expect(authoring.nodes.find(node => node.nodeId === "after")!.dataSources.every(item => !["yes", "no"].includes(item.binding.nodeId!))).toBe(true);
});

test("typed predicates reject known strings/numbers rather than interpreting truthiness", () => {
  const value = source(); (value.trigger.config.inputSchema.properties.enabled as any).type = "string";
  expect(() => compile(value)).toThrow(/boolean/);
});

test("completion requires exact selected decisions, executed nodes and explicitly skipped alternatives", () => {
  const flow = compile().ir.flow!, decisions = { gate: { status: "DONE", selected: "then" as const } }, attempts = { yes: { status: "DONE" }, no: { status: "SKIPPED" }, after: { status: "DONE" } };
  expect(() => assertReadFlowCompletion(flow, decisions, attempts)).not.toThrow();
  expect(() => assertReadFlowCompletion(flow, {}, attempts)).toThrow();
  expect(() => assertReadFlowCompletion(flow, decisions, { ...attempts, no: { status: "DONE" } })).toThrow();
  expect(() => assertSelectedReadNode(flow, "no", decisions)).toThrow(/selected/);
  expect(() => assertSelectedReadNode(flow, "yes", decisions)).not.toThrow();
});

test("structural command preserves node definitions/presentation and does not grant runnable state", () => {
  const value = source(), yaml = stringify({ ...value, metadata: { positions: value.metadata.positions } });
  const command = workflowCommandSchema.parse({ type: "setControlFlow", flow: value.metadata.controlFlow });
  expect(compileReadWorkflow(applyWorkflowCommand(yaml, command), [tool], role).semanticHash).toBe(compile().semanticHash);
  expect(() => workflowCommandSchema.parse({ type: "setControlFlow", flow: { ...value.metadata.controlFlow, arbitrary: true } })).toThrow();
});

test("tree/source/control-count budgets reject oversized scopes before a runnable artifact is issued", () => {
  const value = source(); let nested = value.metadata.controlFlow.root;
  for (let i = 0; i < 10; i++) nested = sequence({ kind: "if", id: `outer_${i}`, predicate: { kind: "literal", value: true }, then: nested, else: sequence() });
  value.metadata.controlFlow.root = nested;
  expect(() => compile(value)).toThrow(/scope|limit/);
  expect(() => parseReadControlFlow({ schemaVersion: "read-control-flow/v1", root: sequence(...Array.from({ length: 201 }, () => action("yes"))) })).toThrow();
});
