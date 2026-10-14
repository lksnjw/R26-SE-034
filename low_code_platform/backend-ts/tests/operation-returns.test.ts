import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema } from "../src/registry/schemas.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { compileOperationWorkflow, inspectWorkflowDraft, type ReadAdmissionPin } from "../src/workflows/compiled-read.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { operationControlTransition, assertOperationSelectedNode } from "../src/workflows/operation-control-flow.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { applyWorkflowCommand, workflowCommandSchema } from "../src/workflows/commands.js";
import { simulateModelWorkflow, parseModelFixtures } from "../src/workflows/model-simulation.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { Repository, type Execution } from "../src/repository/store.js";
import { advanceOperationDecisions } from "../src/runner/operation-control-checkpoints.js";
import { assertOperationReturnCompletion, assertOperationReturnEvidence } from "../src/runner/operation-return-checkpoints.js";
import { scheduledReportPaths } from "../src/runner/scheduled-report-paths.js";

const role = "Platform Admin", tool = toolSchema.parse({ tool_id: "read", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role],
  input_schema: { type: "object", properties: {}, additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } } });
const pin: ReadAdmissionPin = { connectionId: "erp", capabilityId: "cap-read", revisionId: "rev-read", admissionVersion: 1, contractHash: capabilityContractHash(tool) };
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes }), action = (nodeId: string) => ({ kind: "action", nodeId });
const ret = (id = "answer", value: any = { kind: "ref", source: "nodeOutput", nodeId: "summary", path: ["structuredContent", "text"] }, schema: any = { type: "string" }) => ({ kind: "return", id, output: { value, schema } });
function source(kind = "analysis", selected = true): any {
  return { name: "Typed model result", description: "Explicit returned answer, not delivery evidence", trigger: { type: "manual" }, steps: [
    { id: "lookup", action: "read", parameters: {} }, { id: "summary", kind, instruction: "Return text", data_class: "internal", input: "{{lookup.structuredContent}}",
      output_schema: { type: "object", properties: { text: { type: "string" }, complete: { type: "boolean" } }, required: ["text", "complete"], additionalProperties: false },
      ...(kind === "agent" ? { allowed_actions: ["read"], completion_predicate: { path: ["complete"], equals: true } } : {}) },
    { id: "tail", action: "read", parameters: {} }, { id: "opposite", action: "read", parameters: {} }, { id: "last", action: "read", parameters: {} },
  ], metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: seq(action("lookup"), { kind: "if", id: "gate", predicate: { kind: "literal", value: selected },
    then: seq(action("summary"), ret(), action("tail")), else: seq(action("opposite")) }, action("last")) } } };
}
const compile = (value = source()) => compileOperationWorkflow(stringify(value), [tool], role, new Map([[tool.tool_id, pin]]));

test.each(["analysis", "agent"])("%s return uses v6, exact source scope and readable authoring hints", kind => {
  const value = source(kind), plan = compile(value), blueprint = parseWorkflowYAMLStrict(stringify(value));
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-operation-ir/v6", compilerVersion: "operation-compiler/v6" });
  expect(inspectWorkflowDraft(blueprint, [tool], role).issues).toEqual([]);
  const hints = readAuthoringContract(blueprint, [tool], role, "registry");
  expect(hints).toMatchObject({ returnNodesSupported: true, modelNodesSupported: true });
  expect(hints.returns![0]!.dataSources.some(source => source.expression === "{{summary.structuredContent.text}}")).toBe(true);
  expect(hints.returns![0]!.dataSources.some(source => source.expression.includes("opposite"))).toBe(false);
  const changed = applyWorkflowCommand(stringify(value), workflowCommandSchema.parse({ type: "updateReturn", nodeId: "answer", patch: { output: { schema: { type: "string" }, value: { kind: "literal", value: "edited answer" } } } }));
  expect(compile(parseWorkflowYAMLStrict(changed)).semanticHash).not.toBe(plan.semanticHash);
});
test.each(["sibling", "forward", "wrong-type", "duplicate", "implicit-schema", "legacy-v1"])("invalid %s return is rejected before publication", damage => {
  const value = source(), node = value.metadata.controlFlow.root.nodes[1].then.nodes[1];
  if (damage === "sibling") node.output.value.nodeId = "opposite";
  if (damage === "forward") node.output.value.nodeId = "tail";
  if (damage === "wrong-type") node.output.schema.type = "integer";
  if (damage === "duplicate") node.id = "lookup";
  if (damage === "implicit-schema") delete node.output.schema;
  if (damage === "legacy-v1") value.metadata.controlFlow.schemaVersion = "read-control-flow/v1";
  expect(() => compile(value)).toThrow();
});

async function checkpointFixture(selected = true, node = ret()) {
  const value = source("analysis", selected); value.metadata.controlFlow.root.nodes[1].then.nodes[1] = node;
  const plan = compile(value), repository = await Repository.open(null), state = await repository.snapshot();
  state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: "now" };
  state.workflows.flow = { id: "flow", name: "Flow", description: "", owner: { id: "actor", name: "Actor" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" }, steps: value.steps.length,
    successRate: 0, lastRunAt: null, publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: "now", updatedAt: "now", yaml: stringify(value), archived: false };
  const run = { id: "run", workflowId: "flow", status: "RUNNING", startedBy: { id: "actor", name: "Actor" },
    operationSecret: { state: "CLAIMED", actorId: "actor", admittedRole: role, intents: {} },
    workflowSnapshot: { input: {}, operationCompilation: { semanticHash: plan.semanticHash } },
    readProgress: { profile: "read-progress-v1", epoch: 1, persistence: "memory-only", nextStepIndex: 1, lastSequence: 0,
      attempts: { lookup: { id: "read-attempt", nodeId: "lookup", stepIndex: 0, status: "DONE", startedAt: "now" } } },
    stepOutputs: { lookup: { structuredContent: { text: "source" } } },
  } as unknown as Execution;
  state.executions.run = run;
  await repository.close();
  return { state, run, plan };
}
function completeSummary(run: Execution) {
  run.readProgress!.attempts.summary = { id: "model-attempt", nodeId: "summary", stepIndex: 1, status: "DONE", startedAt: "now" }; run.readProgress!.nextStepIndex++;
  run.stepOutputs!.summary = { structuredContent: { text: "Actual saved model answer", complete: true } };
}
test("selected return commits exact answer and records post-return versus other-branch skips", async () => {
  const { state, run, plan } = await checkpointFixture();
  expect(advanceOperationDecisions(state, run, plan)).toMatchObject({ kind: "action", nodeId: "summary" }); completeSummary(run);
  expect(advanceOperationDecisions(state, run, plan)).toEqual({ kind: "complete" });
  expect(run.finalOutput).toBe("Actual saved model answer"); expect(run.valueOutputs).toEqual({ answer: { value: "Actual saved model answer" } });
  expect(run.readProgress!.values!.answer).toMatchObject({ kind: "return", status: "DONE", stepIndex: 2 });
  for (const id of ["tail", "last"]) expect(state.timelines.run!.find(entry => entry.nodeId === id)).toMatchObject({ status: "SKIPPED", outcome: "AFTER_RETURN", returnId: "answer" });
  expect(state.timelines.run!.find(entry => entry.nodeId === "opposite")).toMatchObject({ outcome: "NOT_SELECTED", conditionId: "gate" });
  expect(assertOperationReturnCompletion(state, run, plan)).toBe("answer");
  expect(() => assertOperationSelectedNode(plan, run.readProgress!, "last")).toThrow();
  const before = structuredClone(state); expect(advanceOperationDecisions(state, run, plan)).toEqual({ kind: "complete" }); expect(state).toEqual(before);
});
test.each([null, "", false, 0])("explicit literal %j is returned without guessing/defaulting", async value => {
  const schema = { type: value === null ? "null" : typeof value === "number" ? "integer" : typeof value };
  const { state, run, plan } = await checkpointFixture(true, ret("answer", { kind: "literal", value }, schema));
  advanceOperationDecisions(state, run, plan); completeSummary(run); advanceOperationDecisions(state, run, plan);
  expect(run.finalOutput).toBe(value); expect(assertOperationReturnEvidence(state, run, plan)).toBe("answer");
});
test.each(["receipt", "answer", "final", "timeline", "event", "extra-output", "extra-receipt", "skip", "dispatch"])("tampered %s cannot claim returned completion", async damage => {
  const { state, run, plan } = await checkpointFixture(); advanceOperationDecisions(state, run, plan); completeSummary(run); advanceOperationDecisions(state, run, plan);
  if (damage === "receipt") run.readProgress!.values!.answer!.stepIndex++;
  if (damage === "answer") run.valueOutputs!.answer!.value = "invented";
  if (damage === "final") run.finalOutput = "invented";
  if (damage === "timeline") state.timelines.run!.find(entry => entry.nodeId === "answer")!.output = { value: "invented" };
  if (damage === "event") state.executionEvents.run = [];
  if (damage === "extra-output") run.valueOutputs!.phantom = { value: true };
  if (damage === "extra-receipt") run.readProgress!.values!.phantom = { ...run.readProgress!.values!.answer! };
  if (damage === "skip") state.timelines.run!.find(entry => entry.nodeId === "last")!.outcome = "NOT_SELECTED";
  if (damage === "dispatch") run.stepOutputs!.last = { structuredContent: { text: "forged" } };
  expect(() => { operationControlTransition(plan.ir.flow!, run.readProgress!); assertOperationReturnCompletion(state, run, plan); }).toThrow();
});
test("unselected return produces no answer and cannot suppress the continuing path", async () => {
  const { state, run, plan } = await checkpointFixture(false);
  expect(advanceOperationDecisions(state, run, plan)).toMatchObject({ kind: "action", nodeId: "opposite" });
  expect(run.valueOutputs).toBeUndefined(); expect(run.readProgress!.values).toBeUndefined();
  run.readProgress!.attempts.opposite = { id: "opposite", nodeId: "opposite", stepIndex: 3, status: "DONE", startedAt: "now" }; run.readProgress!.nextStepIndex++;
  expect(advanceOperationDecisions(state, run, plan)).toMatchObject({ kind: "action", nodeId: "last" });
  run.readProgress!.values = { answer: { kind: "return", status: "DONE", stepIndex: 2, completedAt: "now" } };
  expect(() => operationControlTransition(plan.ir.flow!, run.readProgress!)).toThrow();
});
test("missing return value fails explicitly without later node eligibility", async () => {
  const { state, run, plan } = await checkpointFixture(); advanceOperationDecisions(state, run, plan); completeSummary(run); delete (run.stepOutputs!.summary as any).structuredContent.text;
  expect(advanceOperationDecisions(state, run, plan)).toEqual({ kind: "failed" });
  expect(run.failure).toMatchObject({ failureCategory: "OPERATION_RETURN_INVALID", failedStepId: "answer" });
  expect(run.valueOutputs).toBeUndefined(); expect(run.readProgress!.attempts.tail).toBeUndefined();
  expect(() => operationControlTransition(plan.ir.flow!, run.readProgress!)).toThrow();
});
test.each([true, false])("model fixture return selected=%s matches real traversal without dispatch", async selected => {
  const yaml = stringify(source("analysis", selected)), fixtures = parseModelFixtures({ profile: "model-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: {
    lookup: { content: [], structuredContent: { text: "source" } }, summary: { structuredContent: { text: "Supplied answer", complete: true } }, opposite: { content: [], structuredContent: { text: "opposite" } }, last: { content: [], structuredContent: { text: "tail" } },
  } });
  const result = await simulateModelWorkflow(yaml, {}, fixtures, [tool], role);
  expect(result.outcome, JSON.stringify(result)).toBe("SIMULATED_COMPLETE"); expect(result.valueOutputs).toEqual(selected ? { answer: { value: "Supplied answer" } } : {});
  if (selected) { expect(result).toMatchObject({ finalOutput: "Supplied answer" }); expect(result.trace.find(entry => entry.nodeId === "last")).toMatchObject({ outcome: "AFTER_RETURN", returnId: "answer" }); }
});
test("calendar admission does not ignore unreachable work or replace complete report coverage with a Return", () => {
  expect(() => scheduledReportPaths(compile(), [tool], { profile: "report-window-input-binding/v1", startAtInput: "start", endAtInput: "end" } as any)).toThrow(/coverage|complete report|Unreachable/);
});
