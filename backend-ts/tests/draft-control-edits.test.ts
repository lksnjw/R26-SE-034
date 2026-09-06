import { expect, test } from "vitest";
import { stringify } from "yaml";
import { workflowCommandSchema, applyWorkflowCommand } from "../src/workflows/commands.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { actionOrder, parseReadControlFlow, controlNodes } from "../src/workflows/read-control-flow.js";
import { compileReadWorkflow } from "../src/workflows/compiled-read.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { toolSchema } from "../src/registry/schemas.js";

const role = "Platform Admin";
const tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["admin"], output_schema: { type: "object", properties: { ready: { type: "boolean" }, api_token: { type: "boolean" }, secret: { type: "boolean", writeOnly: true }, id: { type: "string" } } } } });
const base = stringify({ name: "Editable branches", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { enabled: { type: "boolean" }, name: { type: "string" } } } } }, steps: ["first", "last"].map(id => ({ id, action: "read", parameters: { id } })), metadata: { ownerNotes: "Preserve me" } });
const edit = (source: string, command: unknown) => applyWorkflowCommand(source, workflowCommandSchema.parse(command));
const wrap = (source = base) => edit(source, { type: "wrapNode", nodeId: "first", conditionId: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, branch: "then" });
const tree = (source: string) => parseReadControlFlow(parseWorkflowYAMLStrict(source).metadata!.controlFlow).root;

test("wrapping preserves action definitions, unrelated metadata and explicit opposite empty scope", () => {
  const source = wrap(), blueprint = parseWorkflowYAMLStrict(source);
  expect(blueprint.steps).toEqual(parseWorkflowYAMLStrict(base).steps);
  expect(blueprint.metadata!.ownerNotes).toBe("Preserve me");
  expect(tree(source).nodes[0]).toMatchObject({ kind: "if", id: "gate", then: { nodes: [{ kind: "action", nodeId: "first" }] }, else: { nodes: [] } });
  expect(compileReadWorkflow(source, [tool], role).ir.flow).toBeTruthy();
});

test("add/move/remove keep catalog in structural order and never change action arguments", () => {
  let source = wrap();
  source = edit(source, { type: "addNode", node: { id: "alternate", action: "read", parameters: { id: "unchanged" } }, beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } });
  expect(actionOrder(tree(source))).toEqual(["first", "alternate", "last"]);
  source = edit(source, { type: "moveNode", nodeId: "last", beforeNodeId: null, destination: { conditionId: "gate", branch: "then" } });
  expect(actionOrder(tree(source))).toEqual(["first", "last", "alternate"]);
  expect(parseWorkflowYAMLStrict(source).steps.map(step => [step.id, step.parameters!.id])).toEqual([["first", "first"], ["last", "last"], ["alternate", "unchanged"]]);
  expect(compileReadWorkflow(source, [tool], role).ir.flow).toBeTruthy();
  source = edit(source, { type: "removeNode", nodeId: "first" });
  expect(actionOrder(tree(source))).toEqual(["last", "alternate"]);
  source = edit(source, { type: "moveNode", nodeId: "last", beforeNodeId: null });
  expect(actionOrder(tree(source))).toEqual(["alternate", "last"]);
});

test("before-node insertion follows its actual branch scope instead of making a root action", () => {
  const source = edit(wrap(), { type: "addNode", node: { id: "prior", action: "read", parameters: { id: "prior" } }, beforeNodeId: "first" });
  expect(tree(source).nodes[0]).toMatchObject({ then: { nodes: [{ nodeId: "prior" }, { nodeId: "first" }] } });
  expect(compileReadWorkflow(source, [tool], role).ir.flow).toBeTruthy();
});

test("empty conditions can be explicitly added, edited and removed without flattening nonempty paths", () => {
  let source = edit(base, { type: "addCondition", conditionId: "empty", predicate: { kind: "literal", value: false }, beforeNodeId: "last" });
  source = edit(source, { type: "updateCondition", nodeId: "empty", patch: { predicate: { kind: "literal", value: true } } });
  expect(controlNodes(tree(source))[0]!.predicate).toEqual({ kind: "literal", value: true });
  source = edit(source, { type: "removeCondition", nodeId: "empty" });
  expect(parseWorkflowYAMLStrict(source).steps).toEqual(parseWorkflowYAMLStrict(base).steps);
  expect(() => edit(wrap(), { type: "removeCondition", nodeId: "gate" })).toThrow(/contents/);
});

test("a scope-changing move preserves broken references as blocked data rather than rewriting them", () => {
  const blueprint = parseWorkflowYAMLStrict(base); blueprint.steps[1]!.parameters = { id: "{{first.structuredContent.id}}" };
  const source = wrap(stringify(blueprint));
  expect(() => compileReadWorkflow(source, [tool], role)).toThrow(/branch-local/);
  expect(parseWorkflowYAMLStrict(source).steps[1]!.parameters).toEqual({ id: "{{first.structuredContent.id}}" });
  const guidance = readAuthoringContract(parseWorkflowYAMLStrict(source), [tool], role, "hash");
  expect(guidance.controlFlow).toBeTruthy(); expect(guidance.conditions![0]!.nodeId).toBe("gate");
  expect(guidance.nodes[1]!.dataSources).toEqual([]);
});

test("condition guidance offers only safe preceding in-scope booleans, never sibling output or secrets", () => {
  let source = wrap();
  source = edit(source, { type: "addCondition", conditionId: "inner", predicate: { kind: "literal", value: true }, beforeNodeId: null, destination: { conditionId: "gate", branch: "then" } });
  const guidance = readAuthoringContract(parseWorkflowYAMLStrict(source), [tool], role, "hash");
  expect(guidance.conditions!.find(node => node.nodeId === "gate")!.dataSources.map(source => source.expression)).toEqual(["{{input.enabled}}"]);
  expect(guidance.conditions!.find(node => node.nodeId === "inner")!.dataSources.map(source => source.expression)).toEqual(["{{input.enabled}}", "{{first.structuredContent.ready}}"]);
  expect(JSON.stringify(guidance.conditions)).not.toMatch(/api_token|secret|last/);
});

function nestedFlow() {
  let source = edit(wrap(), { type: "wrapCollection", nodeId: "first", loopId: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [{ kind: "literal", value: "one" }] } },
    collect: { schema: { type: "string" }, value: { kind: "literal", value: "kept" } } });
  source = edit(source, { type: "addReturn", nodeId: "answer", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } }, beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } });
  return source;
}

test("moving a complete condition preserves both paths, nested collection, return, definitions and metadata", () => {
  const source = nestedFlow(), before = parseWorkflowYAMLStrict(source), owned = structuredClone(tree(source).nodes[0]);
  const next = edit(source, { type: "moveNode", nodeId: "gate", beforeNodeId: null });
  expect(tree(next).nodes).toEqual([{ kind: "action", nodeId: "last" }, owned]);
  expect(actionOrder(tree(next))).toEqual(["last", "first"]);
  expect(parseWorkflowYAMLStrict(next).steps).toEqual([before.steps[1], before.steps[0]]);
  expect(parseWorkflowYAMLStrict(next).metadata!.ownerNotes).toBe("Preserve me");
});

test("collection and return relocation use explicit scopes without flattening or changing configuration", () => {
  let source = nestedFlow(); const collection = structuredClone((tree(source).nodes[0] as any).then.nodes[0]);
  source = edit(source, { type: "moveNode", nodeId: "each", beforeNodeId: "last" });
  expect(tree(source).nodes[1]).toEqual(collection);
  expect((tree(source).nodes[0] as any).then.nodes).toEqual([]);
  source = edit(source, { type: "moveNode", nodeId: "answer", beforeNodeId: null, destination: { loopId: "each", scope: "body" } });
  expect((tree(source).nodes[1] as any).body.nodes.at(-1)).toMatchObject({ kind: "return", id: "answer", output: { value: { kind: "literal", value: false } } });
  expect((tree(source).nodes[0] as any).else.nodes).toEqual([]);
});

test.each([
  { nodeId: "gate", beforeNodeId: "first" },
  { nodeId: "gate", beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } },
  { nodeId: "gate", beforeNodeId: null, destination: { loopId: "each", scope: "body" } },
  { nodeId: "each", beforeNodeId: "first" },
  { nodeId: "each", beforeNodeId: null, destination: { loopId: "each", scope: "body" } },
  { nodeId: "each", beforeNodeId: "last", destination: { conditionId: "gate", branch: "then" } },
  { nodeId: "answer", beforeNodeId: "answer" },
  { nodeId: "missing", beforeNodeId: null },
  { nodeId: "gate", beforeNodeId: "last" },
])("self/descendant, scope-escaping, missing and no-op subtree placement rejects %j", change => {
  const source = nestedFlow(), unchanged = parseWorkflowYAMLStrict(source);
  expect(() => edit(source, { type: "moveNode", ...change })).toThrow();
  expect(parseWorkflowYAMLStrict(source)).toEqual(unchanged);
});

test("moving a subtree keeps broken downstream references intact for structural validation", () => {
  const blueprint = parseWorkflowYAMLStrict(base); blueprint.steps[1]!.parameters = { id: "{{first.structuredContent.id}}" };
  let source = wrap(stringify(blueprint));
  source = edit(source, { type: "moveNode", nodeId: "gate", beforeNodeId: null });
  expect(parseWorkflowYAMLStrict(source).steps[0]!.parameters).toEqual({ id: "{{first.structuredContent.id}}" });
  expect(() => compileReadWorkflow(source, [tool], role)).toThrow();
});

test.each([
  { type: "wrapNode", nodeId: "first", conditionId: "last", predicate: { kind: "literal", value: true }, branch: "then" },
  { type: "moveNode", nodeId: "first", beforeNodeId: "first" },
  { type: "moveNode", nodeId: "first", beforeNodeId: null, destination: { conditionId: "absent", branch: "then" } },
  { type: "addNode", node: { id: "gate", action: "read" }, beforeNodeId: null },
  { type: "addNode", node: { id: "new", action: "read" }, beforeNodeId: "last", destination: { conditionId: "gate", branch: "else" } },
  { type: "wrapNode", nodeId: "gate", conditionId: "another", predicate: { kind: "literal", value: false }, branch: "else" },
  { type: "updateCondition", nodeId: "first", patch: { predicate: { kind: "literal", value: true } } },
  { type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: "true" } } },
  { type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [] } } },
])("invalid/escaping edit %j is rejected without mutating its original source", command => {
  const source = wrap(); expect(() => edit(source, command)).toThrow(); expect(actionOrder(tree(source))).toEqual(["first", "last"]);
});
