import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { compileOperationWorkflow, inspectWorkflowDraft, type ReadAdmissionPin } from "../src/workflows/compiled-read.js";
import { assertOperationSelectedNode, operationControlTransition } from "../src/workflows/operation-control-flow.js";
import { assertModelDataClassification } from "../src/workflows/model-data-classification.js";
import { applyWorkflowCommand, workflowCommandSchema } from "../src/workflows/commands.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import type { ReadRunProgress } from "../src/repository/store.js";

const role = "Platform Admin";
const read = toolSchema.parse({ tool_id: "report", name: "report.read", mcp_tool_name: "report.read", is_read_only: true, risk_level: "low", allowed_roles: [role],
  input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, bridge_contract: {
    profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: {
      type: "object", properties: { text: { type: "string" }, ready: { type: "boolean" } }, required: ["text", "ready"], additionalProperties: false,
    },
  } });
const send = toolSchema.parse({ ...read, tool_id: "send", name: "report.send", mcp_tool_name: "report.send", is_read_only: false, side_effects: ["Synthetic acceptance"],
  operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
  bridge_contract: { ...read.bridge_contract!, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } });
const tools = [read, send];
const pin = (tool: typeof read): ReadAdmissionPin => ({ connectionId: "erp", capabilityId: `cap-${tool.tool_id}`, revisionId: `rev-${tool.tool_id}`, admissionVersion: 1, contractHash: capabilityContractHash(tool) });
const pins = new Map(tools.map(tool => [tool.tool_id, pin(tool)]));
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes });
const action = (nodeId: string) => ({ kind: "action", nodeId });
const model = (id: string) => ({ id, kind: "analysis", description: "Bounded analysis", instruction: "Summarize confirmed data", input: "{{report.structuredContent.text}}",
  data_class: "internal", output_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } });
function source(): any { return { name: "Decision report", trigger: { type: "manual" }, steps: [
  { id: "report", action: read.name, parameters: { value: "seed" } }, model("yes_model"),
  { id: "yes_send", action: send.name, parameters: { value: "{{yes_model.structuredContent.summary}}" } }, model("no_model"),
  { id: "no_send", action: send.name, parameters: { value: "{{no_model.structuredContent.summary}}" } },
], metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: seq(action("report"), { kind: "if", id: "gate", predicate: { kind: "literal", value: true },
  then: seq(action("yes_model"), action("yes_send")), else: seq(action("no_model"), action("no_send")) }) } } }; }
const compile = (value = source()) => compileOperationWorkflow(stringify(value), tools, role, pins);

test("operation decisions have a distinct pinned v4 meaning and scope-aware draft hints", () => {
  const value = source(), plan = compile(value);
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-operation-ir/v4", compilerVersion: "operation-compiler/v4", flow: value.metadata.controlFlow.root });
  expect(inspectWorkflowDraft(parseWorkflowYAMLStrict(stringify(value)), tools, role).issues).toEqual([]);
  value.metadata.controlFlow.root.nodes[1].predicate.value = false; expect(compile(value).semanticHash).not.toBe(plan.semanticHash);
  const hints = readAuthoringContract(parseWorkflowYAMLStrict(stringify(source())), tools, role, "synthetic-hash");
  expect(hints).toMatchObject({ modelNodesSupported: true, executionProfile: "decision-operation-v1" });
  const no = hints.nodes.find(node => node.nodeId === "no_model")!;
  expect(no.dataSources.some(item => item.expression.includes("report.structuredContent"))).toBe(true);
  expect(no.dataSources.some(item => item.expression.includes("yes_model"))).toBe(false);
});

test.each(["sibling input", "branch escape", "forward predicate", "unknown predicate", "nonboolean predicate", "duplicate owner", "missing owner", "merge", "loop"])("operation compilation rejects %s without flattening", damage => {
  const value = source(), gate = value.metadata.controlFlow.root.nodes[1];
  if (damage === "sibling input") value.steps[3].input = "{{yes_model.structuredContent.summary}}";
  if (damage === "branch escape") { value.steps.push({ id: "after", action: read.name, parameters: { value: "{{yes_model.structuredContent.summary}}" } }); value.metadata.controlFlow.root.nodes.push(action("after")); }
  if (damage === "forward predicate") gate.predicate = { kind: "ref", source: "nodeOutput", nodeId: "yes_model", path: ["structuredContent", "ready"] };
  if (damage === "unknown predicate") gate.predicate = { kind: "ref", source: "nodeOutput", nodeId: "report", path: ["structuredContent", "missing"] };
  if (damage === "nonboolean predicate") gate.predicate = { kind: "ref", source: "nodeOutput", nodeId: "report", path: ["structuredContent", "text"] };
  if (damage === "duplicate owner") gate.else.nodes[0] = action("yes_model");
  if (damage === "missing owner") gate.then.nodes.pop();
  if (damage === "merge") { value.metadata.controlFlow.schemaVersion = "read-control-flow/v2"; gate.merge = { schema: { type: "string" }, then: { kind: "literal", value: true }, else: { kind: "literal", value: "no" } }; }
  if (damage === "loop") { value.metadata.controlFlow.schemaVersion = "read-control-flow/v3"; gate.then.nodes = [{ kind: "foreach", id: "each", maxItems: 2, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [] } }, body: seq(...gate.then.nodes), collect: { schema: { type: "string" }, value: { kind: "literal", value: "item" } } }]; }
  expect(() => compile(value)).toThrow("Operation compilation failed");
  expect(readAuthoringContract(parseWorkflowYAMLStrict(stringify(value)), tools, role, "synthetic-hash")).toMatchObject({ executionProfile: "unsupported-operation-control-flow", modelNodesSupported: false });
});

function progress(): ReadRunProgress { return { profile: "read-progress-v1", epoch: 1, persistence: "memory-only", nextStepIndex: 0, lastSequence: 0, attempts: {} }; }
function receipt(state: ReadRunProgress, id: string, status: "DONE" | "SKIPPED") {
  const index = state.nextStepIndex++; state.attempts[id] = { id: `attempt-${id}`, nodeId: id, stepIndex: index, status, startedAt: "2026-10-08T00:00:00Z" };
}
test.each(["then", "else"] as const)("only %s actions are eligible; the other branch needs explicit skip receipts", selected => {
  const plan = compile(), state = progress(), flow = plan.ir.flow!;
  expect(operationControlTransition(flow, state)).toMatchObject({ kind: "action", nodeId: "report", index: 0 }); receipt(state, "report", "DONE");
  expect(operationControlTransition(flow, state)).toMatchObject({ kind: "decision", node: { id: "gate" }, index: 1 });
  state.decisions = { gate: { status: "DONE", selected, evaluatedAt: "2026-10-08T00:00:00Z", stepIndex: 1 } };
  for (const [id, branch] of [["yes_model", "then"], ["yes_send", "then"], ["no_model", "else"], ["no_send", "else"]] as const) {
    expect(operationControlTransition(flow, state)).toMatchObject({ kind: branch === selected ? "action" : "skip", nodeId: id, index: state.nextStepIndex });
    if (branch === selected) expect(() => assertOperationSelectedNode(plan, state, id)).not.toThrow();
    else expect(() => assertOperationSelectedNode(plan, state, id)).toThrow();
    receipt(state, id!, branch === selected ? "DONE" : "SKIPPED");
  }
  expect(operationControlTransition(flow, state)).toEqual({ kind: "complete" });
  state.attempts.yes_model!.status = selected === "then" ? "SKIPPED" : "DONE";
  expect(() => operationControlTransition(flow, state)).toThrow();
});

test.each(["pointer jump", "phantom decision", "unselected dispatch", "wrong index"])("forged %s cannot authorize a branch", damage => {
  const flow = compile().ir.flow!, state = progress(); receipt(state, "report", "DONE");
  state.decisions = { gate: { status: "DONE", selected: "else", evaluatedAt: "2026-10-08T00:00:00Z", stepIndex: 1 } };
  if (damage === "pointer jump") state.nextStepIndex = 4;
  if (damage === "phantom decision") state.decisions.phantom = { ...state.decisions.gate! };
  if (damage === "unselected dispatch") receipt(state, "yes_model", "DONE");
  if (damage === "wrong index") state.decisions.gate!.stepIndex = 2;
  expect(() => operationControlTransition(flow, state)).toThrow();
});

test("a sensitive decision controls model egress even when its explicit input source is public", () => {
  const value = source(), publicRead = toolSchema.parse({ ...read, tool_id: "public-report", name: "public.read", mcp_tool_name: "public.read" });
  value.steps.splice(1, 0, { id: "public_report", action: publicRead.name, parameters: { value: "public" } });
  value.metadata.controlFlow.root.nodes.splice(1, 0, action("public_report"));
  value.metadata.controlFlow.root.nodes[2].predicate = { kind: "ref", source: "nodeOutput", nodeId: "report", path: ["structuredContent", "ready"] };
  for (const step of value.steps.filter((step: any) => step.kind === "analysis")) { step.input = "{{public_report.structuredContent.text}}"; step.data_class = "public"; }
  const allTools = [...tools, publicRead], allPins = new Map([...pins, [publicRead.tool_id, pin(publicRead)]]);
  const plan = compileOperationWorkflow(stringify(value), allTools, role, allPins);
  const classify = (source: ReadAdmissionPin) => source.capabilityId === "cap-report" ? "confidential" as const : "public" as const;
  expect(() => assertModelDataClassification(plan, classify)).toThrow(/require at least confidential/);
  for (const step of value.steps.filter((step: any) => step.kind === "analysis")) step.data_class = "confidential";
  expect(() => assertModelDataClassification(compileOperationWorkflow(stringify(value), allTools, role, allPins), classify)).not.toThrow();
});

test("model insertion before an exact branch target preserves ownership and source order", () => {
  const value = source(), change = workflowCommandSchema.parse({ type: "addAnalysis", node: { ...model("extra"), input: "{{report.structuredContent.text}}" }, beforeNodeId: "yes_send" });
  const changed = applyWorkflowCommand(stringify(value), change), blueprint = parseWorkflowYAMLStrict(changed);
  expect(blueprint.steps.map(step => step.id)).toEqual(["report", "yes_model", "extra", "yes_send", "no_model", "no_send"]);
  expect(inspectWorkflowDraft(blueprint, tools, role).issues).toEqual([]);
});

test.each(["analysis", "agent"] as const)("%s can be inserted directly into either empty operation branch and compile without flattening", kind => {
  for (const branch of ["then", "else"] as const) {
    const value = source(), gate = value.metadata.controlFlow.root.nodes[1], removed = branch === "then" ? ["yes_model", "yes_send"] : ["no_model", "no_send"];
    value.steps = value.steps.filter((step: any) => !removed.includes(step.id)); gate[branch].nodes = [];
    const opposite = structuredClone(gate[branch === "then" ? "else" : "then"]);
    const node = { ...model("inserted"), kind, ...(kind === "agent" ? { allowed_actions: [read.name],
      completion_predicate: { path: ["complete"], equals: true }, output_schema: { type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false } } : {}) };
    const changed = applyWorkflowCommand(stringify(value), workflowCommandSchema.parse({ type: kind === "analysis" ? "addAnalysis" : "addAgent", node,
      beforeNodeId: null, destination: { conditionId: "gate", branch } })), blueprint = parseWorkflowYAMLStrict(changed);
    const plan = compile(blueprint);
    expect(plan.ir.schemaVersion).toBe("workflow-operation-ir/v4");
    expect((plan.ir.flow!.nodes[1] as any)[branch].nodes).toEqual([action("inserted")]);
    expect((plan.ir.flow!.nodes[1] as any)[branch === "then" ? "else" : "then"]).toEqual(opposite);
    expect(blueprint.steps.map(step => step.id)).toEqual(branch === "then" ? ["report", "inserted", "no_model", "no_send"] : ["report", "yes_model", "yes_send", "inserted"]);
    expect(inspectWorkflowDraft(blueprint, tools, role).issues).toEqual([]);
  }
});

test.each([true, false])("nested decisions with empty paths account for every skipped action, outer=%s", outer => {
  const flow: any = seq({ kind: "if", id: "outer", predicate: { kind: "literal", value: outer }, then: seq(
    { kind: "if", id: "inner", predicate: { kind: "literal", value: false }, then: seq(action("a")), else: seq() }),
    else: seq(action("b")) }, action("tail"));
  const state = progress();
  state.decisions = { outer: { status: "DONE", selected: outer ? "then" : "else", evaluatedAt: "2026-10-08T00:00:00Z", stepIndex: 0 } };
  if (outer) {
    expect(operationControlTransition(flow, state)).toMatchObject({ kind: "decision", node: { id: "inner" }, index: 0 });
    state.decisions.inner = { status: "DONE", selected: "else", evaluatedAt: "2026-10-08T00:00:00Z", stepIndex: 0 };
  }
  expect(operationControlTransition(flow, state)).toMatchObject({ kind: "skip", nodeId: "a", index: 0 }); receipt(state, "a", "SKIPPED");
  expect(operationControlTransition(flow, state)).toMatchObject({ kind: outer ? "skip" : "action", nodeId: "b", index: 1 }); receipt(state, "b", outer ? "SKIPPED" : "DONE");
  expect(operationControlTransition(flow, state)).toMatchObject({ kind: "action", nodeId: "tail", index: 2 }); receipt(state, "tail", "DONE");
  expect(operationControlTransition(flow, state)).toEqual({ kind: "complete" });
  if (!outer) { state.decisions.inner = { ...state.decisions.outer! }; expect(() => operationControlTransition(flow, state)).toThrow(); }
});
