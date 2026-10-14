import type { Execution, RepositoryState } from "../repository/store.js";
import { appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { effectiveStepKind } from "../models/schemas.js";

/** A refused queue claim must leave the fair queue, not spin forever. This
 * checkpoint grants no dispatch authority and never erases earlier uncertainty. */
export function operationClaimDenial(state: RepositoryState, run: Execution):
  { status: "FAILED" | "CANCELLED" | "RECOVERY_REQUIRED" | "RECONCILIATION_REQUIRED"; summary: string } | undefined {
  const job = run.operationSecret!, progress = run.readProgress!;
  const unsettled = Object.values(job.intents).filter(intent => intent.state !== "ACKNOWLEDGED");
  const uncertain = Object.values(progress.attempts).filter(attempt => attempt.status === "DISPATCH_INTENT" || attempt.status === "UNKNOWN");
  if (unsettled.length || uncertain.length) {
    for (const intent of unsettled) intent.state = "UNKNOWN";
    for (const attempt of uncertain) {
      if (attempt.status === "UNKNOWN") continue;
      attempt.status = "UNKNOWN"; attempt.completedAt = new Date().toISOString();
      const entry = state.timelines[run.id]?.find(item => item.attemptId === attempt.id);
      if (entry) Object.assign(entry, { status: "UNKNOWN", outcome: "UNKNOWN", completedAt: attempt.completedAt });
      appendExecutionEvent(state, run, "node.outcome_unknown", { outcome: "UNKNOWN", reason: "QUEUED_OPERATION_HAS_UNCONFIRMED_CALL" }, attempt.nodeId, attempt.id);
    }
    const relevant = Object.values(job.intents).filter(intent => unsettled.includes(intent) || uncertain.some(attempt => attempt.nodeId === intent.nodeId));
    let historicalAnalysis = false;
    if (job.analysisProvider) {
      try {
        const source = parseWorkflowYAMLStrict(run.workflowSnapshot!.yaml), ids = new Set([...unsettled.map(intent => intent.nodeId), ...uncertain.map(attempt => attempt.nodeId)]);
        historicalAnalysis = source.steps.some(step => ids.has(step.id) && effectiveStepKind(step) === "analysis");
      } catch { historicalAnalysis = true; }
    }
    const modelOrAgent = historicalAnalysis || relevant.some(intent => intent.dispatchKind === "analysis" || intent.dispatchKind === "agent-model" || intent.dispatchKind === "agent-tool") ||
      uncertain.some(attempt => !relevant.some(intent => intent.nodeId === attempt.nodeId));
    run.failure ??= { failureCategory: "OPERATION_QUEUED_OUTCOME_UNCONFIRMED", failedStepId: unsettled[0]?.nodeId ?? uncertain[0]?.nodeId };
    return { status: modelOrAgent ? "RECOVERY_REQUIRED" : "RECONCILIATION_REQUIRED",
      summary: "An earlier saved call has no acknowledged outcome. This queue claim entered no new tool or model call; the earlier call was not replayed and still requires recovery or reconciliation." };
  }
  if (progress.cancellation) return { status: "CANCELLED", summary: "Cancelled before the queued worker entered a new call. Previous acknowledged results remain saved." };
  try {
    assertCurrentRunController(state, run, job.actorId, job.admittedRole);
    if (state.users[job.actorId]?.roleId !== job.roleId) throw new Error("Admitted role identity changed");
  } catch {
    run.failure = { failureCategory: "OPERATION_CLAIM_AUTHORITY_CHANGED", failedStepId: "preflight" };
    return { status: "FAILED", summary: "The queued execution stopped because its current user, role, run permission or workflow access changed. No new tool or model call was entered; previous acknowledged results remain saved." };
  }
  return undefined;
}
