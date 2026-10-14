import { expect, test } from "vitest";
import { stringify } from "yaml";
import { ProtectedMachine, protectedMachinePlan, boundProtectedMachineJSON } from "../src/workflows/protected-machine.js";
import { compileProtectedFixtureWorkflow } from "../src/workflows/compiled-read.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { simulateProtectedWorkflow, parseProtectedFixtures } from "../src/workflows/protected-simulation.js";
import type { ProtectedMachinePlan, ProtectedMachinePoint } from "../src/workflows/protected-machine-state.js";
import { protectedSimulationSource as source, protectedSimulationRead as read, protectedSimulationRole as role,
  fixtureAction as action, fixtureSequence as seq, fixtureRef as ref, fixtureOutput as output } from "./fixtures/protected-simulation.js";

const fault = { kind: "business-read-error", code: "ERP_RESOURCE_NOT_FOUND" };
const supplied = () => ({ lookup: output("Lookup"), body_next: output("Body"), fallback: output("Handled"), after: output("Final") });
function plan(src: any) {
  const projection = compileProtectedFixtureWorkflow(stringify(src), [read], role);
  return protectedMachinePlan(projection.sourceHash, projection.flow, projection.nodes.map(node => ({ id: node.id, input: node.kind === "action" ? node.inputs : node.input })), projection.inputSchema);
}
const typed = (point: ProtectedMachinePoint) => ["merge", "return", "collection-item"].includes(point.kind) ||
  point.kind === "collection-complete" && point.outcome === "SUCCEEDED" || point.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(point.outcome!);
function run(compiled: ProtectedMachinePlan, input: Record<string, unknown>, outputs: Record<string, unknown>, failures: Record<string, unknown> = {}) {
  let machine = new ProtectedMachine(compiled, input); const points: ProtectedMachinePoint[] = [];
  const restart = () => { machine = new ProtectedMachine(compiled, {}, machine.snapshot()); };
  for (let count = 0; count < 5000; count++) {
    const point = machine.peek(); restart(); expect(machine.peek()).toEqual(point); if (!point) break;
    expect(point.valid).toBe(true); points.push(point);
    if (point.kind === "action" && failures[point.invocationId]) machine.fail({ code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: point.nodeId, failedInvocationId: point.invocationId });
    else machine.accept(point.kind === "action" ? outputs[point.invocationId] : typed(point) ? { value: point.value } : undefined);
    restart();
  }
  expect(machine.peek()).toBeNull(); return { points, snapshot: machine.snapshot() };
}
async function parity(src: any, input: Record<string, unknown>, outputs: Record<string, unknown>, failures: Record<string, unknown> = {}) {
  const yaml = stringify(src), compiled = plan(src), before = structuredClone({ compiled, input, outputs, failures });
  const expected = await simulateProtectedWorkflow(yaml, input, parseProtectedFixtures({ profile: "protected-fixtures/v1", baseVersion: 1,
    baseHash: workflowContentHash(yaml), outputs, failures }), [read], role);
  const actual = run(compiled, input, outputs, failures);
  expect(actual.snapshot.status).toBe(expected.outcome === "SIMULATED_COMPLETE" ? "DONE" : "FAILED");
  if (actual.snapshot.result) expect(actual.snapshot.result.value).toEqual(expected.finalOutput);
  expect(actual.points.filter(point => point.kind === "action").map(point => point.invocationId)).toEqual(expected.usedFixtureIds);
  expect(actual.points.filter(point => point.kind === "protected-complete").map(point => point.outcome)).toEqual(expected.trace.filter(entry =>
    ["SIMULATED_GROUP_SUCCEEDED", "SIMULATED_HANDLED_ERROR", "SIMULATED_GROUP_RETURNED", "SIMULATED_HANDLER_FAILED"].includes(entry.outcome)).map(entry =>
    entry.outcome === "SIMULATED_GROUP_SUCCEEDED" ? "SUCCEEDED" : entry.outcome === "SIMULATED_HANDLED_ERROR" ? "HANDLED_ERROR" : entry.outcome === "SIMULATED_GROUP_RETURNED" ? "RETURNED" : "FAILED"));
  expect({ compiled, input, outputs, failures }).toEqual(before); return actual;
}
function loopSource(): any {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0]; src.steps.pop(); src.steps[0].parameters.id = "{{each.item}}";
  src.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(group), collect: { schema: { type: "string" }, value: ref("guard", "value") } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("each", "value") } });
  src.trigger.config = { inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false } };
  return src;
}

test.each([false, true])("restart at every protected boundary preserves success/handled fixture parity, handled=%s", async handled => {
  const data = supplied(); if (handled) delete (data as any).lookup;
  await parity(source(), {}, data, handled ? { lookup: fault } : {});
});

test("mixed handled/success loop items preserve separate answers and checkpoint identities", async () => {
  const actual = await parity(loopSource(), { items: ["A", "B"] }, { "each/0/fallback": output("First handled"),
    "each/1/lookup": output("Second read"), "each/1/body_next": output("Second body") }, { "each/0/lookup": fault });
  expect(actual.snapshot.result).toEqual({ value: ["First handled", "Second body"] });
  expect(actual.points.find(point => point.invocationId === "each/1/lookup")?.arguments).toEqual({ id: "B" });
  expect(actual.snapshot.values).toEqual({ input: { items: ["A", "B"] }, each: { value: ["First handled", "Second body"] } });
});

test("empty collections produce a declared empty aggregate and truthful unentered templates", async () => {
  const actual = await parity(loopSource(), { items: [] }, {});
  expect(actual.snapshot.result).toEqual({ value: [] });
  expect(actual.points.filter(point => point.kind === "skip").every(point => point.scope === "unentered-template" && point.reason?.kind === "empty-collection")).toBe(true);
});

test.each([false, null, 0, ""])("Return %j bypasses the handler and downstream actions across restart", async value => {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0];
  group.body.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: value === null ? "null" : typeof value }, value: { kind: "literal", value } } });
  const result = await parity(src, {}, {}); expect(result.snapshot.result).toEqual({ value });
  expect(result.points.some(point => point.kind === "protected-select")).toBe(false);
});

test("a nested handler fault propagates only to an authored enclosing body", async () => {
  const src = source(), inner = src.metadata.controlFlow.root.nodes[0];
  src.steps.splice(3, 0, { id: "outer_fallback", action: read.name, parameters: { id: "{{outer.error.failedNodeId}}" } }); src.steps.at(-1).parameters.id = "{{outer.value}}";
  src.metadata.controlFlow.root.nodes[0] = { kind: "protect", id: "outer", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: seq(inner), handler: seq(action("outer_fallback")),
    output: { schema: { type: "string" }, success: ref("guard", "value"), handled: ref("outer_fallback", "structuredContent", "text") } };
  const actual = await parity(src, {}, { outer_fallback: output("Recovered"), after: output("Final") }, { lookup: fault, fallback: fault });
  expect(actual.points.filter(point => point.kind === "protected-select").map(point => point.nodeId)).toEqual(["guard", "outer"]);
});

test("handler failure remains a failed run with no fabricated output", async () => {
  const actual = await parity(source(), {}, {}, { lookup: fault, fallback: fault });
  expect(actual.snapshot.status).toBe("FAILED"); expect(actual.snapshot.result).toBeUndefined(); expect(actual.snapshot.values.guard).toBeUndefined();
});

test.each([true, false])("selected per-item condition and merge retain exact readable value, selected=%s", async enabled => {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0];
  group.body = seq({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: seq(action("lookup")), else: seq(action("body_next")),
    merge: { schema: { type: "string" }, then: ref("lookup", "structuredContent", "text"), else: ref("body_next", "structuredContent", "text") } });
  group.output.success = ref("gate", "value");
  src.trigger.config = { inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false } };
  const actual = await parity(src, { enabled }, supplied());
  expect(actual.points.find(point => point.kind === "merge")?.value).toBe(enabled ? "Lookup" : "Body");
});

test("failed item aborts its aggregate and later items, then enters only an authored outer handler", async () => {
  const src = loopSource(), each = src.metadata.controlFlow.root.nodes[0];
  src.steps.push({ id: "outer_fallback", action: read.name, parameters: { id: "{{outer.error.failedNodeId}}" } });
  src.metadata.controlFlow.root = seq({ kind: "protect", id: "outer", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: seq(each), handler: seq(action("outer_fallback")),
    output: { schema: { type: "array", items: { type: "string" } }, success: ref("each", "value"), handled: { kind: "array", items: [ref("outer_fallback", "structuredContent", "text")] } } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("outer", "value") } });
  const actual = await parity(src, { items: ["A", "B", "C"] }, { "each/0/lookup": output("First lookup"), "each/0/body_next": output("First body"), outer_fallback: output("Outer handled") },
    { "each/1/lookup": fault, "each/1/fallback": fault });
  expect(actual.snapshot.result).toEqual({ value: ["Outer handled"] });
  expect(actual.snapshot.values.each).toBeUndefined(); expect(actual.points.some(point => point.invocationId.startsWith("each/2/"))).toBe(false);
  expect(actual.points.find(point => point.kind === "collection-complete")).toMatchObject({ outcome: "FAILED" });
});

test.each([[], [["A"]], [["A", "B"], []], [[], ["C"]]].map(rows => ({ rows })))("nested protected collections preserve all per-item scopes, rows=$rows", async ({ rows }) => {
  const src = loopSource(), inner = src.metadata.controlFlow.root.nodes[0];
  inner.id = "inner"; src.steps[0].parameters.id = "{{inner.item}}"; inner.items.value = ref("each", "item");
  src.metadata.controlFlow.root.nodes[0] = { kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "array", items: { type: "string" } } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } }, body: seq(inner),
    collect: { schema: { type: "array", items: { type: "string" } }, value: ref("inner", "value") } };
  src.trigger.config.inputSchema.properties.items.items = { type: "array", items: { type: "string" } };
  src.metadata.controlFlow.root.nodes[1].output.schema.items = { type: "array", items: { type: "string" } };
  const outputs: Record<string, unknown> = {};
  rows.forEach((items, outer) => items.forEach((item, index) => { const prefix = `each/${outer}/inner/${index}/`;
    outputs[`${prefix}lookup`] = output(`Lookup ${item}`); outputs[`${prefix}body_next`] = output(`Body ${item}`); }));
  const actual = await parity(src, { items: rows }, outputs);
  expect(actual.snapshot.result).toEqual({ value: rows.map(items => items.map(item => `Body ${item}`)) });
});

test.each([NaN, new Date(), { unsafe: undefined }, () => true])("non-JSON output %j cannot be accepted or change the pending action", value => {
  const machine = new ProtectedMachine(plan(source()), {}); machine.peek(); machine.accept(); machine.peek();
  const saved = machine.snapshot(); expect(() => machine.accept(value)).toThrow(); expect(machine.snapshot()).toEqual(saved);
});

test.each([null, "false", 0, {}])("invalid predicate %j cannot be accepted as false or caught by a handler", value => {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0];
  group.body = seq({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: group.body, else: seq() });
  group.output.success = { kind: "literal", value: "Explicit successful path" };
  src.trigger.config = { inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false } };
  const compiled = plan(src);
  expect(() => new ProtectedMachine(compiled, { enabled: value })).toThrow(/input/);
  // Exercise the independent predicate guard with a non-authorizing pure
  // plan, not by relaxing the compiler or object-contract admission above.
  const semantics = protectedMachinePlan(compiled.sourceHash, compiled.flow, compiled.actions);
  const machine = new ProtectedMachine(semantics, { enabled: value }); machine.peek(); machine.accept();
  expect(machine.peek()).toMatchObject({ kind: "condition", valid: false }); const before = machine.snapshot();
  expect(() => machine.accept()).toThrow(); expect(() => machine.fail({ code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: "gate", failedInvocationId: "gate" })).toThrow();
  expect(machine.snapshot()).toEqual(before); machine.halt(); expect(machine.peek()).toBeNull(); expect(machine.snapshot().status).toBe("HALTED");
});

test("a fault cannot name another item, contain approval, or override an exact typed value", () => {
  const machine = new ProtectedMachine(plan(source()), {}); machine.peek(); machine.accept(); const point = machine.peek()!;
  const before = machine.snapshot();
  expect(() => machine.fail({ code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: point.nodeId, failedInvocationId: `each/0/${point.nodeId}` })).toThrow();
  expect(() => machine.fail({ code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: point.nodeId, failedInvocationId: point.invocationId, approval: true } as any)).toThrow();
  expect(machine.snapshot()).toEqual(before);
  const src = source(); src.metadata.controlFlow.root.nodes.unshift({ kind: "return", id: "first", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  const early = new ProtectedMachine(plan(src), {}); early.peek(); expect(() => early.accept({ value: true })).toThrow(); early.accept({ value: false });
});

test.each(["source", "semantic", "extra", "pending-owner", "iteration", "terminal"])("tampered continuation %s is refused as malformed data", damage => {
  const compiled = plan(loopSource()), machine = new ProtectedMachine(compiled, { items: ["A"] }); machine.peek(); machine.accept(); machine.peek();
  const saved: any = machine.snapshot();
  if (damage === "source") saved.sourceHash = `sha256:${"a".repeat(64)}`;
  if (damage === "semantic") saved.semanticHash = `sha256:${"b".repeat(64)}`;
  if (damage === "extra") saved.approval = true;
  if (damage === "pending-owner") saved.pending.kind = "condition";
  if (damage === "iteration") saved.iterations[0].index = 2;
  if (damage === "terminal") saved.status = "DONE";
  expect(() => new ProtectedMachine(compiled, {}, saved)).toThrow();
});

test("snapshots and forks cannot mutate the original machine or erase its pending boundary", () => {
  const compiled = plan(source()), machine = new ProtectedMachine(compiled, {}), point = machine.peek()!;
  const saved = machine.snapshot(); saved.frames.length = 0; point.nodeId = "fake";
  const fork = machine.fork(); fork.accept();
  expect(machine.peek()).toMatchObject({ kind: "protected-start", nodeId: "guard" });
  expect(fork.peek()).toMatchObject({ kind: "action", nodeId: "lookup" });
});

test("private JSON bounds reject getters without invoking them, symbols, cycles and sparse arrays", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "danger", { enumerable: true, get() { calls++; return "must not run"; } });
  const cyclic: any = {}; cyclic.self = cyclic;
  const symbol = { [Symbol("hidden")]: true }, sparse = Array(3);
  for (const value of [accessor, cyclic, symbol, sparse]) expect(() => boundProtectedMachineJSON(value)).toThrow();
  const compiled = plan(source()), poisonedPlan = { ...compiled };
  Object.defineProperty(poisonedPlan, "sourceHash", { enumerable: true, get: () => { calls++; return compiled.sourceHash; } });
  expect(() => new ProtectedMachine(poisonedPlan, {})).toThrow(/accessors/);
  const machine = new ProtectedMachine(compiled, {});
  machine.peek(); machine.accept(); // Acknowledge only the pure group-start boundary.
  const pending = machine.peek(), checkpoint = machine.snapshot();
  const poisonedFault = { code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: pending!.nodeId, failedInvocationId: pending!.invocationId };
  Object.defineProperty(poisonedFault, "code", { enumerable: true, get: () => { calls++; return "ERP_RESOURCE_NOT_FOUND"; } });
  expect(() => machine.fail(poisonedFault as any)).toThrow(/accessors/);
  expect(machine.snapshot()).toEqual(checkpoint);
  expect(calls).toBe(0);
});

test.each([{}, { items: null }, { items: "A" }, { items: ["A", "B", "C", "D"] }])("invalid/oversized collection %j cannot become an empty completed report", input => {
  const compiled = plan(loopSource());
  const semantics = protectedMachinePlan(compiled.sourceHash, compiled.flow, compiled.actions);
  const machine = new ProtectedMachine(semantics, input); expect(machine.peek()).toMatchObject({ kind: "collection-start", valid: false });
  const before = machine.snapshot(); expect(() => machine.accept()).toThrow(); expect(machine.snapshot()).toEqual(before);
});
