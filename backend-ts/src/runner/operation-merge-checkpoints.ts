import type { Execution, RepositoryState } from "../repository/store.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { resolveReadBinding, type CompiledOperationPlan } from "../workflows/compiled-read.js";
import { controlNodes, type ReadSequence } from "../workflows/read-control-flow.js";
import { appendExecutionEvent } from "./read-checkpoints.js";
import { protectedOperationValueState } from "./operation-protected-checkpoints.js";

type Condition = Extract<ReadSequence["nodes"][number], { kind: "if" }>;
/** Exact committed public sources only. Structural values do not become tool
 * results, and this resolver carries no dispatch/publication authority. */
export function operationValueState(run: Execution, root?: ReadSequence, nodeId?: string): Record<string, unknown> {
  if (root && nodeId) return protectedOperationValueState(run, root, nodeId);
  return { input: run.workflowSnapshot!.input, ...run.stepOutputs, ...run.valueOutputs };
}
export function operationMergeValue(run: Execution, node: Condition, root?: ReadSequence): { value: unknown } {
  const decision = run.readProgress?.decisions?.[node.id];
  if (!node.merge || decision?.status !== "DONE" || !["then", "else"].includes(decision.selected ?? "")) throw new Error("Merge selection is not confirmed");
  const value = resolveReadBinding(node.merge[decision.selected!], operationValueState(run, root, node.id));
  if (validateToolInput(node.merge.schema, value).length) throw new Error("Operation merge value violates its contract");
  const safe = withoutSecretFields({ value }) as { value: unknown };
  if (!Object.hasOwn(safe, "value") || validateToolInput(node.merge.schema, safe.value).length) throw new Error("Operation merge redaction violates its contract");
  return safe;
}
/** Only called at the selected boundary in the owned worker transaction.
 * Schema/redaction failure commits a real failure, never a fallback or call. */
export function checkpointOperationMerge(state: RepositoryState, run: Execution, node: Condition, index: number, root?: ReadSequence): boolean {
  if (run.readProgress!.values?.[node.id] || run.valueOutputs?.[node.id]) throw new Error("Operation merge already has evidence");
  let output: { value: unknown } | undefined;
  try { output = operationMergeValue(run, node, root); } catch { /* No implicit answer. */ }
  const timestamp = new Date().toISOString(), status = output ? "DONE" as const : "FAILED" as const;
  (run.readProgress!.values ??= {})[node.id] = { kind: "merge", status, stepIndex: index, completedAt: timestamp };
  (state.timelines[run.id] ??= []).push({ id: `value_${node.id}`, nodeId: node.id, label: `Branch output ${node.id}`, status,
    startedAt: timestamp, completedAt: timestamp, durationMs: 0, sideEffect: false,
    outcome: output ? "BRANCH_OUTPUT_CONFIRMED" : "NOT_DISPATCHED", ...(output ? { output } : {}) });
  appendExecutionEvent(state, run, output ? "value.merged" : "value.failed", { kind: "merge", stepIndex: index, outcome: "NO_TOOL_DISPATCH" }, node.id);
  if (!output) {
    run.failure = { failureCategory: "OPERATION_MERGE_INVALID", failedStepId: node.id,
      reason: "The selected branch has no contract-valid, safely displayable output. No dependent node was dispatched." };
    return false;
  }
  (run.valueOutputs ??= {})[node.id] = output;
  return true;
}
/** Saved public values must be attached to exact compiled mappings and
 * acknowledged receipts/timeline/events. Pointer/path checks remain separate. */
export function assertOperationMergeEvidence(state: RepositoryState, run: Execution, plan: CompiledOperationPlan): void {
  const values = run.readProgress?.values ?? {};
  if (Object.keys(run.valueOutputs ?? {}).some(id => !values[id])) throw new Error("Operation has orphaned typed output");
  const nodes = new Map(plan.ir.flow ? controlNodes(plan.ir.flow).filter(node => node.merge).map(node => [node.id, node]) : []);
  for (const [id, receipt] of Object.entries(values)) {
    if (receipt.kind === "protect" && plan.ir.schemaVersion !== "workflow-operation-ir/v8") throw new Error("Legacy operation cannot acquire protected values");
    if (receipt.kind !== "merge") continue;
    const node = nodes.get(id), output = run.valueOutputs?.[id];
    if (!node || receipt.status !== "DONE" || !output) throw new Error("Operation merge is not confirmed");
    const expected = operationMergeValue(run, node, plan.ir.flow), timeline = state.timelines[run.id]?.filter(entry => entry.id === `value_${id}`),
      events = state.executionEvents[run.id]?.filter(event => event.type === "value.merged" && event.nodeId === id);
    if (!canonicalJSONBytes(output).equals(canonicalJSONBytes(expected)) || timeline?.length !== 1 || timeline[0]!.nodeId !== id ||
        timeline[0]!.status !== "DONE" || timeline[0]!.outcome !== "BRANCH_OUTPUT_CONFIRMED" || timeline[0]!.completedAt !== receipt.completedAt ||
        !canonicalJSONBytes(timeline[0]!.output).equals(canonicalJSONBytes(expected)) || events?.length !== 1 ||
        events[0]!.payload?.kind !== "merge" || events[0]!.payload?.stepIndex !== receipt.stepIndex)
      throw new Error("Operation branch output is detached from acknowledged evidence");
  }
}
