import type { Execution, RepositoryState } from "../repository/store.js";
import { resolveReadBinding, type CompiledOperationPlan } from "../workflows/compiled-read.js";
import { operationControlTransition } from "../workflows/operation-control-flow.js";
import { appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import { assertOperationReturnEvidence, checkpointOperationReturn } from "./operation-return-checkpoints.js";

/** Called only inside the current worker's execution transaction. Selection
 * and skip receipts must be acknowledged before any model/SDK entry. */
export function advanceOperationDecisions(state: RepositoryState, run: Execution, plan: CompiledOperationPlan):
  { kind: "action"; index: number; nodeId: string } | { kind: "complete" } | { kind: "failed" } {
  const progress = run.readProgress!;
  if (!plan.ir.flow || !["workflow-operation-ir/v4", "workflow-operation-ir/v5", "workflow-operation-ir/v6"].includes(plan.ir.schemaVersion) || run.status !== "RUNNING" || run.operationSecret?.state !== "CLAIMED" ||
      run.workflowSnapshot?.operationCompilation?.semanticHash !== plan.semanticHash || progress.cancellation) throw new Error("Operation decision checkpoint is not owned");
  assertCurrentRunController(state, run, run.operationSecret.actorId, run.operationSecret.admittedRole);
  for (let count = 0; count < 512; count++) {
    assertOperationReturnEvidence(state, run, plan);
    const transition = operationControlTransition(plan.ir.flow, progress);
    if (transition.kind === "action" || transition.kind === "complete") return transition;
    const timestamp = new Date().toISOString();
    if (transition.kind === "return") {
      if (!checkpointOperationReturn(state, run, transition.node, transition.index)) return { kind: "failed" };
    } else if (transition.kind === "decision") {
      const { node, index } = transition;
      let predicate: unknown;
      try { predicate = resolveReadBinding(node.predicate, { input: run.workflowSnapshot!.input, ...run.stepOutputs }); } catch { predicate = undefined; }
      const selected = typeof predicate === "boolean" ? predicate ? "then" as const : "else" as const : undefined;
      (progress.decisions ??= {})[node.id] = { status: selected ? "DONE" : "FAILED", ...(selected ? { selected } : {}), evaluatedAt: timestamp, stepIndex: index };
      (state.timelines[run.id] ??= []).push({ id: `control_${node.id}`, nodeId: node.id, label: `If ${node.id}`, status: selected ? "DONE" : "FAILED",
        startedAt: timestamp, completedAt: timestamp, durationMs: 0, sideEffect: false, outcome: selected ? "CONDITION_SELECTED" : "NOT_DISPATCHED",
        ...(selected ? { selectedBranch: selected, output: { selectedBranch: selected === "then" ? "If yes" : "If no" } } : {}) });
      appendExecutionEvent(state, run, selected ? "condition.selected" : "condition.failed", { stepIndex: index, selectedBranch: selected ?? null, outcome: "NO_TOOL_DISPATCH" }, node.id);
      if (!selected) {
        run.failure = { failureCategory: "OPERATION_CONDITION_INVALID", failedStepId: node.id, reason: "The declared decision predicate has no confirmed boolean value. No branch was dispatched." };
        return { kind: "failed" };
      }
    } else {
      const { nodeId, index, conditionId, selected, returnId } = transition;
      if (run.operationSecret.intents[nodeId] || run.stepOutputs?.[nodeId]) throw new Error("Unselected node already has a dispatch or result");
      const attemptId = `${run.id}:${nodeId}`;
      progress.attempts[nodeId] = { id: attemptId, nodeId, stepIndex: index, status: "SKIPPED", startedAt: timestamp, completedAt: timestamp };
      progress.nextStepIndex++;
      const reason = returnId ? { outcome: "AFTER_RETURN", returnId } : { outcome: "NOT_SELECTED", conditionId, selectedBranch: selected };
      (state.timelines[run.id] ??= []).push({ id: `timeline-${nodeId}`, nodeId, attemptId, label: `Skipped ${nodeId}`, status: "SKIPPED",
        ...reason, startedAt: timestamp, completedAt: timestamp, durationMs: 0, sideEffect: false });
      appendExecutionEvent(state, run, "node.skipped", { stepIndex: index, ...reason, outcome: "NOT_DISPATCHED" }, nodeId, attemptId);
    }
  }
  throw new Error("Operation control checkpoint exceeded its declared bounds");
}
