import type { Execution, RepositoryState } from "../repository/store.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { resolveReadBinding, type CompiledOperationPlan } from "../workflows/compiled-read.js";
import { structuralNodes, readFlowOutcomes, type ReadSequence } from "../workflows/read-control-flow.js";
import { appendExecutionEvent } from "./read-checkpoints.js";

type ReturnNode = Extract<ReadSequence["nodes"][number], { kind: "return" }>;

/** Pure value preparation. Original AND public output must satisfy the exact
 * contract; missing data and secret removal never become an implicit default. */
export function operationReturnValue(run: Execution, node: ReturnNode): { value: unknown } {
  const value = resolveReadBinding(node.output.value, { input: run.workflowSnapshot!.input, ...run.stepOutputs });
  if (validateToolInput(node.output.schema, value).length) throw new Error("Operation return value violates its contract");
  const safe = withoutSecretFields({ value }) as { value: unknown };
  if (!Object.hasOwn(safe, "value") || validateToolInput(node.output.schema, safe.value).length) throw new Error("Operation return redaction violates its contract");
  return safe;
}

/** Called only at the exact selected boundary within an owned execution
 * transaction. No model/tool/admission/approval entry is available here. */
export function checkpointOperationReturn(state: RepositoryState, run: Execution, node: ReturnNode, index: number): boolean {
  if (run.readProgress!.values?.[node.id] || run.valueOutputs?.[node.id]) throw new Error("Operation return already has evidence");
  let output: { value: unknown } | undefined;
  try { output = operationReturnValue(run, node); } catch { /* Explicit failed receipt, never a substituted answer. */ }
  const timestamp = new Date().toISOString(), status = output ? "DONE" as const : "FAILED" as const;
  (run.readProgress!.values ??= {})[node.id] = { kind: "return", status, stepIndex: index, completedAt: timestamp };
  (state.timelines[run.id] ??= []).push({ id: `value_${node.id}`, nodeId: node.id, label: `Return ${node.id}`, status,
    startedAt: timestamp, completedAt: timestamp, durationMs: 0, sideEffect: false,
    outcome: output ? "WORKFLOW_RETURNED" : "NOT_DISPATCHED", ...(output ? { output } : {}) });
  appendExecutionEvent(state, run, output ? "value.returned" : "value.failed", { kind: "return", stepIndex: index, outcome: "NO_TOOL_DISPATCH" }, node.id);
  if (!output) {
    run.failure = { failureCategory: "OPERATION_RETURN_INVALID", failedStepId: node.id,
      reason: "The selected return has no contract-valid, safely displayable value. No later node was dispatched." };
    return false;
  }
  (run.valueOutputs ??= {})[node.id] = output; run.finalOutput = output.value;
  return true;
}

/** Confirmed structural receipt alone is insufficient: bind the saved public
 * answer to its exact compiled expression, timeline, event and final value. */
export function assertOperationReturnEvidence(state: RepositoryState, run: Execution, plan: CompiledOperationPlan): string | undefined {
  const receipts = Object.entries(run.readProgress?.values ?? {}), outputs = Object.keys(run.valueOutputs ?? {});
  if (!receipts.length) { if (outputs.length) throw new Error("Operation has orphaned typed output"); return undefined; }
  if (receipts.length !== 1 || outputs.length !== 1) throw new Error("Operation must have one selected return only");
  const [id, receipt] = receipts[0]!, node = plan.ir.flow && structuralNodes(plan.ir.flow).find(node => node.kind === "return" && node.id === id);
  if (!node || node.kind !== "return" || receipt.kind !== "return" || receipt.status !== "DONE") throw new Error("Operation return is not confirmed");
  const expected = operationReturnValue(run, node), output = run.valueOutputs?.[id];
  const timeline = state.timelines[run.id]?.filter(entry => entry.nodeId === id);
  if (!output || !canonicalJSONBytes(output).equals(canonicalJSONBytes(expected)) || !Object.hasOwn(run, "finalOutput") ||
      !canonicalJSONBytes(run.finalOutput).equals(canonicalJSONBytes(expected.value)) || timeline?.length !== 1 ||
      timeline[0]!.status !== "DONE" || timeline[0]!.outcome !== "WORKFLOW_RETURNED" || timeline[0]!.completedAt !== receipt.completedAt ||
      !canonicalJSONBytes(timeline[0]!.output).equals(canonicalJSONBytes(expected)) ||
      !state.executionEvents[run.id]?.some(event => event.type === "value.returned" && event.nodeId === id && event.payload?.stepIndex === receipt.stepIndex))
    throw new Error("Operation return answer is detached from acknowledged evidence");
  return id;
}

export function assertOperationReturnCompletion(state: RepositoryState, run: Execution, plan: CompiledOperationPlan): string | undefined {
  const returned = assertOperationReturnEvidence(state, run, plan);
  if (plan.ir.schemaVersion !== "workflow-operation-ir/v6" || !plan.ir.flow) return returned;
  const outcomes = readFlowOutcomes(plan.ir.flow, run.readProgress!.decisions ?? {}, run.readProgress!.values ?? {});
  if (outcomes.returned !== returned) throw new Error("Selected return identity is inconsistent");
  for (const [nodeId, reason] of outcomes.skipped) {
    const entry = state.timelines[run.id]?.filter(entry => entry.nodeId === nodeId), attempt = run.readProgress!.attempts[nodeId];
    if (reason.kind === "empty-collection" || !attempt || attempt.status !== "SKIPPED" || run.operationSecret!.intents[nodeId] || run.stepOutputs?.[nodeId] ||
        entry?.length !== 1 || entry[0]!.attemptId !== attempt.id || entry[0]!.status !== "SKIPPED" ||
        (reason.kind === "return" ? entry[0]!.outcome !== "AFTER_RETURN" || entry[0]!.returnId !== reason.returnId :
          entry[0]!.outcome !== "NOT_SELECTED" || entry[0]!.conditionId !== reason.conditionId || entry[0]!.selectedBranch !== reason.selected))
      throw new Error("Skipped operation has no exact structural non-dispatch evidence");
  }
  return returned;
}
