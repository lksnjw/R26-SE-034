import { z } from "zod";
import { createHash } from "node:crypto";
import type { Execution, RepositoryState } from "../repository/store.js";
import type { CompiledOperationPlan } from "../workflows/compiled-read.js";
import { resolveReadBinding } from "../workflows/compiled-read.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { handlerScopeIDs, protectedNodes, type ReadSequence } from "../workflows/read-control-flow.js";
import { protectedFailureOwners, protectedOperationTransition, type ProtectedSkipReason } from "../workflows/operation-protected-control.js";
import { reviewedCapabilityDataClass } from "../registry/capability-admission.js";
import { toolSchema } from "../registry/schemas.js";
import { assertReadErrorContract } from "../tools/read-business-error.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import type { OperationProtectedReceipt, OperationProtectedSelection } from "./operation-state.js";

type Protect = Extract<ReadSequence["nodes"][number], { kind: "protect" }>;
export type ProtectedCheckpointOwner = { leaseId: string; epoch: number };
const index = z.number().int().nonnegative(), id = z.string().min(1).max(256), time = z.string().datetime();
const selectionSchema = z.object({ code: z.literal("ERP_RESOURCE_NOT_FOUND"), failedNodeId: id, failedIndex: index,
  intentKey: id, intentId: id, argumentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), selectedAt: time }).strict();
const receiptSchema = z.object({ profile: z.literal("operation-protected/v1"), startedAt: time, startIndex: index, selection: selectionSchema.optional(),
  completion: z.object({ outcome: z.enum(["SUCCEEDED", "HANDLED_ERROR", "RETURNED", "FAILED"]), index, completedAt: time }).strict().optional() }).strict();
const equal = (left: unknown, right: unknown) => canonicalJSONBytes(left).equals(canonicalJSONBytes(right));

/** Exact v8 worker ownership. Compilation/publication, current capability
 * review and broker validation are independent mandatory boundaries. */
export function assertProtectedCheckpointOwnership(state: RepositoryState, run: Execution, plan: CompiledOperationPlan, owner: ProtectedCheckpointOwner): ReadSequence {
  const job = run.operationSecret, progress = run.readProgress, receipt = run.workflowSnapshot?.operationCompilation;
  if (plan.ir.schemaVersion !== "workflow-operation-ir/v8" || plan.ir.compilerVersion !== "operation-compiler/v8" || !plan.ir.flow ||
      receipt?.schemaVersion !== plan.ir.schemaVersion || receipt.compilerVersion !== plan.ir.compilerVersion || receipt.semanticHash !== plan.semanticHash ||
      run.workflowSnapshot?.contentHash !== plan.sourceHash || receipt.sourceHash !== plan.sourceHash || run.status !== "RUNNING" ||
      job?.state !== "CLAIMED" || !job.lease || job.lease.id !== owner.leaseId || job.lease.expiresAt <= Date.now() ||
      progress?.epoch !== owner.epoch || progress.cancellation || progress.recoveryReason ||
      plan.semanticHash !== `sha256:${createHash("sha256").update(canonicalJSONBytes(plan.ir)).digest("hex")}`)
    throw new Error("Protected checkpoint is not owned by the current compiled worker generation");
  assertCurrentRunController(state, run, job.actorId, job.admittedRole);
  return plan.ir.flow;
}

/** Historical intent evidence plus exact reviewed source. Does not dispatch,
 * authorize a fallback effect or convert this error into successful ERP data. */
function assertFailureProof(state: RepositoryState, run: Execution, plan: CompiledOperationPlan, selection: OperationProtectedSelection): void {
  selectionSchema.parse(selection);
  const job = run.operationSecret!, intent = job.intents[selection.intentKey], attempt = run.readProgress!.attempts[selection.failedNodeId],
    node = plan.ir.root.nodes.find(node => node.id === selection.failedNodeId), failure = intent?.readBusinessFailure;
  const capabilities = node?.kind === "action" && node.effectClass === "read" ? [node.capability] : node?.kind === "agent" ? node.allowedCapabilities : [];
  const capability = capabilities.find(capability => capability.toolId === failure?.toolId && capability.admission && equal(capability.admission, failure.admissionPin));
  const timeline = state.timelines[run.id]?.filter(entry => entry.attemptId === attempt?.id),
    events = state.executionEvents[run.id]?.filter(event => event.type === "node.read_tool_failed" && event.nodeId === selection.failedNodeId);
  if (!node || !intent || intent.id !== selection.intentId || intent.argumentHash !== selection.argumentHash || intent.nodeId !== selection.failedNodeId || intent.state !== "ACKNOWLEDGED" ||
      intent.evidenceMeaning !== "read-tool-error" || !intent.completedAt || !attempt || attempt.nodeId !== selection.failedNodeId ||
      attempt.status !== "FAILED" || attempt.stepIndex !== selection.failedIndex || attempt.completedAt !== intent.completedAt ||
      !failure || Object.keys(failure).length !== 5 || failure.profile !== "reviewed-read-business-failure/v1" || failure.code !== selection.code ||
      !capability?.admission || capability.contractHash !== failure.contractHash || failure.contractHash !== failure.admissionPin.contractHash ||
      (node.kind === "agent" ? intent.dispatchKind !== "agent-tool" : ![undefined, "tool"].includes(intent.dispatchKind)) ||
      Object.hasOwn(run.stepOutputs ?? {}, selection.failedNodeId) || Object.hasOwn(run.reportCoverages ?? {}, selection.failedNodeId) ||
      timeline?.length !== 1 || timeline[0]!.nodeId !== selection.failedNodeId || timeline[0]!.status !== "FAILED" ||
      timeline[0]!.outcome !== "MCP_READ_TOOL_ERROR" || timeline[0]!.completedAt !== intent.completedAt || events?.length !== 1 ||
      events[0]!.attemptId !== attempt.id || events[0]!.payload.intentId !== intent.id || events[0]!.payload.businessErrorCode !== selection.code ||
      Date.parse(selection.selectedAt) < Date.parse(intent.completedAt))
    throw new Error("Protected selection has no exact acknowledged reviewed read failure");
  reviewedCapabilityDataClass(state, capability.admission);
  const definition = toolSchema.parse(state.capabilityRevisions[capability.admission.revisionId]!.definition);
  assertReadErrorContract(definition);
  if (!definition.read_error_contract || definition.read_error_contract.business_error !== selection.code)
    throw new Error("Protected error classification is not in the current exact reviewed contract");
}

/** Handler-local synthesized fault only, never persisted in tool results.
 * Caller validates selection evidence/current authority before resolution. */
export function protectedOperationValueState(run: Execution, root: ReadSequence, nodeId: string): Record<string, unknown> {
  const state: Record<string, unknown> = { input: run.workflowSnapshot!.input, ...run.stepOutputs, ...run.valueOutputs };
  for (const id of handlerScopeIDs(root).get(nodeId) ?? []) {
    const selection = run.operationSecret?.protectedScopes?.[id]?.selection;
    if (!selection) throw new Error("Handler input has no committed selection");
    state[id] = { error: { code: selection.code, failedNodeId: selection.failedNodeId } };
  }
  return state;
}

function protectedOutput(run: Execution, root: ReadSequence, node: Protect, receipt: OperationProtectedReceipt): { value: unknown } {
  const state = protectedOperationValueState(run, root, node.id);
  // The group's handled mapping has its own handler-local fault, while its
  // success mapping cannot see that fault or a previously completed value.
  delete state[node.id];
  if (receipt.selection) state[node.id] = { error: { code: receipt.selection.code, failedNodeId: receipt.selection.failedNodeId } };
  const value = resolveReadBinding(receipt.selection ? node.output.handled : node.output.success, state);
  if (validateToolInput(node.output.schema, value).length) throw new Error("Protected output violates its declared contract");
  const safe = withoutSecretFields({ value }) as { value: unknown };
  if (!Object.hasOwn(safe, "value") || validateToolInput(node.output.schema, safe.value).length) throw new Error("Protected output redaction violates its contract");
  return safe;
}

export function assertProtectedOperationEvidence(state: RepositoryState, run: Execution, plan: CompiledOperationPlan): void {
  if (!plan.ir.flow) throw new Error("Protected evidence has no compiled structure");
  const groups = new Map(protectedNodes(plan.ir.flow).map(node => [node.id, node])), values = run.readProgress!.values ?? {};
  for (const [id, raw] of Object.entries(run.operationSecret!.protectedScopes ?? {})) {
    receiptSchema.parse(raw);
    const receipt = raw, node = groups.get(id);
    if (!node) throw new Error("Protected receipt has no exact compiled owner");
    const started = state.executionEvents[run.id]?.filter(event => event.type === "protected.started" && event.nodeId === id);
    if (started?.length !== 1 || started[0]!.payload.stepIndex !== receipt.startIndex || started[0]!.payload.startedAt !== receipt.startedAt)
      throw new Error("Protected entry has no exact event");
    if (receipt.selection) {
      assertFailureProof(state, run, plan, receipt.selection);
      if (protectedFailureOwners(plan.ir.flow, receipt.selection.failedNodeId)[0] !== id || node.onError.code !== receipt.selection.code ||
          Date.parse(receipt.selection.selectedAt) < Date.parse(receipt.startedAt))
        throw new Error("Protected failure is outside the selected body");
      const selected = state.executionEvents[run.id]?.filter(event => event.type === "protected.handler_selected" && event.nodeId === id);
      if (selected?.length !== 1 || selected[0]!.payload.failedNodeId !== receipt.selection.failedNodeId ||
          selected[0]!.payload.intentId !== receipt.selection.intentId || selected[0]!.payload.selectedAt !== receipt.selection.selectedAt ||
          selected[0]!.payload.businessErrorCode !== receipt.selection.code || selected[0]!.payload.stepIndex !== receipt.selection.failedIndex)
        throw new Error("Protected selection has no exact committed event");
    }
    if (!receipt.completion) { if (values[id] || run.valueOutputs?.[id]) throw new Error("Incomplete protected group has a fabricated answer"); continue; }
    const completed = state.executionEvents[run.id]?.filter(event => event.type === "protected.completed" && event.nodeId === id),
      timeline = state.timelines[run.id]?.filter(entry => entry.id === `protected_${id}`);
    if (completed?.length !== 1 || completed[0]!.payload.outcome !== receipt.completion.outcome ||
        completed[0]!.payload.stepIndex !== receipt.completion.index || completed[0]!.payload.completedAt !== receipt.completion.completedAt ||
        timeline?.length !== 1 || timeline[0]!.nodeId !== id || timeline[0]!.outcome !== receipt.completion.outcome ||
        timeline[0]!.startedAt !== receipt.startedAt || timeline[0]!.completedAt !== receipt.completion.completedAt ||
        Date.parse(receipt.completion.completedAt) < Date.parse(receipt.selection?.selectedAt ?? receipt.startedAt) ||
        timeline[0]!.status !== (receipt.completion.outcome === "FAILED" ? "FAILED" : "DONE") || timeline[0]!.sideEffect !== false)
      throw new Error("Protected completion has no exact timeline and event");
    if (["SUCCEEDED", "HANDLED_ERROR"].includes(receipt.completion.outcome)) {
      const expected = protectedOutput(run, plan.ir.flow, node, receipt), value = values[id];
      if ((receipt.completion.outcome === "HANDLED_ERROR") !== Boolean(receipt.selection) || value?.kind !== "protect" || value.status !== "DONE" ||
          value.stepIndex !== receipt.completion.index || value.completedAt !== receipt.completion.completedAt || timeline[0]!.status !== "DONE" ||
          !equal(run.valueOutputs?.[id], expected) || !equal(timeline[0]!.output, expected)) throw new Error("Protected answer is detached from its exact mapping");
    } else if (values[id] || Object.hasOwn(run.valueOutputs ?? {}, id) || Object.hasOwn(timeline[0]!, "output")) throw new Error("Terminated protected group has a fabricated final answer");
  }
  for (const [id, receipt] of Object.entries(values)) if (receipt.kind === "protect" && !run.operationSecret!.protectedScopes?.[id]?.completion)
    throw new Error("Orphaned protected value receipt");
  for (const event of state.executionEvents[run.id] ?? []) {
    const receipt = event.nodeId && run.operationSecret!.protectedScopes?.[event.nodeId];
    if ((event.type === "protected.started" && !receipt) || (event.type === "protected.handler_selected" && (!receipt || !receipt.selection)) ||
        (event.type === "protected.completed" && (!receipt || !receipt.completion))) throw new Error("Orphaned protected event");
  }
}

/** Verifies exact saved non-dispatch evidence as well as structural receipts.
 * This is the required read-only boundary before v8 worker advancement. */
export function confirmedProtectedOperationTransition(state: RepositoryState, run: Execution, plan: CompiledOperationPlan) {
  assertProtectedOperationEvidence(state, run, plan);
  const skipped = new Map<string, { index: number; reason: ProtectedSkipReason }>(),
    next = protectedOperationTransition(plan.ir.flow!, run.readProgress!, run.operationSecret!.protectedScopes ?? {}, skipped);
  for (const [nodeId, { index, reason }] of skipped) {
    const attempt = run.readProgress!.attempts[nodeId]!, entries = state.timelines[run.id]?.filter(entry => entry.attemptId === attempt.id),
      events = state.executionEvents[run.id]?.filter(event => event.type === "node.skipped" && event.nodeId === nodeId);
    const expected = "returnId" in reason ? { outcome: "AFTER_RETURN", returnId: reason.returnId } : "conditionId" in reason ?
      { outcome: "NOT_SELECTED", conditionId: reason.conditionId, selectedBranch: reason.selected } : reason;
    if (Object.values(run.operationSecret!.intents).some(intent => intent.nodeId === nodeId) || Object.hasOwn(run.stepOutputs ?? {}, nodeId) ||
        entries?.length !== 1 || entries[0]!.nodeId !== nodeId || entries[0]!.status !== "SKIPPED" ||
        entries[0]!.startedAt !== attempt.startedAt || entries[0]!.completedAt !== attempt.completedAt || entries[0]!.sideEffect !== false ||
        Object.entries(expected).some(([key, value]) => entries[0]![key] !== value) || events?.length !== 1 || events[0]!.attemptId !== attempt.id ||
        events[0]!.payload.stepIndex !== index || events[0]!.payload.outcome !== "NOT_DISPATCHED" ||
        Object.entries(expected).some(([key, value]) => key !== "outcome" && events[0]!.payload[key] !== value))
      throw new Error("Skipped protected action has no exact non-dispatch evidence");
  }
  return next;
}

export function checkpointProtectedStart(state: RepositoryState, run: Execution, plan: CompiledOperationPlan, owner: ProtectedCheckpointOwner): void {
  assertProtectedCheckpointOwnership(state, run, plan, owner);
  const next = confirmedProtectedOperationTransition(state, run, plan);
  if (next.kind !== "protected-start") throw new Error("Protected entry is not the next exact boundary");
  const startedAt = new Date().toISOString();
  (run.operationSecret!.protectedScopes ??= {})[next.node.id] = { profile: "operation-protected/v1", startedAt, startIndex: next.index };
  appendExecutionEvent(state, run, "protected.started", { stepIndex: next.index, startedAt, outcome: "NO_TOOL_DISPATCH" }, next.node.id);
}

/** Called AFTER the failed intent/attempt/timeline/event have been recorded,
 * in that same owned transaction. Dependent dispatch must await COMMIT ack. */
export function prepareProtectedSelection(state: RepositoryState, run: Execution, plan: CompiledOperationPlan, owner: ProtectedCheckpointOwner,
  failedNodeId: string, intentKey: string): { id: string; selection: OperationProtectedSelection } | undefined {
  const root = assertProtectedCheckpointOwnership(state, run, plan, owner), scopes = run.operationSecret!.protectedScopes ?? {};
  assertProtectedOperationEvidence(state, run, plan);
  if (Object.values(run.operationSecret!.intents).some(value => value.state === "UNKNOWN" || value.state === "DISPATCH_INTENT"))
    throw new Error("Protected selection cannot pass an unresolved dispatch");
  const attempt = run.readProgress!.attempts[failedNodeId], intent = run.operationSecret!.intents[intentKey];
  if (!attempt || !intent) throw new Error("Protected selection has no failed attempt/intent");
  const selectedAt = new Date().toISOString(), selection: OperationProtectedSelection = { code: "ERP_RESOURCE_NOT_FOUND", failedNodeId,
    failedIndex: attempt.stepIndex, intentKey, intentId: intent.id, argumentHash: intent.argumentHash, selectedAt };
  assertFailureProof(state, run, plan, selection);
  // Check the dispatch boundary before this acknowledged failure. This cannot
  // authorize a preemptive failure or select an unvisited/sibling handler.
  const previous = structuredClone(run.readProgress!);
  previous.attempts[failedNodeId]!.status = "DISPATCH_INTENT";
  const boundary = protectedOperationTransition(root, previous, scopes);
  if (boundary.kind !== "action" || boundary.nodeId !== failedNodeId || boundary.index !== attempt.stepIndex)
    throw new Error("Protected failure is not at the current exact selected action");
  const id = protectedFailureOwners(root, failedNodeId)[0];
  if (!id) return undefined;
  const receipt = scopes[id];
  if (!receipt || receipt.selection || receipt.completion) throw new Error("Protected handler is not eligible for a fresh selection");
  if ((state.executionEvents[run.id]?.at(-1)?.sequence ?? 0) !== run.readProgress!.lastSequence)
    throw new Error("Protected selection event sequence is inconsistent");
  return { id, selection };
}

export function checkpointProtectedSelection(state: RepositoryState, run: Execution, plan: CompiledOperationPlan, owner: ProtectedCheckpointOwner,
  failedNodeId: string, intentKey: string): string | undefined {
  const prepared = prepareProtectedSelection(state, run, plan, owner, failedNodeId, intentKey);
  if (!prepared) return undefined;
  const { id, selection } = prepared, receipt = run.operationSecret!.protectedScopes![id]!, attempt = run.readProgress!.attempts[failedNodeId]!;
  receipt.selection = selection;
  run.readProgress!.nextStepIndex++;
  appendExecutionEvent(state, run, "protected.handler_selected", { businessErrorCode: selection.code, failedNodeId, intentId: selection.intentId,
    selectedAt: selection.selectedAt, stepIndex: attempt.stepIndex, outcome: "HANDLER_SELECTED_NOT_COMPLETED" }, id, attempt.id);
  return id;
}

export function checkpointProtectedCompletion(state: RepositoryState, run: Execution, plan: CompiledOperationPlan, owner: ProtectedCheckpointOwner): boolean {
  const root = assertProtectedCheckpointOwnership(state, run, plan, owner);
  const scopes = run.operationSecret!.protectedScopes ?? {}, next = confirmedProtectedOperationTransition(state, run, plan);
  if (next.kind !== "protected-complete") throw new Error("Protected completion is not the next exact boundary");
  const receipt = scopes[next.node.id]!, completedAt = new Date().toISOString();
  let output: { value: unknown } | undefined;
  if (next.outcome === "SUCCEEDED" || next.outcome === "HANDLED_ERROR") {
    try { output = protectedOutput(run, root, next.node, receipt); } catch {
      run.failure = { failureCategory: "OPERATION_PROTECTED_OUTPUT_INVALID", failedStepId: next.node.id,
        reason: "The selected protected path has no contract-valid safely displayable final value. No dependent action was dispatched." };
      // Do not lie about a source/handler failure to the structural traversal.
      // Worker must finish FAILED with this separate output-validation receipt.
      (run.readProgress!.values ??= {})[next.node.id] = { kind: "protect", status: "FAILED", stepIndex: next.index, completedAt };
      appendExecutionEvent(state, run, "protected.output_failed", { stepIndex: next.index, outcome: "NOT_DISPATCHED" }, next.node.id);
      return false;
    }
  }
  receipt.completion = { outcome: next.outcome, index: next.index, completedAt };
  if (output) {
    (run.valueOutputs ??= {})[next.node.id] = output;
    (run.readProgress!.values ??= {})[next.node.id] = { kind: "protect", status: "DONE", stepIndex: next.index, completedAt };
  }
  (state.timelines[run.id] ??= []).push({ id: `protected_${next.node.id}`, nodeId: next.node.id, label: `Protected group ${next.node.id}`,
    status: next.outcome === "FAILED" ? "FAILED" : "DONE", outcome: next.outcome, startedAt: receipt.startedAt, completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(receipt.startedAt)), sideEffect: false, ...(output ? { output } : {}) });
  appendExecutionEvent(state, run, "protected.completed", { stepIndex: next.index, completedAt, outcome: next.outcome }, next.node.id);
  return true;
}

/** Exact selected failure -> fresh worker claim, not a failed-call retry. The
 * caller must await this transaction's acknowledgement before queue pumping. */
export function queueProtectedHandler(state: RepositoryState, run: Execution, plan: CompiledOperationPlan, owner: ProtectedCheckpointOwner, protectedId: string): void {
  assertProtectedCheckpointOwnership(state, run, plan, owner);
  const receipt = run.operationSecret!.protectedScopes?.[protectedId];
  if (!receipt?.selection || receipt.completion || run.readProgress!.nextStepIndex !== receipt.selection.failedIndex + 1 ||
      Object.values(run.operationSecret!.intents).some(intent => intent.state !== "ACKNOWLEDGED")) throw new Error("Protected handler has no exact settled fresh selection");
  confirmedProtectedOperationTransition(state, run, plan);
  delete run.failure;
  run.readProgress!.epoch++;
  run.status = "PENDING"; run.operationSecret!.state = "QUEUED"; delete run.operationSecret!.lease;
  run.agentSummary = "The failed ERP read is recorded. Its explicitly selected handler is queued; the failed read will not be retried.";
  appendExecutionEvent(state, run, "protected.handler_queued", { failedNodeId: receipt.selection.failedNodeId, outcome: "HANDLER_QUEUED_NOT_COMPLETED" }, protectedId);
}
