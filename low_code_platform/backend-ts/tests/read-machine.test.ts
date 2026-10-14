import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { compileReadWorkflow, resolveReadBinding, type CompiledReadPlan } from "../src/workflows/compiled-read.js";
import { interpretReadPlan } from "../src/workflows/read-interpreter.js";
import { ReadMachine, type ReadMachinePoint } from "../src/workflows/read-machine.js";
import { ReadValueBudget } from "../src/workflows/read-value-budget.js";

const role = "Platform Admin";
const tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes }), action = (nodeId: string) => ({ kind: "action", nodeId });
const ref = (nodeId: string, path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const inputRef = (path: string[]) => ({ kind: "ref", source: "workflowInput", path });
const array = { type: "array", items: { type: "string" } };
const output = (id: string) => ({ content: [], structuredContent: { id: id.toUpperCase() } });
const source = (): any => ({ name: "Machine", description: "Resumable read semantics", trigger: { type: "manual" }, steps: [{ id: "read", action: "read", parameters: { id: "{{each.item}}" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: seq({ kind: "foreach", id: "each", items: { schema: array, value: inputRef(["rows"]) }, maxItems: 100, body: seq(action("read")), collect: { schema: { type: "string" }, value: ref("read", ["structuredContent", "id"]) } }, { kind: "return", id: "answer", output: { schema: array, value: ref("each", ["value"]) } }) } } });
const compile = (src: any) => compileReadWorkflow(stringify(src), [tool], role);

// Keep the existing recursive interpreter as an independent semantic oracle.
async function oracle(plan: CompiledReadPlan, input: Record<string, unknown>) {
  const points: ReadMachinePoint[] = [], state: Record<string, unknown> = { input: structuredClone(input) }; let visits = 0;
  await interpretReadPlan(plan, state, {
    beforeNode() { visits++; },
    async action(node, sourceIndex, visit) { const args = resolveReadBinding(node.inputs, state) as Record<string, unknown>; points.push({ kind: "action", nodeId: node.id, sourceIndex, visit, valid: true, arguments: args }); return output(String(args.id)); },
    async condition(sourceIndex, nodeId, value, visit) { points.push({ kind: "condition", nodeId, sourceIndex, visit, valid: typeof value === "boolean", ...(value === undefined ? {} : { selected: value ? "then" : "else" }) }); },
    async skipped(sourceIndex, nodeId, reason, visit) { points.push({ kind: "skip", nodeId, sourceIndex, visit, reason, valid: true }); },
    async collectionStarted(sourceIndex, nodeId, count, valid, visit) { points.push({ kind: "collection", nodeId, sourceIndex, visit, phase: "start", valid, ...(count === undefined ? {} : { count }) }); },
    async value(sourceIndex, nodeId, kind, value, valid, visit) { points.push({ kind, nodeId, sourceIndex, visit, valid, value, ...(kind === "collection" ? { phase: "complete" as const } : {}) }); return valid ? { value } : undefined; },
  }); return { points, state, visits };
}
async function parity(src: any, input: Record<string, unknown>) {
  const plan = compile(src), before = structuredClone({ plan, input }), expected = await oracle(plan, input);
  let machine = new ReadMachine(plan, input); const points: ReadMachinePoint[] = [];
  for (let boundaries = 0; boundaries < 5000; boundaries++) {
    const point = machine.peek(); machine = new ReadMachine(plan, {}, machine.snapshot());
    expect(machine.peek()).toEqual(point); if (!point) break;
    const publicPoint = structuredClone(point); if (publicPoint.kind === "collection" && publicPoint.phase === "start") delete publicPoint.value;
    points.push(publicPoint);
    machine.accept(point.kind === "action" ? output(String(point.arguments!.id)) : ["merge", "return", "collection-item"].includes(point.kind) || point.kind === "collection" && point.phase === "complete" ? { value: point.value } : undefined);
    machine = new ReadMachine(plan, {}, machine.snapshot());
  }
  expect(machine.peek()).toBeNull(); expect(points).toEqual(expected.points);
  expect(machine.snapshot()).toMatchObject({ done: true, visits: expected.visits, values: expected.state, iterations: [], frames: [] });
  expect({ plan, input }).toEqual(before); return machine;
}

test.each([[], ["a"], ["a", "b"], Array.from({ length: 100 }, (_v, i) => String(i))].map(rows => ({ rows })))("restart at every collection boundary preserves oracle semantics for $rows", async ({ rows }) => { await parity(source(), { rows }); });

test.each([[[], []], [["a", "b"], [], ["c"]], [[]], []].map(rows => ({ rows })))("nested collection resumes preserve scopes and declared empty skips for $rows", async ({ rows }) => {
  const src = source(), outer = src.metadata.controlFlow.root.nodes[0]; outer.items.schema = { type: "array", items: array }; outer.maxItems = 3;
  outer.body = seq({ kind: "foreach", id: "inner", items: { schema: array, value: ref("each", ["item"]) }, maxItems: 3, body: seq(action("read")), collect: outer.collect });
  outer.collect = { schema: array, value: ref("inner", ["value"]) }; src.steps[0].parameters.id = "{{inner.item}}";
  src.metadata.controlFlow.root.nodes[1].output.schema = { type: "array", items: array }; await parity(src, { rows });
});

test.each([[], [true], [false], [true, false, true], [false, true, false]].map(decisions => ({ decisions })))("per-item conditional merge resumes without borrowing another item, decisions=$decisions", async ({ decisions }) => {
  const src = source(), loop = src.metadata.controlFlow.root.nodes[0]; loop.items.schema = { type: "array", items: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false } };
  loop.body = seq({ kind: "if", id: "gate", predicate: ref("each", ["item", "enabled"]), then: seq(action("read")), else: seq(), merge: { schema: { type: "string" }, then: ref("read", ["structuredContent", "id"]), else: ref("each", ["item", "id"]) } });
  loop.collect.value = ref("gate", ["value"]); src.steps[0].parameters.id = "{{each.item.id}}";
  await parity(src, { rows: decisions.map((enabled, i) => ({ id: String(i), enabled })) });
});

test.each([false, 0, "", null])("an early return of %j preserves the value and skips every declared later action", async value => {
  const src = source(); src.metadata.controlFlow.root.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: value === null ? "null" : typeof value }, value: { kind: "literal", value } } });
  await parity(src, {});
});

test.each([true, false])("selected branch return propagates across nested conditions and skips later nodes, enabled=%s", async enabled => {
  const src = source(); src.steps = ["yes", "no", "after"].map(id => ({ id, action: "read", parameters: { id } }));
  src.metadata.controlFlow.root = seq({ kind: "if", id: "outer", predicate: inputRef(["enabled"]), then: seq({ kind: "if", id: "inner", predicate: { kind: "literal", value: true }, then: seq(action("yes"), { kind: "return", id: "early", output: { schema: { type: "string" }, value: ref("yes", ["structuredContent", "id"]) } }), else: seq() }), else: seq(action("no")) }, action("after"));
  await parity(src, { enabled });
});

test.each([undefined, null, "false", 0])("an invalid condition %j cannot be accepted as a false decision", value => {
  const src = source(); src.steps[0].parameters.id = "literal"; src.metadata.controlFlow.root = seq({ kind: "if", id: "gate", predicate: inputRef(["enabled"]), then: seq(action("read")), else: seq() });
  const machine = new ReadMachine(compile(src), value === undefined ? {} : { enabled: value }); expect(machine.peek()).toMatchObject({ kind: "condition", valid: false }); expect(() => machine.accept()).toThrow();
});

test.each([{}, { rows: null }, { rows: "a" }, { rows: [7] }, { rows: Array(101).fill("a") }])("invalid collection input %j cannot advance or produce an aggregate", input => {
  const machine = new ReadMachine(compile(source()), input); expect(machine.peek()).toMatchObject({ kind: "collection", phase: "start", valid: false }); expect(() => machine.accept()).toThrow();
  expect(machine.snapshot().values).toEqual({ input });
});

test("returned snapshots, forks and pending points cannot mutate the original runner", () => {
  const machine = new ReadMachine(compile(source()), { rows: ["a"] }); const point = machine.peek()!;
  (point.value as string[])[0] = "changed"; const snapshot = machine.snapshot(); (snapshot.values.input as any).rows[0] = "changed";
  machine.accept(); const fork = machine.fork(); fork.peek(); fork.accept(output("changed")); expect(machine.peek()).toMatchObject({ kind: "action", arguments: { id: "a" } });
});

test("resuming a collection preserves cumulative expanded-value limits", () => {
  const src = source(); src.steps[0].parameters.id = "literal"; src.metadata.controlFlow.root.nodes[0].collect.value = ref("each", ["item"]);
  let machine = new ReadMachine(compile(src), { rows: Array(11).fill("x".repeat(100_000)) });
  // The collection input itself is bounded by resolveReadBinding.
  expect(machine.peek()).toMatchObject({ valid: false });
  const budget = new ReadValueBudget(); budget.clone("x".repeat(600_000), 1);
  const restored = new ReadValueBudget(budget.checkpoint()); expect(() => restored.clone("x".repeat(600_000), 1)).toThrow(/byte limits/);
  expect(() => new ReadValueBudget({ bytes: -1, nodes: 0 })).toThrow(); expect(() => new ReadValueBudget({ bytes: 0, nodes: 32769 })).toThrow();
  expect(() => new ReadValueBudget(null as never)).toThrow();
});

test.each(["source", "semantic", "cursor", "visits", "block", "position", "phase", "collection-index", "budget", "missing-budget", "null-budget", "pending-index", "pending-scope", "done", "missing-input"])("malformed saved machine %s is rejected before traversal", damage => {
  const plan = compile(source()), machine = new ReadMachine(plan, { rows: ["a"] }); machine.peek(); const saved = machine.snapshot();
  if (damage === "source") saved.sourceHash = "different";
  if (damage === "semantic") saved.semanticHash = "different";
  if (damage === "cursor") saved.cursor = -1;
  if (damage === "visits") saved.visits = 5001;
  if (damage === "block") (saved.frames[0] as any).block = 999;
  if (damage === "position") (saved.frames[0] as any).index = -1;
  if (damage === "phase") (saved.frames[1] as any).phase = "unknown";
  if (damage === "collection-index") (saved.frames[1] as any).index = -1;
  if (damage === "budget") (saved.frames[1] as any).budget.bytes = -1;
  if (damage === "missing-budget") delete (saved.frames[1] as any).budget;
  if (damage === "null-budget") (saved.frames[1] as any).budget = null;
  if (damage === "pending-index") saved.pending!.sourceIndex++;
  if (damage === "pending-scope") saved.pending!.visit.invocationId = "each/0/each";
  if (damage === "done") saved.done = true;
  if (damage === "missing-input") delete saved.values.input;
  expect(() => new ReadMachine(plan, {}, saved)).toThrow();
});
