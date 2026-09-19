import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { compileOperationWorkflow, inspectWorkflowDraft, resolveReadBinding, type ReadAdmissionPin } from "../src/workflows/compiled-read.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { operationControlTransition } from "../src/workflows/operation-control-flow.js";
import { assertModelDataClassification } from "../src/workflows/model-data-classification.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { simulateModelWorkflow, parseModelFixtures } from "../src/workflows/model-simulation.js";
import { Repository, type Execution } from "../src/repository/store.js";
import { advanceOperationDecisions } from "../src/runner/operation-control-checkpoints.js";
import { assertOperationReturnCompletion } from "../src/runner/operation-return-checkpoints.js";
import { operationValueState } from "../src/runner/operation-merge-checkpoints.js";
import { scheduledReportPaths } from "../src/runner/scheduled-report-paths.js";
import { validateAnalysisStepStructure } from "../src/validator/step-structure.js";
import { selectedPrerequisiteYAML } from "../src/workflows/selected-prerequisite-view.js";

const role = "Platform Admin", tool = toolSchema.parse({ tool_id: "read", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role],
  input_schema: { type: "object", properties: {}, additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } } });
const pin: ReadAdmissionPin = { connectionId: "erp", capabilityId: "cap-read", revisionId: "rev-read", admissionVersion: 1, contractHash: capabilityContractHash(tool) };
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes }), action = (nodeId: string) => ({ kind: "action", nodeId }), ref = (nodeId: string, ...path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const answer = { type: "object", properties: { text: { type: "string" }, complete: { type: "boolean" } }, required: ["text", "complete"], additionalProperties: false };
const model = (id: string, input: string, kind = "analysis") => ({ id, kind, instruction: "Use the exact supplied text", input, data_class: "internal", output_schema: answer,
  ...(kind === "agent" ? { allowed_actions: ["read"], completion_predicate: { path: ["complete"], equals: true } } : {}) });
function source(kind = "analysis", selected = true): any {
  return { name: "Typed branch handoff", trigger: { type: "manual" }, steps: [
    { id: "lookup", action: "read", parameters: {} }, model("yes", "{{lookup.structuredContent}}", kind), model("no", "{{lookup.structuredContent}}", kind), model("after", "{{gate.value}}", kind),
  ], metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: seq(action("lookup"), { kind: "if", id: "gate", predicate: { kind: "literal", value: selected },
    then: seq(action("yes")), else: seq(action("no")), merge: { schema: answer, then: ref("yes", "structuredContent"), else: ref("no", "structuredContent") } }, action("after"),
    { kind: "return", id: "answer", output: { schema: { type: "string" }, value: ref("after", "structuredContent", "text") } }) } } };
}
const compile = (value = source()) => compileOperationWorkflow(stringify(value), [tool], role, new Map([[tool.tool_id, pin]]));

test.each(["analysis", "agent"])("%s branch output compiles as v7 and exposes only explicit scope-safe sources", kind => {
  const value = source(kind), blueprint = parseWorkflowYAMLStrict(stringify(value)), plan = compile(value);
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-operation-ir/v7", compilerVersion: "operation-compiler/v7" });
  expect(inspectWorkflowDraft(blueprint, [tool], role).issues).toEqual([]);
  const hints = readAuthoringContract(blueprint, [tool], role, "registry");
  expect(hints).toMatchObject({ modelNodesSupported: true, returnNodesSupported: true, mergeNodesSupported: true });
  expect(hints.nodes.find(node => node.nodeId === "after")!.dataSources.some(source => source.expression === "{{gate.value}}")).toBe(true);
  expect(hints.nodes.find(node => node.nodeId === "after")!.dataSources.some(source => source.expression.includes("yes."))).toBe(false);
  expect(hints.conditions![0]!.mergeSources.then.some(source => source.expression === "{{yes.structuredContent}}")).toBe(true);
  expect(hints.conditions![0]!.mergeSources.then.some(source => source.expression.includes("no."))).toBe(false);
});
test.each(["sibling", "future", "self", "wrong-type", "duplicate", "missing-map", "legacy-v1", "direct-escape"])("invalid merge %s fails before publication", damage => {
  const value = source(), gate = value.metadata.controlFlow.root.nodes[1];
  if (damage === "sibling") gate.merge.then.nodeId = "no";
  if (damage === "future") gate.merge.then.nodeId = "after";
  if (damage === "self") gate.merge.then = ref("gate", "value");
  if (damage === "wrong-type") gate.merge.schema = { type: "boolean" };
  if (damage === "duplicate") gate.id = "lookup";
  if (damage === "missing-map") delete gate.merge.else;
  if (damage === "legacy-v1") value.metadata.controlFlow.schemaVersion = "read-control-flow/v1";
  if (damage === "direct-escape") value.steps[3].input = "{{yes.structuredContent}}";
  expect(() => compile(value)).toThrow();
});
test.each(["source", "predicate", "high-model"])("merge cannot lower %s data classification across routing", reason => {
  const value = source();
  if (reason === "predicate") { value.trigger.config = { inputSchema: { type: "object", properties: { selected: { type: "boolean" } }, required: ["selected"] } }; value.metadata.controlFlow.root.nodes[1].predicate = { kind: "ref", source: "workflowInput", path: ["selected"] }; value.steps[1].data_class = value.steps[2].data_class = "restricted"; }
  if (reason === "high-model") value.steps[1].data_class = "restricted";
  expect(() => assertModelDataClassification(compile(value), () => reason === "source" ? "confidential" : "internal")).toThrow(/at least confidential|at least restricted/);
  for (const node of value.steps.slice(1)) node.data_class = "restricted";
  expect(() => assertModelDataClassification(compile(value), () => "confidential")).not.toThrow();
});
async function fixture(selected = true, value = source("analysis", selected)) {
  const plan = compile(value), repository = await Repository.open(null), state = await repository.snapshot();
  state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: "now" };
  state.workflows.flow = { id: "flow", name: "Flow", description: "", owner: { id: "actor", name: "Actor" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" }, steps: value.steps.length,
    successRate: 0, lastRunAt: null, publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: "now", updatedAt: "now", yaml: stringify(value), archived: false };
  const run = { id: "run", workflowId: "flow", status: "RUNNING", startedBy: { id: "actor", name: "Actor" }, operationSecret: { state: "CLAIMED", actorId: "actor", admittedRole: role, intents: {} },
    workflowSnapshot: { input: {}, operationCompilation: { semanticHash: plan.semanticHash } }, readProgress: { profile: "read-progress-v1", epoch: 1, persistence: "memory-only", nextStepIndex: 1, lastSequence: 0,
      attempts: { lookup: { id: "read-attempt", nodeId: "lookup", stepIndex: 0, status: "DONE", startedAt: "now" } } }, stepOutputs: { lookup: { structuredContent: { text: "source" } } } } as unknown as Execution;
  state.executions.run = run; await repository.close(); return { state, run, plan };
}
function done(run: Execution, nodeId: string, output: unknown) {
  run.readProgress!.attempts[nodeId] = { id: nodeId, nodeId, stepIndex: run.readProgress!.nextStepIndex, status: "DONE", startedAt: "now" };
  run.readProgress!.nextStepIndex++; run.stepOutputs![nodeId] = { structuredContent: output };
}
test.each([true, false])("confirmed selected=%s branch value feeds later model and Return; replay is observational", async selected => {
  const { state, run, plan } = await fixture(selected), id = selected ? "yes" : "no";
  expect(advanceOperationDecisions(state, run, plan)).toMatchObject({ kind: "action", nodeId: id }); done(run, id, { text: id, complete: true });
  expect(advanceOperationDecisions(state, run, plan)).toMatchObject({ kind: "action", nodeId: "after" });
  expect(run.valueOutputs).toEqual({ gate: { value: { text: id, complete: true } } }); expect(run.finalOutput).toBeUndefined();
  expect(resolveReadBinding((plan.ir.root.nodes[3] as any).input, operationValueState(run))).toEqual({ text: id, complete: true });
  const before = structuredClone(state); advanceOperationDecisions(state, run, plan); expect(state).toEqual(before);
  done(run, "after", { text: "follow-up", complete: true }); expect(advanceOperationDecisions(state, run, plan)).toEqual({ kind: "complete" });
  expect(run.finalOutput).toBe("follow-up"); expect(assertOperationReturnCompletion(state, run, plan)).toBe("answer");
  expect(state.executionEvents.run!.filter(event => event.type === "value.merged")).toHaveLength(1);
});
test.each(["missing", "wrong-type", "redaction"])("invalid selected %s branch answer fails without dependent dispatch or fallback", async reason => {
  const value = source(); if (reason === "redaction") { value.metadata.controlFlow.root.nodes[1].merge.schema = { type: "object", properties: { api_key: { type: "string" } }, required: ["api_key"] }; value.metadata.controlFlow.root.nodes[1].merge.then = { kind: "object", fields: { api_key: { kind: "literal", value: "synthetic-only" } } }; value.metadata.controlFlow.root.nodes[1].merge.else = value.metadata.controlFlow.root.nodes[1].merge.then; value.steps[3].input = "{{lookup.structuredContent}}"; }
  const { state, run, plan } = await fixture(true, value); advanceOperationDecisions(state, run, plan); done(run, "yes", reason === "missing" ? undefined : reason === "wrong-type" ? { text: 12, complete: true } : { text: "safe", complete: true });
  expect(advanceOperationDecisions(state, run, plan)).toEqual({ kind: "failed" }); expect(run.failure!.failureCategory).toBe("OPERATION_MERGE_INVALID");
  expect(run.valueOutputs).toBeUndefined(); expect(run.readProgress!.attempts.after).toBeUndefined(); expect(run.finalOutput).toBeUndefined();
});
test.each(["receipt", "answer", "source", "selection", "timeline", "event", "orphan-output", "orphan-receipt"])("tampered %s cannot authorize a dependent action", async damage => {
  const { state, run, plan } = await fixture(); advanceOperationDecisions(state, run, plan); done(run, "yes", { text: "confirmed", complete: true }); advanceOperationDecisions(state, run, plan);
  if (damage === "receipt") run.readProgress!.values!.gate!.stepIndex++;
  if (damage === "answer") run.valueOutputs!.gate!.value = { text: "invented", complete: true };
  if (damage === "source") run.stepOutputs!.yes = { structuredContent: { text: "changed", complete: true } };
  if (damage === "selection") run.readProgress!.decisions!.gate!.selected = "else";
  if (damage === "timeline") state.timelines.run!.find(entry => entry.id === "value_gate")!.output = { value: "invented" };
  if (damage === "event") state.executionEvents.run = [];
  if (damage === "orphan-output") run.valueOutputs!.phantom = { value: true };
  if (damage === "orphan-receipt") run.readProgress!.values!.phantom = { ...run.readProgress!.values!.gate! };
  expect(() => advanceOperationDecisions(state, run, plan)).toThrow(); expect(run.readProgress!.attempts.after).toBeUndefined();
});
test("branch Return bypasses its merge and all later parent work; no orphan branch output is invented", async () => {
  const value = source(); value.metadata.controlFlow.root.nodes[1].then.nodes.push({ kind: "return", id: "early", output: { schema: { type: "string" }, value: { kind: "literal", value: "explicit early" } } });
  const { state, run, plan } = await fixture(true, value); advanceOperationDecisions(state, run, plan); done(run, "yes", { text: "yes", complete: true });
  expect(advanceOperationDecisions(state, run, plan)).toEqual({ kind: "complete" }); expect(run.valueOutputs).toEqual({ early: { value: "explicit early" } });
  expect(run.readProgress!.values!.gate).toBeUndefined(); expect(assertOperationReturnCompletion(state, run, plan)).toBe("early");
});
test.each([true, false])("no-live fixture merge selected=%s uses exact supplied branch evidence and follow-up answer", async selected => {
  const value = source("analysis", selected), yaml = stringify(value), result = await simulateModelWorkflow(yaml, {}, parseModelFixtures({ profile: "model-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml),
    outputs: { lookup: { content: [], structuredContent: { text: "read" } }, yes: { structuredContent: { text: "yes", complete: true } }, no: { structuredContent: { text: "no", complete: true } }, after: { structuredContent: { text: "supplied follow-up", complete: true } } } }), [tool], role);
  expect(result.outcome).toBe("SIMULATED_COMPLETE"); expect(result.valueOutputs.gate).toEqual({ value: { text: selected ? "yes" : "no", complete: true } });
  expect(result.trace.find(entry => entry.nodeId === "after")!.arguments).toEqual({ text: selected ? "yes" : "no", complete: true }); expect("finalOutput" in result && result.finalOutput).toBe("supplied follow-up");
});
test("merge control cannot silently activate calendar report/effect semantics", () => {
  expect(() => scheduledReportPaths(compile(), [tool], { profile: "workflow-report-window-input-binding/v1", startAtInput: "startAt", endAtInput: "endAt" })).toThrow(/decision-only/);
});
test("selected prerequisite view excludes skipped actions while keeping exact merge ownership for model shapes", () => {
  const value = parseWorkflowYAMLStrict(stringify(source())), filtered = parseWorkflowYAMLStrict(selectedPrerequisiteYAML(value, "after", new Set(["lookup", "no"]))), result = { schema_ok: true, errors: [] as string[] };
  expect(filtered.steps.map(step => step.id)).toEqual(["lookup", "no", "after"]);
  validateAnalysisStepStructure(filtered, 2, result); expect(result).toEqual({ schema_ok: true, errors: [] });
  expect(parseWorkflowYAMLStrict(stringify(source())).steps).toHaveLength(4);
});
test.each(["undeclared", "before-merge", "branch-local", "duplicate-owner"])("model structure rejects %s merge-source claims", damage => {
  const value = source(), gate = value.metadata.controlFlow.root.nodes[1];
  if (damage === "undeclared") delete gate.merge;
  if (damage === "before-merge") value.steps[1].input = "{{gate.value}}";
  if (damage === "branch-local") { const later = value.metadata.controlFlow.root.nodes.splice(2, 1)[0]; gate.else.nodes.push(later); value.steps = [value.steps[0], value.steps[1], value.steps[2], value.steps[3]]; }
  if (damage === "duplicate-owner") gate.then.nodes.push(action("after"));
  const target = damage === "before-merge" ? 1 : 3, result = { schema_ok: true, errors: [] as string[] };
  // A model may consume a merge only after that merge in its own lexical scope.
  // Put the branch-local target before the owning merge, not after its branch.
  if (damage === "branch-local") value.steps[3].input = "{{gate.value}}";
  validateAnalysisStepStructure(value, target, result); expect(result.schema_ok).toBe(false);
});
test("nested selected merge is confirmed before its parent and never leaks the unselected nested answer", async () => {
  const value = source(), gate = value.metadata.controlFlow.root.nodes[1];
  gate.then = seq({ kind: "if", id: "inner", predicate: { kind: "literal", value: true }, then: seq(action("yes")), else: seq(), merge: { schema: answer,
    then: ref("yes", "structuredContent"), else: { kind: "object", fields: { text: { kind: "literal", value: "Explicit empty path" }, complete: { kind: "literal", value: true } } } } });
  gate.merge.then = ref("inner", "value");
  const { state, run, plan } = await fixture(true, value); advanceOperationDecisions(state, run, plan); done(run, "yes", { text: "inner confirmed", complete: true });
  expect(advanceOperationDecisions(state, run, plan)).toMatchObject({ kind: "action", nodeId: "after" });
  expect(run.valueOutputs).toEqual({ inner: { value: { text: "inner confirmed", complete: true } }, gate: { value: { text: "inner confirmed", complete: true } } });
  expect(state.executionEvents.run!.filter(event => event.type === "value.merged").map(event => event.nodeId)).toEqual(["inner", "gate"]);
  expect(operationControlTransition(plan.ir.flow!, run.readProgress!)).toMatchObject({ kind: "action", nodeId: "after" });
});
