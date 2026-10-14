import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { applyWorkflowCommand, workflowCommandSchema, selectedNodePatchSchema, selectedNodePatchVersion, selectedNodePatchCommand } from "../src/workflows/commands.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { actionOrder, protectedNodes, structuralNodes, controlPoint, parseReadControlFlow, assertSelectedReadNode, assertReadFlowCompletion } from "../src/workflows/read-control-flow.js";
import { inspectWorkflowDraft, compileReadWorkflow, compileOperationWorkflow, compileModelFixtureWorkflow } from "../src/workflows/compiled-read.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { usesCheckpointedOperationWorkflow } from "../src/workflows/execution-shape.js";
import { interpretReadPlan } from "../src/workflows/read-interpreter.js";
import { ReadMachine } from "../src/workflows/read-machine.js";
import { ReadCompletionEvidence } from "../src/workflows/read-completion-evidence.js";
import { selectedPrerequisiteYAML } from "../src/workflows/selected-prerequisite-view.js";
import { operationControlTransition } from "../src/workflows/operation-control-flow.js";
import { prepareOperationPublication, prepareOperationExecution } from "../src/workflows/operation-compilation-lifecycle.js";
import { toolSchema } from "../src/registry/schemas.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import { Repository } from "../src/repository/store.js";

const role = "Platform Admin";
const tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: {
  type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["admin"], output_schema: {
    type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false } } });
const literal = (value: string | number | boolean) => ({ kind: "literal" as const, value });
const ref = (nodeId: string, ...path: string[]) => ({ kind: "ref" as const, source: "nodeOutput" as const, nodeId, path });
const output = { schema: { type: "string" }, success: ref("lookup", "structuredContent", "id"), handled: ref("group", "error", "code") };
const base = stringify({ name: "Protected draft", trigger: { type: "manual" }, steps: ["before", "lookup", "next", "after"].map(id => ({ id, action: "read", parameters: { id } })), metadata: { ownerNotes: "untouched", positions: { lookup: { x: 4, y: 6 } } } });
const wrapCommand = { type: "wrapProtected", nodeIds: ["lookup", "next"], protectedId: "group", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output };
const edit = (source: string, command: unknown) => applyWorkflowCommand(source, workflowCommandSchema.parse(command));
const wrapped = () => edit(base, wrapCommand);
const flow = (source: string) => parseReadControlFlow(parseWorkflowYAMLStrict(source).metadata!.controlFlow);
const inspected = (source: string) => inspectWorkflowDraft(parseWorkflowYAMLStrict(source), [tool], role);
const addHandler = (source = wrapped()) => edit(source, { type: "addNode", node: { id: "fallback", action: "read", parameters: { id: "{{group.error.code}}" } }, beforeNodeId: null, destination: { protectedId: "group", scope: "handler" } });

test("atomic ordered wrap preserves definitions, positions, metadata and typed explicit paths under a new version", () => {
  const source = wrapped(), parsed = parseWorkflowYAMLStrict(source);
  expect(parsed.steps).toEqual(parseWorkflowYAMLStrict(base).steps);
  expect(parsed.metadata).toMatchObject({ ownerNotes: "untouched", positions: { lookup: { x: 4, y: 6 } } });
  expect(flow(source).schemaVersion).toBe("read-control-flow/v4");
  expect(protectedNodes(flow(source).root)[0]).toMatchObject({ id: "group", body: { nodes: [{ nodeId: "lookup" }, { nodeId: "next" }] }, handler: { nodes: [] }, onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output });
  expect(inspected(source).issues).toEqual([]);
  expect(controlPoint(flow(source).root, "group")).toBe(1);
  expect(controlPoint(flow(source).root, "group", true)).toBe(3);
});

test.each([[], ["lookup", "lookup"], ["lookup", "after"], ["next", "lookup"], ["lookup", "missing"], ["group"]].map(nodeIds => ({ nodeIds })))("invalid group selection %j rejects without changing original source", ({ nodeIds }) => {
  expect(() => edit(base, { ...wrapCommand, nodeIds })).toThrow();
  expect(parseWorkflowYAMLStrict(base).steps.map(node => node.id)).toEqual(["before", "lookup", "next", "after"]);
});

test.each(["lookup", "before", "input", "constructor"])("colliding or reserved protected ID %s rejects", protectedId => {
  expect(() => edit(base, { ...wrapCommand, protectedId })).toThrow();
});

test("cross-parent selection and ancestor/descendant selection cannot duplicate ownership", () => {
  const source = addHandler();
  for (const nodeIds of [["lookup", "fallback"], ["group", "lookup"]]) expect(() => edit(source, { ...wrapCommand, protectedId: "another", nodeIds })).toThrow(/contiguous/);
});

test.each(["read-control-flow/v1", "read-control-flow/v2", "read-control-flow/v3"])("protected structure is never reinterpreted as %s", schemaVersion => {
  expect(() => parseReadControlFlow({ ...flow(wrapped()), schemaVersion })).toThrow(/v4/);
});

test.each([
  { onError: { code: "ANY" } }, { onError: { code: "ERP_RESOURCE_NOT_FOUND", retry: true } },
  { body: { kind: "sequence", nodes: [] } }, { catchAll: true }, { output: { schema: { type: "string" }, success: literal("ok") } },
])("ambiguous catch-all, empty or incomplete protected structure rejects %j", patch => {
  const raw = flow(wrapped()); Object.assign(raw.root.nodes[1]!, patch);
  expect(() => parseReadControlFlow(raw)).toThrow();
});

test("handler has only outer predecessors, its redacted error and earlier handler results", () => {
  const source = addHandler(), result = inspected(source);
  expect(result.issues).toEqual([]);
  expect([...result.scopeValidation!.scopes.get("fallback")!]).toEqual(["before", "group"]);
  expect(result.scopeValidation!.protectedScopes.get("group")!.success.has("lookup")).toBe(true);
  expect(result.scopeValidation!.protectedScopes.get("group")!.handled.has("lookup")).toBe(false);
  const guide = readAuthoringContract(parseWorkflowYAMLStrict(source), [tool], role, "fixture");
  expect(guide.executionProfile).toBe("protected-draft-runtime-pending");
  const suggestions = guide.nodes.find(node => node.nodeId === "fallback")!.dataSources.map(item => item.expression);
  expect(suggestions).toContain("{{group.error.code}}"); expect(suggestions).toContain("{{group.error.failedNodeId}}");
  expect(suggestions).not.toContain("{{group.value}}"); expect(suggestions.some(item => item.includes("lookup."))).toBe(false);
  const after = guide.nodes.find(node => node.nodeId === "after")!.dataSources.map(item => item.expression);
  expect(after).toContain("{{group.value}}"); expect(after.some(item => item.includes(".error."))).toBe(false);
});

test.each([
  ["lookup", "{{group.error.code}}"], ["fallback", "{{lookup.structuredContent.id}}"],
  ["fallback", "{{group.value}}"], ["fallback", "{{group.error.message}}"],
  ["after", "{{group.error.code}}"], ["after", "{{fallback.structuredContent.id}}"],
  ["after", "{{lookup.structuredContent.id}}"], ["after", "{{group.value.missing}}"],
])("%s cannot bind escaped, unavailable or undeclared protected data %s", (nodeId, id) => {
  const source = edit(addHandler(), { type: "updateNode", nodeId, patch: { parameters: { id } } });
  expect(inspected(source).issues.length).toBeGreaterThan(0);
  expect(parseWorkflowYAMLStrict(source).steps.find(node => node.id === nodeId)!.parameters).toEqual({ id });
});

test("both outputs must typecheck using their own path, not failed-body or future results", () => {
  for (const patch of [ { success: ref("fallback", "structuredContent", "id") }, { handled: ref("lookup", "structuredContent", "id") }, { handled: literal(4) }, { success: ref("group", "error", "code") } ]) {
    const source = edit(addHandler(), { type: "updateProtected", nodeId: "group", patch: { output: { ...output, ...patch } } });
    expect(inspected(source).issues.length).toBeGreaterThan(0);
  }
});

test("typed handler output and group output can safely feed later declared draft bindings", () => {
  let source = addHandler();
  source = edit(source, { type: "updateProtected", nodeId: "group", patch: { output: { ...output, handled: ref("fallback", "structuredContent", "id") } } });
  source = edit(source, { type: "updateNode", nodeId: "after", patch: { parameters: { id: "{{group.value}}" } } });
  expect(inspected(source).issues).toEqual([]);
});

test("nested protected groups preserve inner/outer lexical faults and unique ownership", () => {
  const source = edit(addHandler(), { ...wrapCommand, nodeIds: ["fallback"], protectedId: "inner", output: { schema: { type: "string" }, success: ref("group", "error", "code"), handled: ref("inner", "error", "failedNodeId") } });
  expect(inspected(source).issues).toEqual([]);
  expect(structuralNodes(flow(source).root).map(node => node.id)).toEqual(["group", "inner"]);
  expect(actionOrder(flow(source).root)).toEqual(["before", "lookup", "next", "fallback", "after"]);
});

test("protected group can own a bounded collection without leaking its item or child output", () => {
  let source = edit(base, { type: "wrapCollection", nodeId: "lookup", loopId: "each", maxItems: 2, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [literal("a")] } }, collect: { schema: { type: "string" }, value: ref("lookup", "structuredContent", "id") } });
  source = edit(source, { ...wrapCommand, nodeIds: ["each", "next"], output: { schema: { type: "array", items: { type: "string" } }, success: ref("each", "value"), handled: { kind: "array", items: [literal("unavailable")] } } });
  source = edit(source, { type: "updateNode", nodeId: "lookup", patch: { parameters: { id: "{{each.item}}" } } });
  expect(inspected(source).issues).toEqual([]);
  const escaped = edit(source, { type: "updateNode", nodeId: "after", patch: { parameters: { id: "{{each.item}}" } } });
  expect(inspected(escaped).issues.length).toBeGreaterThan(0);
});

test("protection inside a collection keeps item context in both paths and exposes only its typed collection result", () => {
  let source = edit(base, { type: "wrapCollection", nodeId: "lookup", loopId: "each", maxItems: 2, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [literal("a")] } }, collect: { schema: { type: "string" }, value: ref("group", "value") } });
  source = edit(source, { ...wrapCommand, nodeIds: ["lookup"] });
  source = addHandler(source);
  source = edit(source, { type: "updateNode", nodeId: "fallback", patch: { parameters: { id: "{{each.item}}" } } });
  expect(inspected(source).issues).toEqual([]);
  source = edit(source, { type: "addReturn", nodeId: "illegal", output: { schema: { type: "string" }, value: literal("stop") }, beforeNodeId: null, destination: { protectedId: "group", scope: "handler" } });
  expect(inspected(source).issues.some(issue => issue.includes("cannot contain workflow returns"))).toBe(true);
});

test("protected draft analysis and condition references use their actual lexical error/item schema", () => {
  let source = addHandler();
  source = edit(source, { type: "addAnalysis", node: { id: "explain", kind: "analysis", instruction: "Describe the fixed error category", input: "{{group.error.code}}", output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, data_class: "internal" }, beforeNodeId: null, destination: { protectedId: "group", scope: "handler" } });
  expect(inspected(source).issues).toEqual([]);
  source = edit(source, { type: "addCondition", conditionId: "badPredicate", predicate: ref("group", "error", "code"), beforeNodeId: null, destination: { protectedId: "group", scope: "handler" } });
  expect(inspected(source).issues.some(issue => issue.includes("boolean"))).toBe(true);
});

test("protected wrappers preserve nested conditions, Return and their stable IDs", () => {
  let source = edit(base, { type: "wrapNode", nodeId: "lookup", conditionId: "gate", predicate: literal(true), branch: "then" });
  source = edit(source, { type: "addReturn", nodeId: "answer", output: { schema: { type: "string" }, value: literal("early") }, beforeNodeId: null, destination: { conditionId: "gate", branch: "then" } });
  const before = flow(source).root.nodes[1];
  source = edit(source, { ...wrapCommand, nodeIds: ["gate"], output: { ...output, success: literal("normal") } });
  expect(protectedNodes(flow(source).root)[0]!.body.nodes[0]).toEqual(before);
  expect(inspected(source).issues).toEqual([]);
});

test("protected nesting remains bounded to eight lexical levels", () => {
  let source = wrapped(), previous = "group";
  for (let level = 1; level <= 7; level++) {
    const protectedId = `outer${level}`;
    source = edit(source, { ...wrapCommand, nodeIds: [previous], protectedId, output: { schema: { type: "string" }, success: ref(previous, "value"), handled: literal("handled") } });
    previous = protectedId;
  }
  expect(inspected(source).issues).toEqual([]);
  expect(() => edit(source, { ...wrapCommand, nodeIds: [previous], protectedId: "tooDeep", output: { ...output, success: literal("ok") } })).toThrow(/nested scopes/);
});

test("group relocation moves both paths unchanged, but rejects own-body/handler destinations", () => {
  const source = addHandler(), before = protectedNodes(flow(source).root)[0];
  const moved = edit(source, { type: "moveNode", nodeId: "group", beforeNodeId: null });
  expect(protectedNodes(flow(moved).root)[0]).toEqual(before);
  expect(actionOrder(flow(moved).root)).toEqual(["before", "after", "lookup", "next", "fallback"]);
  for (const scope of ["body", "handler"]) expect(() => edit(source, { type: "moveNode", nodeId: "group", beforeNodeId: null, destination: { protectedId: "group", scope } })).toThrow(/own paths/);
});

test("unwrap never makes fallback actions unconditional; empty-handler unwrap preserves exact body definitions", () => {
  expect(() => edit(addHandler(), { type: "unwrapProtected", nodeId: "group" })).toThrow(/fallback actions/);
  const next = edit(wrapped(), { type: "unwrapProtected", nodeId: "group" });
  expect(parseWorkflowYAMLStrict(next).steps).toEqual(parseWorkflowYAMLStrict(base).steps);
  expect(flow(next).schemaVersion).toBe("read-control-flow/v4");
  expect(protectedNodes(flow(next).root)).toEqual([]);
});

test("removing all body content rejects atomically rather than creating an empty protection", () => {
  const source = edit(wrapped(), { type: "removeNode", nodeId: "lookup" });
  expect(() => edit(source, { type: "removeNode", nodeId: "next" })).toThrow(/empty/);
});

test("old selected-node chat contracts cannot accidentally edit a protected owner as a tool", () => {
  expect(selectedNodePatchSchema({ kind: "protect" }).safeParse({ parameters: {} }).success).toBe(false);
  expect(selectedNodePatchVersion({ kind: "protect" })).toBe("prompt/protected-group-patch/v1");
  expect(() => selectedNodePatchCommand({ id: "group", kind: "protect" }, { parameters: {} })).toThrow();
});

test("protected output guidance separates success/handled, own fault, future and private fields", () => {
  const guide = readAuthoringContract(parseWorkflowYAMLStrict(addHandler()), [tool], role, "fixture");
  const group = guide.protectedGroups!.find(value => value.nodeId === "group")!;
  const expressions = (path: "success" | "handled") => group.outputSources[path].map(source => source.expression);
  expect(group.patchVersion).toBe("prompt/protected-group-patch/v1");
  expect(expressions("success")).toContain("{{lookup.structuredContent.id}}");
  expect(expressions("success")).not.toContain("{{fallback.structuredContent.id}}");
  expect(expressions("success")).not.toContain("{{group.error.code}}");
  expect(expressions("handled")).toContain("{{fallback.structuredContent.id}}");
  expect(expressions("handled")).toContain("{{group.error.code}}");
  expect(expressions("handled")).toContain("{{group.error.failedNodeId}}");
  expect(expressions("handled")).not.toContain("{{lookup.structuredContent.id}}");
  for (const path of ["success", "handled"] as const) {
    expect(expressions(path)).toContain("{{before.structuredContent.id}}");
    expect(expressions(path).some(value => value.includes("after.") || value.includes("group.value") || value.includes("error.message"))).toBe(false);
  }
  const privateTool = toolSchema.parse({ ...tool, bridge_contract: { ...tool.bridge_contract, output_schema: { type: "object", properties: { id: { type: "string" }, token: { type: "string" } }, required: ["id"], additionalProperties: false } } });
  const privateGuide = readAuthoringContract(parseWorkflowYAMLStrict(addHandler()), [privateTool], role, "fixture");
  expect(JSON.stringify(privateGuide.protectedGroups)).not.toContain("token");
});

test("nested protected output hints retain lexical outer faults but do not expose self output or failed body results", () => {
  const source = edit(addHandler(), { type: "wrapProtected", nodeIds: ["fallback"], protectedId: "inner", onError: { code: "ERP_RESOURCE_NOT_FOUND" },
    output: { schema: { type: "string" }, success: ref("fallback", "structuredContent", "id"), handled: ref("inner", "error", "code") } });
  expect(inspected(source).issues).toEqual([]);
  const guide = readAuthoringContract(parseWorkflowYAMLStrict(source), [tool], role, "fixture").protectedGroups!.find(node => node.nodeId === "inner")!;
  for (const path of ["success", "handled"] as const) {
    const expressions = guide.outputSources[path].map(source => source.expression);
    expect(expressions).toContain("{{group.error.code}}");
    expect(expressions.some(value => value.includes("group.value") || value.includes("inner.value") || value.includes("lookup."))).toBe(false);
    expect(expressions.includes("{{inner.error.code}}")).toBe(path === "handled");
    expect(expressions.includes("{{fallback.structuredContent.id}}")).toBe(path === "success");
  }
});

test("protected group inside draft iteration suggests its lexical item on both paths but never the unfinished collection value", () => {
  const loop = edit(base, { type: "wrapCollection", nodeId: "lookup", loopId: "each", items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [literal("fixture")] } },
    maxItems: 2, collect: { schema: { type: "string" }, value: ref("group", "value") } });
  const source = edit(loop, { ...wrapCommand, nodeIds: ["lookup"] });
  expect(inspected(source).issues).toEqual([]);
  const guide = readAuthoringContract(parseWorkflowYAMLStrict(source), [tool], role, "fixture").protectedGroups!.find(node => node.nodeId === "group")!;
  for (const path of ["success", "handled"] as const) {
    const expressions = guide.outputSources[path].map(source => source.expression);
    expect(expressions).toContain("{{each.item}}"); expect(expressions).toContain("{{each.index}}"); expect(expressions).not.toContain("{{each.value}}");
  }
});

test("protected drafts route to durable operations but cannot compile an executable legacy profile", () => {
  const source = wrapped();
  expect(usesCheckpointedOperationWorkflow(parseWorkflowYAMLStrict(source), [tool])).toBe(true);
  expect(() => compileReadWorkflow(source, [tool], role)).toThrow(/durable handler profile/);
  expect(() => compileOperationWorkflow(source, [tool], role, new Map())).toThrow(/reviewed.*pin/i);
  expect(() => compileModelFixtureWorkflow(source, [tool], role)).toThrow(/durable handler profile/);
});

test("counterfeit read/operation plans are denied before any driver callback or partial traversal", async () => {
  const root = flow(addHandler()).root;
  const plan = compileReadWorkflow(base, [tool], role); plan.ir.flow = root;
  const action = vi.fn(), condition = vi.fn(), skipped = vi.fn(), value = vi.fn();
  await expect(interpretReadPlan(plan, {}, { action, condition, skipped, value })).rejects.toThrow(/durable handler profile/);
  expect(action).not.toHaveBeenCalled(); expect(condition).not.toHaveBeenCalled(); expect(skipped).not.toHaveBeenCalled(); expect(value).not.toHaveBeenCalled();
  expect(() => assertSelectedReadNode(root, "before", {})).toThrow();
  expect(() => assertReadFlowCompletion(root, {}, {})).toThrow();
  expect(() => operationControlTransition(root, { attempts: {}, nextStepIndex: 0 })).toThrow();
  expect(() => new ReadMachine(plan, {})).toThrow();
  expect(() => new ReadCompletionEvidence(plan)).toThrow();
  expect(() => selectedPrerequisiteYAML(parseWorkflowYAMLStrict(addHandler()), "before", new Set())).toThrow();
});

test("unconfigured protected publication and stale imports cannot acquire execution authority", async () => {
  const snapshot = vi.fn(() => ({ tools: [tool] })), hash = vi.fn(() => "hash"), repository = new Repository(null);
  // Deliberately omit connection/runtime services: publication must refuse.
  const services = { registries: { snapshot, hash }, repository } as unknown as HandlerServices;
  await expect(prepareOperationPublication(services, wrapped(), { id: "owner", role } as any)).rejects.toMatchObject({ status: 503 });
  expect(hash).not.toHaveBeenCalled();
  expect(() => prepareOperationExecution({} as any, services, { compiledOperation: {} }, wrapped(), role)).toThrow(/missing, stale/);
});

test("protected collection publication refuses before discovery and never flattens iterations", async () => {
  let source = edit(base, { type: "wrapCollection", nodeId: "lookup", loopId: "each", maxItems: 2,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [literal("a")] } },
    collect: { schema: { type: "string" }, value: ref("lookup", "structuredContent", "id") } });
  source = edit(source, { ...wrapCommand, nodeIds: ["each"], output: { schema: { type: "string" }, success: literal("ok"), handled: literal("unavailable") } });
  const snapshot = vi.fn(() => ({ tools: [tool] })), hash = vi.fn(() => "hash");
  const services = { registries: { snapshot, hash }, repository: new Repository(null) } as unknown as HandlerServices;
  await expect(prepareOperationPublication(services, source, { id: "owner", role } as any)).rejects.toMatchObject({ meta: { code: "PROTECTED_COLLECTION_RUNTIME_PENDING" } });
  expect(hash).not.toHaveBeenCalled();
  expect(() => compileOperationWorkflow(source, [tool], role, new Map())).toThrow(/durable operation iteration/);
});
