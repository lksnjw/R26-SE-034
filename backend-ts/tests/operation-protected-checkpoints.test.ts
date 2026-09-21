import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { Repository, type Execution } from "../src/repository/store.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { toolSchema } from "../src/registry/schemas.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import type { CompiledOperationPlan, ReadAdmissionPin, ReadBinding } from "../src/workflows/compiled-read.js";
import { resolveReadBinding } from "../src/workflows/compiled-read.js";
import type { CompiledModelInput } from "../src/workflows/model-input.js";
import { actionOrder, type ReadSequence, type ReadControlNode } from "../src/workflows/read-control-flow.js";
import { operationControlTransition } from "../src/workflows/operation-control-flow.js";
import { protectedFailureOwners, protectedOperationTransition } from "../src/workflows/operation-protected-control.js";
import { appendExecutionEvent } from "../src/runner/read-checkpoints.js";
import { checkpointProtectedStart, checkpointProtectedSelection, checkpointProtectedCompletion, confirmedProtectedOperationTransition,
  assertProtectedOperationEvidence, protectedOperationValueState, queueProtectedHandler } from "../src/runner/operation-protected-checkpoints.js";
import { advanceOperationDecisions } from "../src/runner/operation-control-checkpoints.js";
import { assertOperationReturnCompletion } from "../src/runner/operation-return-checkpoints.js";
import { assertModelDataClassification } from "../src/workflows/model-data-classification.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { publicExecution } from "../src/redact/public-model-usage.js";

const role = "Platform Admin", hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
const tool = toolSchema.parse({ tool_id: "employee-read", name: "hr.employee.read", mcp_tool_name: "hr.employee.read", is_read_only: true, risk_level: "low", allowed_roles: [role],
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["admin"],
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  read_error_contract: { profile: "erpbridge-read-error/v1", remote_type: "not_found", business_error: "ERP_RESOURCE_NOT_FOUND" } });
const pin: ReadAdmissionPin = { connectionId: "erp", capabilityId: "cap-read", revisionId: "rev-read", admissionVersion: 1, contractHash: capabilityContractHash(tool) };
const owner = { leaseId: "test-lease", epoch: 1 };
const seq = (...nodes: ReadControlNode[]): ReadSequence => ({ kind: "sequence", nodes });
const action = (nodeId: string): ReadControlNode => ({ kind: "action", nodeId });
const literal = (value: string | boolean): ReadBinding => ({ kind: "literal", value });
const ref = (nodeId: string, ...path: string[]): Extract<ReadBinding, { kind: "ref" }> => ({ kind: "ref", source: "nodeOutput", nodeId, path });
function group(id: string, body = seq(action("lookup"), action("body_tail")), handler = seq(action("fallback"))): Extract<ReadControlNode, { kind: "protect" }> {
  return { kind: "protect", id, body, handler, onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output: { schema: { type: "string" },
    success: literal("Found"), handled: ref(id, "error", "code") } };
}
const flow = () => seq(group("group"), action("after"));
async function fixture(root = flow()) {
  const repository = await Repository.open(null), state = await repository.snapshot(); await repository.close();
  state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: "now" };
  state.workflows.flow = { id: "flow", name: "Flow", description: "", owner: { id: "actor", name: "Actor" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" },
    steps: actionOrder(root).length, successRate: 0, lastRunAt: null, publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: "now", updatedAt: "now", yaml: "fixture", archived: false };
  const plan: CompiledOperationPlan = { ir: { schemaVersion: "workflow-operation-ir/v8", compilerVersion: "operation-compiler/v8", trigger: { kind: "manual" }, flow: root,
    root: { kind: "sequence", nodes: actionOrder(root).map(id => ({ id, kind: "action", effectClass: "read", inputs: { kind: "object", fields: { id: literal(id) } },
      capability: { toolId: tool.tool_id, action: tool.name, remoteName: tool.mcp_tool_name, contractHash: pin.contractHash, admission: pin } })) } }, semanticHash: "", sourceHash: hash("source") };
  plan.semanticHash = hash(plan.ir);
  const now = new Date().toISOString();
  state.capabilityRevisions[pin.revisionId] = { id: pin.revisionId, capabilityId: pin.capabilityId, connectionId: pin.connectionId, connectionBinding: "a".repeat(64), toolId: tool.tool_id,
    contractHash: pin.contractHash, definition: structuredClone(tool), observationId: "observation", reviewedAt: now, reviewedBy: { id: "actor", role }, decisionScope: hash("scope"), decisionHash: hash("decision"),
    policy: { effectClass: "read", riskClass: "low", dataClass: "confidential", retryPolicy: "never", note: "Fixture review, no real ERP call" } };
  state.capabilityAdmissions[pin.capabilityId] = { capabilityId: pin.capabilityId, revisionId: pin.revisionId, state: "AVAILABLE", version: pin.admissionVersion, updatedAt: now };
  const run = { id: "run", workflowId: "flow", status: "RUNNING", startedBy: { id: "actor", name: "Actor" },
    operationSecret: { profile: "operation-job/v1", state: "CLAIMED", actorId: "actor", roleId: "role_admin", admittedRole: role,
      idempotencyScope: "scope", requestFingerprint: hash("request"), createdAt: now, intents: {}, lease: { id: owner.leaseId, workerId: "worker", expiresAt: Date.now() + 600_000 } },
    workflowSnapshot: { input: {}, contentHash: plan.sourceHash, operationCompilation: { schemaVersion: plan.ir.schemaVersion, compilerVersion: plan.ir.compilerVersion,
      semanticHash: plan.semanticHash, sourceHash: plan.sourceHash, registryHash: hash("registry"), origin: "PUBLICATION", admissionMode: "reviewed" } },
    readProgress: { profile: "read-progress-v1", epoch: 1, persistence: "memory-only", nextStepIndex: 0, lastSequence: 0, attempts: {} }, stepOutputs: {} } as unknown as Execution;
  state.executions.run = run; state.timelines.run = [];
  return { state, run, plan };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const next = ({ state, run, plan }: Fixture) => confirmedProtectedOperationTransition(state, run, plan);
const start = ({ state, run, plan }: Fixture) => checkpointProtectedStart(state, run, plan, owner);
const complete = ({ state, run, plan }: Fixture) => checkpointProtectedCompletion(state, run, plan, owner);
const select = ({ state, run, plan }: Fixture, id = "lookup", intentKey = id) => checkpointProtectedSelection(state, run, plan, owner, id, intentKey);
function done({ run }: Fixture, id: string) {
  run.readProgress!.attempts[id] = { id: `attempt-${id}`, nodeId: id, stepIndex: run.readProgress!.nextStepIndex++, status: "DONE", startedAt: new Date().toISOString() };
  run.stepOutputs![id] = { structuredContent: { text: id } };
}
function failed({ state, run }: Fixture, id = "lookup", intentKey = id) {
  const time = new Date().toISOString(), attemptId = `attempt-${id}`;
  run.readProgress!.attempts[id] = { id: attemptId, nodeId: id, stepIndex: run.readProgress!.nextStepIndex, status: "FAILED", startedAt: time, completedAt: time };
  run.operationSecret!.intents[intentKey] = { id: `intent-${id}`, nodeId: id, invocationId: attemptId, operationKey: `${run.id}:${id}`, argumentHash: hash({ id }),
    dispatchKind: "tool", state: "ACKNOWLEDGED", preparedAt: time, completedAt: time, evidenceMeaning: "read-tool-error",
    readBusinessFailure: { profile: "reviewed-read-business-failure/v1", code: "ERP_RESOURCE_NOT_FOUND", toolId: tool.tool_id, contractHash: pin.contractHash, admissionPin: { ...pin } } };
  state.timelines.run!.push({ id: `timeline-${id}`, nodeId: id, attemptId, status: "FAILED", startedAt: time, completedAt: time, outcome: "MCP_READ_TOOL_ERROR" });
  appendExecutionEvent(state, run, "node.read_tool_failed", { intentId: `intent-${id}`, businessErrorCode: "ERP_RESOURCE_NOT_FOUND", outcome: "MCP_READ_TOOL_ERROR" }, id, attemptId);
}
function skip(f: Fixture) {
  const transition = next(f); if (transition.kind !== "skip") throw new Error("Expected a skip");
  const { nodeId, index, reason } = transition, { run, state } = f, time = new Date().toISOString(), attemptId = `attempt-${nodeId}`;
  run.readProgress!.attempts[nodeId] = { id: attemptId, nodeId, stepIndex: index, status: "SKIPPED", startedAt: time, completedAt: time };
  run.readProgress!.nextStepIndex++;
  const fields = "returnId" in reason ? { outcome: "AFTER_RETURN", returnId: reason.returnId } : "conditionId" in reason ?
    { outcome: "NOT_SELECTED", conditionId: reason.conditionId, selectedBranch: reason.selected } : reason;
  state.timelines.run!.push({ id: `timeline-${nodeId}`, nodeId, attemptId, status: "SKIPPED", startedAt: time, completedAt: time, sideEffect: false, ...fields });
  appendExecutionEvent(state, run, "node.skipped", { ...fields, stepIndex: index, outcome: "NOT_DISPATCHED" }, nodeId, attemptId);
}

test("successful body never selects a handler; only the validated final group value escapes", async () => {
  const f = await fixture(); expect(next(f)).toMatchObject({ kind: "protected-start", index: 0 }); start(f);
  done(f, "lookup"); done(f, "body_tail"); expect(next(f)).toMatchObject({ kind: "skip", nodeId: "fallback", reason: { outcome: "BODY_SUCCEEDED" } }); skip(f);
  expect(next(f)).toMatchObject({ kind: "protected-complete", outcome: "SUCCEEDED", index: 3 }); expect(complete(f)).toBe(true);
  expect(f.run.valueOutputs).toEqual({ group: { value: "Found" } }); expect(f.run.operationSecret!.protectedScopes!.group!.selection).toBeUndefined();
  expect(next(f)).toMatchObject({ kind: "action", nodeId: "after" }); done(f, "after"); expect(next(f)).toEqual({ kind: "complete" });
  const saved = structuredClone(f.state); next(f); expect(f.state).toEqual(saved);
});

test("reviewed read error selects a durable handler, aborts remaining body and retains failed lookup evidence", async () => {
  const f = await fixture(); start(f); failed(f); expect(select(f)).toBe("group");
  expect(f.run.readProgress!.nextStepIndex).toBe(1); expect(f.run.stepOutputs!.lookup).toBeUndefined();
  expect(next(f)).toMatchObject({ kind: "skip", nodeId: "body_tail", reason: { protectedId: "group", failedNodeId: "lookup", outcome: "BODY_ABORTED" } }); skip(f);
  expect(next(f)).toMatchObject({ kind: "action", nodeId: "fallback" });
  expect(resolveReadBinding(ref("group", "error", "code"), protectedOperationValueState(f.run, f.plan.ir.flow!, "fallback"))).toBe("ERP_RESOURCE_NOT_FOUND");
  expect(protectedOperationValueState(f.run, f.plan.ir.flow!, "lookup").group).toBeUndefined();
  done(f, "fallback"); expect(complete(f)).toBe(true);
  expect(f.run.valueOutputs).toEqual({ group: { value: "ERP_RESOURCE_NOT_FOUND" } });
  expect(f.run.readProgress!.attempts.lookup!.status).toBe("FAILED"); expect(f.state.timelines.run!.find(entry => entry.nodeId === "group")!.outcome).toBe("HANDLED_ERROR");
  expect(protectedOperationValueState(f.run, f.plan.ir.flow!, "after").group).toEqual({ value: "ERP_RESOURCE_NOT_FOUND" });
  expect(next(f)).toMatchObject({ kind: "action", nodeId: "after" });
});

test("serialized selection survives fresh-object reopen without retrying the failed call", async () => {
  const f = await fixture(); start(f); failed(f); select(f);
  const reopened = JSON.parse(JSON.stringify(f)) as Fixture;
  expect(next(reopened)).toMatchObject({ kind: "skip", nodeId: "body_tail" }); skip(reopened);
  expect(next(reopened)).toMatchObject({ kind: "action", nodeId: "fallback" });
  const before = structuredClone(reopened.state);
  expect(() => select(reopened)).toThrow(); expect(reopened.state).toEqual(before);
  expect(reopened.run.stepOutputs!.lookup).toBeUndefined();
});

test.each(["profile", "code", "pin", "tool", "contract", "intent", "unknown", "in-flight", "attempt", "index", "output", "coverage", "timeline", "event", "extra-proof", "revoked", "changed-review"])(
  "forged or stale %s cannot select a handler or advance the pointer", async damage => {
    const f = await fixture(); start(f); failed(f); const intent = f.run.operationSecret!.intents.lookup!, proof = intent.readBusinessFailure!;
    if (damage === "profile") (proof as any).profile = "public-error/v1";
    if (damage === "code") (proof as any).code = "PERMISSION_DENIED";
    if (damage === "pin") proof.admissionPin.admissionVersion++;
    if (damage === "tool") proof.toolId = "other-tool";
    if (damage === "contract") proof.contractHash = hash("different");
    if (damage === "intent") intent.evidenceMeaning = "operation-accepted";
    if (damage === "unknown") intent.state = "UNKNOWN";
    if (damage === "in-flight") f.run.operationSecret!.intents.other = { ...intent, id: "other", nodeId: "other", state: "DISPATCH_INTENT" };
    if (damage === "attempt") f.run.readProgress!.attempts.lookup!.status = "UNKNOWN";
    if (damage === "index") f.run.readProgress!.attempts.lookup!.stepIndex++;
    if (damage === "output") f.run.stepOutputs!.lookup = { structuredContent: { text: "fake absence" } };
    if (damage === "coverage") (f.run.reportCoverages ??= {}).lookup = {} as any;
    if (damage === "timeline") f.state.timelines.run![0]!.outcome = "OPERATION_ACCEPTED";
    if (damage === "event") f.state.executionEvents.run!.find(event => event.type === "node.read_tool_failed")!.payload.intentId = "different";
    if (damage === "extra-proof") (proof as any).retry = true;
    if (damage === "revoked") f.state.capabilityAdmissions[pin.capabilityId]!.state = "DISABLED";
    if (damage === "changed-review") (f.state.capabilityRevisions[pin.revisionId]!.definition as any).read_error_contract = undefined;
    const before = structuredClone(f.state); expect(() => select(f)).toThrow(); expect(f.state).toEqual(before);
  });

test.each(["lease", "expiry", "epoch", "role", "actor", "cancellation", "semantic", "source", "old-version"])("stale %s cannot enter a protected group", async damage => {
  const f = await fixture();
  if (damage === "lease") f.run.operationSecret!.lease!.id = "another";
  if (damage === "expiry") f.run.operationSecret!.lease!.expiresAt = Date.now() - 1;
  if (damage === "epoch") f.run.readProgress!.epoch++;
  if (damage === "role") f.run.operationSecret!.admittedRole = "HR Manager";
  if (damage === "actor") f.state.users.actor!.status = "Disabled";
  if (damage === "cancellation") f.run.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: f.run.startedBy };
  if (damage === "semantic") f.plan.semanticHash = hash("changed");
  if (damage === "source") f.run.workflowSnapshot!.contentHash = hash("other-source");
  if (damage === "old-version") f.plan.ir.schemaVersion = "workflow-operation-ir/v7";
  const before = structuredClone(f.state); expect(() => start(f)).toThrow(); expect(f.state).toEqual(before);
});

test.each(["pointer", "orphan-scope", "orphan-value", "orphan-decision", "preemptive-handler", "body-skipped", "handler-dispatched"])("forged %s cannot authorize a selected action", async damage => {
  const f = await fixture(); start(f);
  if (damage === "pointer") f.run.readProgress!.nextStepIndex = 3;
  if (damage === "orphan-scope") f.run.operationSecret!.protectedScopes!.phantom = { ...f.run.operationSecret!.protectedScopes!.group! };
  if (damage === "orphan-value") f.run.readProgress!.values = { phantom: { kind: "protect", status: "DONE", stepIndex: 0, completedAt: new Date().toISOString() } };
  if (damage === "orphan-decision") f.run.readProgress!.decisions = { phantom: { status: "DONE", selected: "then", stepIndex: 0, evaluatedAt: new Date().toISOString() } };
  if (damage === "preemptive-handler") f.run.operationSecret!.protectedScopes!.group!.selection = { code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: "lookup", failedIndex: 0, intentId: "fake", intentKey: "lookup", argumentHash: hash("fake"), selectedAt: new Date().toISOString() };
  if (damage === "body-skipped") { done(f, "lookup"); f.run.readProgress!.attempts.lookup!.status = "SKIPPED"; }
  if (damage === "handler-dispatched") { done(f, "fallback"); }
  expect(() => next(f)).toThrow();
});

test("failed handler cannot catch itself; an explicitly authored outer body can handle its reviewed failure", async () => {
  const root = seq(group("outer", seq(group("inner", seq(action("lookup")), seq(action("inner_handler"))), action("outer_tail")), seq(action("outer_handler"))), action("after"));
  const f = await fixture(root); start(f); start(f); failed(f); expect(select(f)).toBe("inner");
  expect(next(f)).toMatchObject({ kind: "action", nodeId: "inner_handler" }); failed(f, "inner_handler"); expect(select(f, "inner_handler")).toBe("outer");
  expect(next(f)).toMatchObject({ kind: "protected-complete", node: { id: "inner" }, outcome: "FAILED" }); complete(f);
  expect(next(f)).toMatchObject({ kind: "skip", nodeId: "outer_tail", reason: { protectedId: "outer", failedNodeId: "inner_handler" } }); skip(f);
  expect(next(f)).toMatchObject({ kind: "action", nodeId: "outer_handler" }); done(f, "outer_handler"); complete(f);
  expect(f.run.operationSecret!.protectedScopes!.inner!.completion!.outcome).toBe("FAILED");
  expect(f.run.operationSecret!.protectedScopes!.outer!.completion!.outcome).toBe("HANDLED_ERROR"); expect(f.run.valueOutputs!.inner).toBeUndefined();
  expect(next(f)).toMatchObject({ kind: "action", nodeId: "after" });
});

test("handler error without an outer protected body remains terminal, never selects itself again", async () => {
  const f = await fixture(); start(f); failed(f); select(f); skip(f); failed(f, "fallback");
  expect(select(f, "fallback")).toBeUndefined(); expect(() => next(f)).toThrow();
  expect(f.run.operationSecret!.protectedScopes!.group!.selection!.failedNodeId).toBe("lookup");
});

test.each(["body", "handler"])("early Return in %s stops the whole workflow without manufacturing a group value", async where => {
  const returned: ReadControlNode = { kind: "return", id: "answer", output: { schema: { type: "string" }, value: literal("stop") } };
  const root = seq(group("group", where === "body" ? seq(returned, action("lookup")) : seq(action("lookup")),
    where === "handler" ? seq(returned, action("fallback")) : seq(action("fallback"))), action("after"));
  const f = await fixture(root); start(f);
  if (where === "handler") { failed(f); select(f); }
  expect(next(f)).toMatchObject({ kind: "return", node: { id: "answer" } });
  f.run.readProgress!.values = { answer: { kind: "return", status: "DONE", stepIndex: f.run.readProgress!.nextStepIndex, completedAt: new Date().toISOString() } };
  while (next(f).kind === "skip") skip(f);
  expect(next(f)).toMatchObject({ kind: "protected-complete", outcome: "RETURNED" }); complete(f);
  skip(f); expect(next(f)).toEqual({ kind: "complete", returned: "answer" }); expect(f.run.valueOutputs?.group).toBeUndefined();
});

test.each(["skip-reason", "skip-intent", "skip-output", "event", "answer", "mapping", "completion-index"])("damaged %s evidence cannot unlock downstream dispatch", async damage => {
  const f = await fixture(); start(f); failed(f); select(f); skip(f); done(f, "fallback"); complete(f);
  if (damage === "skip-reason") f.state.timelines.run!.find(entry => entry.nodeId === "body_tail")!.protectedId = "different";
  if (damage === "skip-intent") f.run.operationSecret!.intents.body_tail = { ...f.run.operationSecret!.intents.lookup!, nodeId: "body_tail" };
  if (damage === "skip-output") f.run.stepOutputs!.body_tail = { text: "fabricated" };
  if (damage === "event") f.state.executionEvents.run!.find(event => event.type === "protected.completed")!.payload.outcome = "SUCCEEDED";
  if (damage === "answer") f.run.valueOutputs!.group!.value = "fake success";
  if (damage === "mapping") (f.plan.ir.flow!.nodes[0] as Extract<ReadControlNode, { kind: "protect" }>).output.handled = literal("another mapping");
  if (damage === "completion-index") f.run.operationSecret!.protectedScopes!.group!.completion!.index++;
  expect(() => next(f)).toThrow();
});

test.each(["missing", "type", "redaction"])("invalid %s typed output fails explicitly, never defaults or runs a dependent node", async damage => {
  const g = group("group");
  g.output.success = damage === "missing" ? ref("lookup", "structuredContent", "missing") : damage === "type" ? literal(true) :
    { kind: "object", fields: { apiKey: literal("hidden") } };
  if (damage === "redaction") g.output.schema = { type: "object", properties: { apiKey: { type: "string" } }, required: ["apiKey"], additionalProperties: false };
  const f = await fixture(seq(g, action("after"))); start(f); done(f, "lookup"); done(f, "body_tail"); skip(f);
  expect(complete(f)).toBe(false); expect(f.run.readProgress!.values!.group!.status).toBe("FAILED"); expect(f.run.valueOutputs?.group).toBeUndefined();
  expect(f.run.failure!.failureCategory).toBe("OPERATION_PROTECTED_OUTPUT_INVALID"); expect(() => next(f)).toThrow();
});

test("failure ownership excludes sibling bodies and the same group's handler", () => {
  const root = seq(group("outer", seq(group("inner", seq(action("a")), seq(action("b")))), seq(action("c"))), group("sibling", seq(action("d")), seq()));
  expect(protectedFailureOwners(root, "a")).toEqual(["inner", "outer"]); expect(protectedFailureOwners(root, "b")).toEqual(["outer"]);
  expect(protectedFailureOwners(root, "c")).toEqual([]); expect(protectedFailureOwners(root, "d")).toEqual(["sibling"]);
});

test("legacy operation traversal still denies protect rather than adopting v8 semantics", async () => {
  const f = await fixture(); expect(() => operationControlTransition(f.plan.ir.flow!, f.run.readProgress!)).toThrow();
  expect(() => assertProtectedOperationEvidence(f.state, f.run, f.plan)).not.toThrow();
  expect(protectedOperationTransition(f.plan.ir.flow!, f.run.readProgress!, {})).toMatchObject({ kind: "protected-start" });
});

test("owned control advancement confirms nested branch/merge and protected value before a downstream Return", async () => {
  const g = group("group", seq(action("lookup")), seq({ kind: "if", id: "handler_choice", predicate: { kind: "literal", value: true }, then: seq(action("yes")), else: seq(action("no")),
    merge: { schema: { type: "string" }, then: ref("group", "error", "code"), else: literal("No fallback") } }));
  g.output.handled = ref("handler_choice", "value");
  const root = seq(g, { kind: "return", id: "answer", output: { schema: { type: "string" }, value: ref("group", "value") } }, action("after")), f = await fixture(root);
  expect(advanceOperationDecisions(f.state, f.run, f.plan, owner)).toMatchObject({ kind: "action", nodeId: "lookup" });
  failed(f); select(f);
  expect(advanceOperationDecisions(f.state, f.run, f.plan, owner)).toMatchObject({ kind: "action", nodeId: "yes" }); done(f, "yes");
  expect(advanceOperationDecisions(f.state, f.run, f.plan, owner)).toMatchObject({ kind: "complete" });
  expect(f.run.readProgress!.attempts.no!.status).toBe("SKIPPED"); expect(f.run.readProgress!.attempts.after!.status).toBe("SKIPPED");
  expect(f.run.finalOutput).toBe("ERP_RESOURCE_NOT_FOUND"); expect(assertOperationReturnCompletion(f.state, f.run, f.plan)).toBe("answer");
  expect(f.run.valueOutputs).toEqual({ handler_choice: { value: "ERP_RESOURCE_NOT_FOUND" }, group: { value: "ERP_RESOURCE_NOT_FOUND" }, answer: { value: "ERP_RESOURCE_NOT_FOUND" } });
});

test("queued handler fences the old worker; a fresh lease observes the same selected path without retry", async () => {
  const f = await fixture(); start(f); failed(f); select(f);
  f.run.failure = { failureCategory: "MCP_READ_TOOL_ERROR", failedStepId: "lookup" };
  queueProtectedHandler(f.state, f.run, f.plan, owner, "group");
  expect(f.run).toMatchObject({ status: "PENDING", operationSecret: { state: "QUEUED" }, readProgress: { epoch: 2 } });
  expect(f.run.operationSecret!.lease).toBeUndefined(); expect(f.run.failure).toBeUndefined();
  expect(() => advanceOperationDecisions(f.state, f.run, f.plan, owner)).toThrow();
  const reopened = JSON.parse(JSON.stringify(f)) as Fixture, fresh = { leaseId: "fresh-lease", epoch: 2 };
  reopened.run.status = "RUNNING"; reopened.run.operationSecret!.state = "CLAIMED";
  reopened.run.operationSecret!.lease = { id: fresh.leaseId, workerId: "new-worker", expiresAt: Date.now() + 60_000 };
  expect(() => advanceOperationDecisions(reopened.state, reopened.run, reopened.plan, owner)).toThrow();
  expect(advanceOperationDecisions(reopened.state, reopened.run, reopened.plan, fresh)).toMatchObject({ kind: "action", nodeId: "fallback" });
  expect(reopened.run.readProgress!.attempts.lookup!.status).toBe("FAILED"); expect(reopened.run.stepOutputs!.lookup).toBeUndefined();
  done(reopened, "fallback"); expect(advanceOperationDecisions(reopened.state, reopened.run, reopened.plan, fresh)).toMatchObject({ kind: "action", nodeId: "after" });
});

test.each(["body", "handler"])("worker advancement honors actual typed Return from %s and never creates a protected final answer", async where => {
  const returned: ReadControlNode = { kind: "return", id: "answer", output: { schema: { type: "string" },
    value: where === "handler" ? ref("group", "error", "failedNodeId") : literal("Early stop") } };
  const root = seq(group("group", where === "body" ? seq(returned, action("lookup")) : seq(action("lookup")),
    where === "handler" ? seq(returned, action("fallback")) : seq(action("fallback"))), action("after")), f = await fixture(root);
  if (where === "handler") { advanceOperationDecisions(f.state, f.run, f.plan, owner); failed(f); select(f); }
  expect(advanceOperationDecisions(f.state, f.run, f.plan, owner)).toMatchObject({ kind: "complete" });
  expect(assertOperationReturnCompletion(f.state, f.run, f.plan)).toBe("answer");
  expect(f.run.valueOutputs?.group).toBeUndefined(); expect(f.run.finalOutput).toBe(where === "handler" ? "lookup" : "Early stop");
  expect(f.run.operationSecret!.protectedScopes!.group!.completion!.outcome).toBe("RETURNED");
});

test.each(["no-owner", "stale-lease", "stale-epoch", "wrong-compiler"])("%s cannot advance v8 control state", async damage => {
  const f = await fixture();
  if (damage === "wrong-compiler") { f.plan.ir.compilerVersion = "operation-compiler/v7"; f.plan.semanticHash = hash(f.plan.ir); f.run.workflowSnapshot!.operationCompilation!.semanticHash = f.plan.semanticHash; }
  const token = damage === "no-owner" ? undefined : damage === "stale-lease" ? { ...owner, leaseId: "old" } : damage === "stale-epoch" ? { ...owner, epoch: 0 } : owner;
  const before = structuredClone(f.state); expect(() => advanceOperationDecisions(f.state, f.run, f.plan, token)).toThrow(); expect(f.state).toEqual(before);
});

test.each(["public-handler-input", "fault-input", "group-output", "literal-final-output"])("%s cannot declassify protected body data for a model", async source => {
  const g = group("group", seq(action("lookup")), seq(action("fallback"))), f = await fixture(seq(action("public_intro"), g, action("after")));
  const intro = f.plan.ir.root.nodes[0]!;
  if (intro.kind !== "action") throw new Error("Expected public source action");
  intro.capability.admission = { ...pin, capabilityId: "cap-public" };
  const reviewedClass = (value: ReadAdmissionPin) => value.capabilityId === "cap-public" ? "public" as const : "confidential" as const;
  const target = source === "public-handler-input" || source === "fault-input" ? "fallback" : "after", position = f.plan.ir.root.nodes.findIndex(node => node.id === target);
  if (source === "literal-final-output") g.output.handled = literal("Public formatting");
  f.plan.ir.root.nodes[position] = { id: target, kind: "analysis", instruction: "Use exact supplied value", input: source === "fault-input" ? ref("group", "error", "code") :
    source === "group-output" || source === "literal-final-output" ? ref("group", "value") : ref("public_intro", "structuredContent", "text"), outputSchema: { type: "string" },
    maxInputItems: 10, maxInputChars: 1000, maxOutputTokens: 100, dataClass: "public", model: "fixture" };
  expect(() => assertModelDataClassification(f.plan, reviewedClass)).toThrow(/at least confidential/);
  (f.plan.ir.root.nodes[position] as Extract<CompiledOperationPlan["ir"]["root"]["nodes"][number], { kind: "analysis" }>).dataClass = "confidential";
  expect(() => assertModelDataClassification(f.plan, reviewedClass)).not.toThrow();
});

test("high handler declaration is retained by later models even when final mappings are literals", async () => {
  const f = await fixture(); const handler = f.plan.ir.root.nodes.findIndex(node => node.id === "fallback"), after = f.plan.ir.root.nodes.findIndex(node => node.id === "after");
  const model = (id: string, input: CompiledModelInput, dataClass: "internal" | "restricted") => ({ id, kind: "analysis" as const, instruction: "Use exact supplied value", input,
    outputSchema: { type: "string" }, maxInputItems: 10, maxInputChars: 1000, maxOutputTokens: 100, dataClass, model: "fixture" });
  f.plan.ir.root.nodes[handler] = model("fallback", ref("group", "error", "code"), "restricted"); f.plan.ir.root.nodes[after] = model("after", ref("group", "value"), "internal");
  expect(() => assertModelDataClassification(f.plan, () => "internal")).toThrow(/at least restricted/);
  f.plan.ir.root.nodes[after] = model("after", ref("group", "value"), "restricted");
  expect(() => assertModelDataClassification(f.plan, () => "internal")).not.toThrow();
});

test("normalized Firestore layout separates private protected receipts and reconstructs the exact handler boundary", async () => {
  const f = await fixture(); start(f); failed(f); select(f);
  const records = splitFirestoreState(f.state), meta = records.find(record => record.path[0] === "executions" && record.path[1] === "run")!.value as Execution;
  expect(meta.operationSecret!.protectedScopes).toEqual({});
  expect(records.find(record => record.path.join("/") === "operation-protected-scopes/run/group")!.value).toEqual(f.run.operationSecret!.protectedScopes!.group);
  const state = assembleFirestoreState(records), restored = { state, run: state.executions.run!, plan: f.plan };
  expect(state).toEqual(f.state); expect(next(restored)).toMatchObject({ kind: "skip", nodeId: "body_tail" });
  skip(restored); expect(next(restored)).toMatchObject({ kind: "action", nodeId: "fallback" });
  expect(publicExecution(restored.run)).not.toHaveProperty("operationSecret");
});

test.each(["orphan", "duplicate", "hidden-inline"])("damaged %s protected record layout fails closed", async damage => {
  const f = await fixture(); start(f); failed(f); select(f); const records = splitFirestoreState(f.state);
  const protectedRecord = records.find(record => record.path[0] === "operation-protected-scopes")!;
  if (damage === "orphan") protectedRecord.path[1] = "different-run";
  if (damage === "duplicate") records.push(structuredClone(protectedRecord));
  if (damage === "hidden-inline") (records.find(record => record.path[0] === "executions")!.value as Execution).operationSecret!.protectedScopes!.hidden = { ...f.run.operationSecret!.protectedScopes!.group! };
  expect(() => assembleFirestoreState(records)).toThrow();
});

test("changed failed-intent argument hash invalidates the saved selection", async () => {
  const f = await fixture(); start(f); failed(f); select(f); f.run.operationSecret!.intents.lookup!.argumentHash = hash("changed");
  expect(() => next(f)).toThrow(); expect(f.run.stepOutputs!.lookup).toBeUndefined();
});
