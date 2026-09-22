import { expect, test } from "vitest";
import { stringify } from "yaml";
import { compileProtectedOperationWorkflow, assertProtectedOperationPlanCurrent } from "../src/workflows/protected-operation-compiler.js";
import { compileOperationWorkflow, compileReadWorkflow, type ReadAdmissionPin, type ReadReference } from "../src/workflows/compiled-read.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { toolSchema, type ToolDefinition } from "../src/registry/schemas.js";
import { ProtectedMachine } from "../src/workflows/protected-machine.js";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../src/core/canonical-json.js";
import type { ModelDataClass } from "../src/providers/egress-policy.js";
import type { ReadControlNode, ReadSequence } from "../src/workflows/read-control-flow.js";
import { protectedSimulationSource as source, protectedSimulationRead as read, protectedSimulationRole as role } from "./fixtures/protected-simulation.js";

const seq = (...nodes: ReadControlNode[]): ReadSequence => ({ kind: "sequence", nodes });
const action = (nodeId: string): ReadControlNode => ({ kind: "action", nodeId });
const ref = (nodeId: string, ...path: string[]): ReadReference => ({ kind: "ref", source: "nodeOutput", nodeId, path });

const pin = (tool: ToolDefinition): ReadAdmissionPin => ({ connectionId: "erp", capabilityId: `cap-${tool.tool_id}`, revisionId: `rev-${tool.tool_id}`,
  admissionVersion: 1, contractHash: capabilityContractHash(tool) });
function fixture(seedInput = false) {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0]; src.steps.pop(); src.steps[0].parameters.id = "{{each.item}}";
  const seed = toolSchema.parse({ ...read, tool_id: "seed-read", name: "hr.items.read", mcp_tool_name: "hr.items.read",
    bridge_contract: { ...read.bridge_contract, output_schema: { type: "object", properties: { items: { type: "array", items: { type: "string" } }, flag: { type: "boolean" } }, required: ["items", "flag"], additionalProperties: false } } });
  const loop: Extract<ReadControlNode, { kind: "foreach" }> = { kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: seedInput ? ref("seed", "structuredContent", "items") : { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(group), collect: { schema: { type: "string" }, value: ref("guard", "value") } };
  src.metadata.controlFlow.root = seq(...(seedInput ? [action("seed")] : []), loop,
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("each", "value") } });
  src.trigger.config = { inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false } };
  if (seedInput) src.steps.unshift({ id: "seed", action: seed.name, parameters: { id: "synthetic" } });
  const tools = seedInput ? [seed, structuredClone(read)] : [structuredClone(read)], pins = new Map(tools.map(tool => [tool.tool_id, pin(tool)]));
  return { src, loop, group, tools, pins };
}
const compile = (f: ReturnType<typeof fixture>, classify: (pin: ReadAdmissionPin) => ModelDataClass = () => "internal") =>
  compileProtectedOperationWorkflow(stringify(f.src), f.tools, role, f.pins, classify);
function modelFixture(kind: "analysis" | "agent", seed = true) {
  const f = fixture(seed), at = f.src.steps.findIndex((step: any) => step.id === "body_next");
  f.src.steps[at] = { id: "body_next", kind, instruction: "Return the exact acknowledged employee text", input: "{{lookup.structuredContent.text}}", model: "fixture-pinned-v1",
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, data_class: seed ? "internal" : "restricted",
    ...(kind === "agent" ? { allowed_actions: [read.name], completion_predicate: { path: ["text"], equals: "complete" }, max_rounds: 2, max_tool_calls: 1 } : {}) };
  return f;
}

test("v9 preserves original definitions, complete scoped contracts and distinct operation/kernel identities", () => {
  const f = fixture(), before = structuredClone(f.src), plan = compile(f);
  expect(plan.ir.schemaVersion).toBe("workflow-operation-ir/v9"); expect(plan.ir.root.nodes.map(node => node.id)).toEqual(["lookup", "body_next", "fallback"]);
  expect(plan.ir.contracts[read.tool_id]).toMatchObject({ inputSchema: read.input_schema, outputSchema: read.bridge_contract!.output_schema, readErrorContract: read.read_error_contract });
  expect(plan.ir.flow).toEqual(before.metadata.controlFlow.root); expect(plan.ir.verifiedRole).toBe(role);
  expect(plan.semanticHash).toBe(resolvedParameterHashBytes(canonicalJSONBytes(plan.ir))); expect(plan.semanticHash).not.toBe(plan.machine.semanticHash);
  expect(plan.machine.sourceHash).toBe(plan.sourceHash); expect(f.src).toEqual(before);
  const machine = new ProtectedMachine(plan.machine, { items: ["A", "B"] }); expect(machine.peek()?.kind).toBe("collection-start");
  expect(plan.ir.provenance.nodes.each).toBe("restricted"); expect(plan.ir.provenance.handlerFaults.guard).toBe("restricted");
  expect(plan).not.toHaveProperty("receipt"); expect(plan).not.toHaveProperty("admitted");
});
test("compiling v9 does not enable old publication/read compilation or flatten repeated actions", () => {
  const f = fixture(); compile(f);
  expect(() => compileOperationWorkflow(stringify(f.src), f.tools, role, f.pins)).toThrow(/durable operation iteration/);
  expect(() => compileReadWorkflow(stringify(f.src), f.tools, role, f.pins)).toThrow();
});
test.each(["missing", "contract", "revision", "version", "extra", "connection", "role", "duplicate-tool", "schema", "no-error-source", "item-escape", "handler-body-leak", "return-in-loop", "unknown-node", "too-many-visits"])("invalid %s cannot compile into v9", damage => {
  const f = fixture();
  if (damage === "missing") f.pins.clear();
  if (damage === "contract") f.pins.get(read.tool_id)!.contractHash = `sha256:${"b".repeat(64)}`;
  if (damage === "revision") f.pins.get(read.tool_id)!.revisionId = "";
  if (damage === "version") f.pins.get(read.tool_id)!.admissionVersion = 0;
  if (damage === "extra") (f.pins.get(read.tool_id)! as any).approved = true;
  if (damage === "connection") { f.src.steps[0].connection_id = "other"; }
  if (damage === "role") { f.tools[0]!.allowed_roles = ["Other"]; f.pins.set(read.tool_id, pin(f.tools[0]!)); }
  if (damage === "duplicate-tool") f.tools.push({ ...f.tools[0]!, name: "another", mcp_tool_name: "another" });
  if (damage === "schema") { f.tools[0]!.input_schema.anyOf = []; f.pins.set(read.tool_id, pin(f.tools[0]!)); }
  if (damage === "no-error-source") { delete f.tools[0]!.read_error_contract; f.pins.set(read.tool_id, pin(f.tools[0]!)); }
  if (damage === "item-escape") f.src.metadata.controlFlow.root.nodes.at(-1).output.value = ref("each", "item");
  if (damage === "handler-body-leak") f.src.steps[2].parameters.id = "{{lookup.structuredContent.text}}";
  if (damage === "return-in-loop") f.group.body.nodes.push({ kind: "return", id: "early", output: { schema: { type: "string" }, value: ref("lookup", "structuredContent", "text") } });
  if (damage === "unknown-node") f.group.body.nodes.push(action("foreign"));
  if (damage === "too-many-visits") { f.loop.maxItems = 100; f.group.body.nodes.unshift({ kind: "foreach", id: "nested", maxItems: 100, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } }, body: seq(), collect: { schema: { type: "string" }, value: { kind: "literal", value: "bounded" } } }); }
  expect(() => compile(f)).toThrow();
});
test.each(["analysis", "agent"] as const)("original %s definition, completion and model policy remain compiled", kind => {
  const f = modelFixture(kind), plan = compile(f), node = plan.ir.root.nodes.find(node => node.id === "body_next")!;
  expect(node.kind).toBe(kind); expect(node).toMatchObject({ instruction: f.src.steps[2].instruction, model: "fixture-pinned-v1", dataClass: "internal", outputSchema: f.src.steps[2].output_schema });
  if (node.kind === "agent") { expect(node.allowedCapabilities[0]!.admission).toEqual(f.pins.get(read.tool_id)); expect(node.maxRounds).toBe(2); }
});
test.each(["analysis", "agent"] as const)("%s cannot downgrade confidential item or handler provenance", kind => {
  const f = modelFixture(kind), classes = (pin: ReadAdmissionPin): ModelDataClass => pin.capabilityId === "cap-seed-read" ? "public" : "confidential";
  expect(() => compile(f, classes)).toThrow(/body_next.*confidential/); f.src.steps[2].data_class = "confidential";
  expect(compile(f, classes).ir.provenance.nodes.each).toBe("confidential");
  f.src.steps[3] = { ...f.src.steps[2], id: "fallback", input: "{{guard.error.code}}", data_class: "internal" };
  expect(() => compile(f, classes)).toThrow(/fallback.*confidential/);
});
test.each(["analysis", "agent"] as const)("%s cannot declassify unreviewed caller item input", kind => {
  const f = modelFixture(kind, false); f.src.steps[1].data_class = "internal";
  expect(() => compile(f, () => "public")).toThrow(/restricted/); f.src.steps[1].data_class = "restricted";
  expect(compile(f, () => "public").ir.provenance.nodes.each).toBe("restricted");
});
test("missing agent allow-list review never uses draft-inspection's relaxed projection", () => {
  const f = modelFixture("agent"); const extra = { ...f.tools[0]!, tool_id: "extra", name: "hr.extra.read", mcp_tool_name: "hr.extra.read" }; f.tools.push(extra);
  f.src.steps[2].allowed_actions = [extra.name]; expect(() => compile(f)).toThrow();
});
test.each(["revision", "class", "model", "instruction", "schema", "parameters"])("semantic identity binds changed %s", field => {
  const f = modelFixture("analysis"), first = compile(f);
  if (field === "revision") f.pins.get(read.tool_id)!.revisionId = "new-review";
  if (field === "model") f.src.steps[2].model = "fixture-pinned-v2";
  if (field === "instruction") f.src.steps[2].instruction = "Return a reviewed summary";
  if (field === "schema") f.src.steps[2].output_schema.properties.note = { type: "string" };
  if (field === "parameters") f.src.steps[1].parameters.id = "constant";
  const second = compile(f, () => field === "class" ? "public" : "internal"); expect(second.semanticHash).not.toBe(first.semanticHash);
});
test("capability classification is captured once per exact pin and cannot drift during provenance", () => {
  const f = modelFixture("agent"), seen = new Map<string, number>();
  const plan = compile(f, pin => { seen.set(pin.capabilityId, (seen.get(pin.capabilityId) ?? 0) + 1); return "internal"; });
  expect([...seen.values()]).toEqual([1, 1]); expect(plan.ir.capabilityClasses).toHaveLength(2);
  expect(() => compile(f, () => "invalid" as any)).toThrow(/Unknown/);
});
test("compiled definitions are isolated from caller registry, pins and source mutation", () => {
  const f = modelFixture("agent"), plan = compile(f), before = structuredClone(plan);
  f.tools[0]!.input_schema.type = "string"; f.pins.get(read.tool_id)!.revisionId = "foreign"; f.src.steps[2].instruction = "foreign";
  expect(plan).toEqual(before);
});

test.each(["effect", "readback"])("exact %s definitions and reviews remain in the full operation IR", mode => {
  const f = fixture();
  const target = toolSchema.parse({ ...read, tool_id: "status-read", name: "hr.status.read", mcp_tool_name: "hr.status.read", allowed_roles: ["ERP Recovery"],
    bridge_contract: { ...read.bridge_contract, output_schema: { type: "object", properties: { id: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" } }, required: ["id", "state", "settled", "observedAt"], additionalProperties: false } } });
  const { read_error_contract: _readError, ...effectBase } = read;
  const effect = toolSchema.parse({ ...effectBase, tool_id: "send-effect", name: "hr.send", mcp_tool_name: "hr.send", is_read_only: false,
    side_effects: ["notification"], bridge_contract: { ...read.bridge_contract, output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } },
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" },
      ...(mode === "readback" ? { readback: { profile: "operation-readback-contract/v1", tool_id: target.tool_id, contract_hash: capabilityContractHash(target), arguments: [{ parameter: "id", source_path: ["id"] }], correlation: [{ source_path: ["id"], result_path: ["id"] }], settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60, outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, evidence_meaning: "operation-state" } } : {}) } });
  f.tools.push(effect); f.pins.set(effect.tool_id, pin(effect));
  if (mode === "readback") { f.tools.push(target); f.pins.set(target.tool_id, pin(target)); }
  f.src.steps.push({ id: "send", action: effect.name, parameters: { id: "synthetic-only" } }); f.src.metadata.controlFlow.root.nodes.splice(1, 0, action("send"));
  const plan = compile(f), node = plan.ir.root.nodes.at(-1)!;
  expect(node).toMatchObject({ id: "send", effectClass: "notification", capability: { admission: pin(effect) } });
  expect(plan.ir.contracts[effect.tool_id]!.operationContract).toEqual(effect.operation_contract);
  if (mode === "readback") {
    expect(node).toHaveProperty("readback.admission", pin(target)); expect(plan.ir.contracts[target.tool_id]!.outputSchema).toEqual(target.bridge_contract!.output_schema);
    f.pins.delete(target.tool_id); expect(() => compile(f)).toThrow();
  }
});

test.each(["read-risk", "read-effect", "missing-output", "effect-confirmation", "unknown-report"])("unsupported %s cannot hide behind a syntactic pin", damage => {
  const f = fixture(), tool = f.tools[0]!;
  if (damage === "read-risk") tool.risk_level = "high";
  if (damage === "read-effect") tool.side_effects = ["write"];
  if (damage === "missing-output") delete tool.bridge_contract!.output_schema;
  if (damage === "effect-confirmation") { tool.is_read_only = false; delete tool.read_error_contract; tool.side_effects = ["write"]; tool.operation_contract = { profile: "operation-result/v1", effect_class: "write", retry_policy: "never", confirmation: { path: ["missing"], expected: true, meaning: "operation-accepted" } }; }
  if (damage === "unknown-report") tool.report_coverage_contract = { profile: "counterfeit" } as any;
  f.pins.set(read.tool_id, pin(tool)); expect(() => compile(f)).toThrow();
});

test.each(["ir", "kernel", "source", "review", "class", "hidden-field", "ir-hidden-field", "machine-hidden-field"])("fresh full-plan revalidation denies changed %s", damage => {
  const f = modelFixture("analysis"), saved = compile(f);
  assertProtectedOperationPlanCurrent(saved, stringify(f.src), f.tools, role, f.pins, () => "internal");
  if (damage === "ir") saved.ir.root.nodes[0]!.id = "foreign";
  if (damage === "kernel") saved.machine.actions[0]!.input = { kind: "literal", value: "foreign" };
  if (damage === "source") saved.sourceHash = `sha256:${"b".repeat(64)}`;
  if (damage === "review") f.pins.get(read.tool_id)!.revisionId = "foreign";
  if (damage === "hidden-field") (saved as any).approved = true;
  if (damage === "ir-hidden-field") (saved.ir as any).approved = true;
  if (damage === "machine-hidden-field") (saved.machine as any).approved = true;
  expect(() => assertProtectedOperationPlanCurrent(saved, stringify(f.src), f.tools, role, f.pins, () => damage === "class" ? "public" : "internal")).toThrow();
});

test("private canonical-byte reuse retains complete Unicode/escaped IR and machine equality without exposing a byte cache", () => {
  const f = modelFixture("analysis"); f.src.steps[2].instruction += ' <ERP & model> \u2028 \u2029 "quoted"';
  f.src.steps[0].parameters.id = "<source & input> \u2028";
  const saved = compile(f);
  expect(saved.semanticHash).toBe(resolvedParameterHashBytes(canonicalJSONBytes(saved.ir)));
  expect(Object.keys(saved).sort()).toEqual(["ir", "machine", "semanticHash", "sourceHash"]);
  assertProtectedOperationPlanCurrent(saved, stringify(f.src), f.tools, role, f.pins, () => "internal");
});
test("a review callback cannot erase a captured supplied-artifact substitution before full comparison", () => {
  const f = fixture(), saved = compile(f); (saved as any).approved = true;
  expect(() => assertProtectedOperationPlanCurrent(saved, stringify(f.src), f.tools, role, f.pins, () => {
    delete (saved as any).approved; return "internal";
  })).toThrow(/changed/);
});

test("review callbacks cannot mutate captured registry/pins midway through compilation", () => {
  const f = modelFixture("agent"), expected = compile(f);
  const actual = compile(f, () => { f.tools[0]!.input_schema.type = "string"; f.pins.get(read.tool_id)!.revisionId = "foreign"; return "internal"; });
  expect(actual).toEqual(expected);
});

test("sensitive predicate selection cannot lower a public model input's class", () => {
  const f = modelFixture("analysis"), body = f.group.body;
  body.nodes[1] = { kind: "if", id: "choose", predicate: ref("seed", "structuredContent", "flag"), then: seq(action("body_next")), else: seq(action("otherbody")),
    merge: { schema: { type: "string" }, then: ref("body_next", "structuredContent", "text"), else: ref("otherbody", "structuredContent", "text") } };
  f.src.steps.splice(3, 0, { id: "otherbody", action: read.name, parameters: { id: "other" } }); f.group.output.success = ref("choose", "value");
  const classes = (pin: ReadAdmissionPin): ModelDataClass => pin.capabilityId === "cap-seed-read" ? "confidential" : "public";
  expect(() => compile(f, classes)).toThrow(/body_next.*confidential/); f.src.steps[2].data_class = "confidential";
  expect(compile(f, classes).ir.provenance.nodes.choose).toBe("confidential");
});

test("collected and handled aggregate values keep their sensitivity in a later model", () => {
  const f = fixture(true);
  f.src.steps.push({ id: "summary", kind: "analysis", instruction: "Return the complete collected text", input: "{{each.value}}", model: "fixture-pinned-v1",
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, data_class: "internal" });
  f.src.metadata.controlFlow.root.nodes.pop(); f.src.metadata.controlFlow.root.nodes.push(action("summary"));
  expect(() => compile(f, () => "confidential")).toThrow(/summary.*confidential/); f.src.steps.at(-1).data_class = "confidential";
  expect(compile(f, () => "confidential").ir.provenance.nodes.summary).toBe("confidential");
});

test("nested loops retain scoped item schemas and typed nested aggregate", () => {
  const f = fixture(), inner = structuredClone(f.loop); inner.id = "nested"; inner.items.value = ref("each", "item");
  f.src.steps[0].parameters.id = "{{nested.item}}";
  f.loop.items.schema.items = { type: "array", items: { type: "string" } }; f.loop.body = seq(inner);
  f.loop.collect.schema = { type: "array", items: { type: "string" } }; f.loop.collect.value = ref("nested", "value");
  f.src.trigger.config.inputSchema.properties.items.items = { type: "array", items: { type: "string" } };
  f.src.metadata.controlFlow.root.nodes.at(-1).output.schema.items = { type: "array", items: { type: "string" } };
  const plan = compile(f); expect(plan.ir.provenance.nodes.nested).toBe("restricted");
  expect(new ProtectedMachine(plan.machine, { items: [["A"], ["B"]] }).peek()?.valid).toBe(true);
});

test("an enclosing protected group keeps the loop aggregate and separate handler scope", () => {
  const f = fixture(), outputSchema = { type: "array", items: { type: "string" } };
  const outer = { kind: "protect", id: "outer", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: seq(f.loop), handler: seq(),
    output: { schema: outputSchema, success: ref("each", "value"), handled: { kind: "array", items: [] } } };
  f.src.metadata.controlFlow.root.nodes[0] = outer; f.src.metadata.controlFlow.root.nodes.at(-1).output.value = ref("outer", "value");
  const plan = compile(f); expect(plan.ir.provenance.nodes.outer).toBe("restricted"); expect(plan.ir.provenance.handlerFaults.outer).toBe("restricted");
});
