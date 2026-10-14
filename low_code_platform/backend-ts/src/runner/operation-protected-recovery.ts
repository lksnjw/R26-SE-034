import { createHash } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { Execution, RepositoryState } from "../repository/store.js";
import type { StoredOperationCompilation } from "../workflows/operation-compilation-lifecycle.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { parseReadControlFlow } from "../workflows/read-control-flow.js";
import { reviewedCapabilityDataClass } from "../registry/capability-admission.js";
import { assertModelDataClassification } from "../workflows/model-data-classification.js";
import { appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import { confirmedProtectedOperationTransition } from "./operation-protected-checkpoints.js";
import { assertOperationMergeEvidence } from "./operation-merge-checkpoints.js";
import { assertOperationReturnEvidence } from "./operation-return-checkpoints.js";
import { assertConfirmedOperationResults } from "./operation-result-evidence.js";

const equal = (left: unknown, right: unknown) => canonicalJSONBytes(left).equals(canonicalJSONBytes(right));

/** Recovery is queue authority only, never a dispatch grant. Called inside the
 * current repository writer's transaction after the prior worker is stopped.
 * A new claim must still recompile/discover/authorize every provider and tool.
 * Historical profiles and any uncertain dispatch keep ordinary reconciliation. */
export function requeueConfirmedProtectedCheckpoint(state: RepositoryState, run: Execution, reason: string): boolean {
  const job = run.operationSecret, progress = run.readProgress, snapshot = run.workflowSnapshot;
  if (run.status !== "RUNNING" || job?.profile !== "operation-job/v1" || job.state !== "CLAIMED" || !job.lease ||
      !Number.isFinite(job.lease.expiresAt) || progress?.profile !== "read-progress-v1" || !Number.isSafeInteger(progress.epoch) || progress.epoch < 1 || progress.epoch >= Number.MAX_SAFE_INTEGER ||
      progress.cancellation || progress.recoveryReason || run.failure || !snapshot || snapshot.operationCompilation?.schemaVersion !== "workflow-operation-ir/v8" ||
      snapshot.operationCompilation.compilerVersion !== "operation-compiler/v8" || !Object.keys(job.protectedScopes ?? {}).length ||
      Object.values(job.intents).some(intent => intent.state !== "ACKNOWLEDGED") ||
      Object.values(progress.attempts).some(attempt => !["DONE", "FAILED", "SKIPPED", "PREPARING"].includes(attempt.status))) return false;
  let pendingBoundary: string;
  try {
    assertCurrentRunController(state, run, job.actorId, job.admittedRole);
    if (state.users[job.actorId]?.roleId !== job.roleId) return false;
    const publications = state.versions[run.workflowId]?.filter(version => version.version === snapshot.version && version.artifactState === "PUBLISHED");
    if (publications?.length !== 1 || publications[0]!.yaml !== snapshot.yaml || workflowContentHash(snapshot.yaml) !== snapshot.contentHash) return false;
    const stored = publications[0]!.compiledOperation as StoredOperationCompilation | undefined;
    if (!stored || canonicalJSONBytes(stored).length > 1_200_000 || stored.verifiedRole !== job.admittedRole || !Number.isFinite(Date.parse(stored.compiledAt)) ||
        stored.plan.ir.schemaVersion !== "workflow-operation-ir/v8" || stored.plan.ir.compilerVersion !== "operation-compiler/v8" || !stored.plan.ir.flow ||
        !equal(stored.receipt, snapshot.operationCompilation) || stored.plan.sourceHash !== snapshot.contentHash ||
        stored.plan.semanticHash !== stored.receipt.semanticHash ||
        stored.plan.semanticHash !== `sha256:${createHash("sha256").update(canonicalJSONBytes(stored.plan.ir)).digest("hex")}`) return false;
    const source = parseWorkflowYAMLStrict(snapshot.yaml), flow = parseReadControlFlow(source.metadata?.controlFlow);
    if (flow.schemaVersion !== "read-control-flow/v4" || !equal(flow.root, stored.plan.ir.flow) ||
        source.steps.length !== stored.plan.ir.root.nodes.length || source.steps.some((step, at) => step.id !== stored.plan.ir.root.nodes[at]?.id)) return false;
    // No new model conversation is invented from counters. Existing bounded
    // agents do not persist the complete dialogue needed to resume an ACKed
    // partial round; those remain explicit recovery-required, not replayed.
    for (const node of stored.plan.ir.root.nodes) {
      if (node.kind === "action") {
        if (!node.capability.admission) return false;
        reviewedCapabilityDataClass(state, node.capability.admission);
        if (node.readback) reviewedCapabilityDataClass(state, node.readback.admission);
      } else if (node.kind === "agent") for (const capability of node.allowedCapabilities) reviewedCapabilityDataClass(state, capability.admission);
      if (progress.attempts[node.id]?.status !== "PREPARING") continue;
      const entered = Object.values(job.intents).filter(intent => intent.nodeId === node.id);
      if (node.kind !== "action" && entered.length) return false;
      if (node.kind === "action" && node.effectClass !== "read" && (entered.length ||
          run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId]?.binding.nodeId === node.id)) return false;
    }
    assertModelDataClassification(stored.plan, pin => reviewedCapabilityDataClass(state, pin));
    assertConfirmedOperationResults(state, run, stored.plan);
    assertOperationMergeEvidence(state, run, stored.plan);
    assertOperationReturnEvidence(state, run, stored.plan);
    const next = confirmedProtectedOperationTransition(state, run, stored.plan);
    if ((state.executionEvents[run.id]?.at(-1)?.sequence ?? 0) !== progress.lastSequence) return false;
    pendingBoundary = next.kind;
  } catch { return false; }
  // No failed attempt/intent/output is overwritten, no retry counter is reset,
  // and no SDK/provider callback is available in this function.
  progress.epoch++; delete job.lease;
  run.status = "PENDING"; job.state = "QUEUED";
  run.agentSummary = "The exact confirmed protected-workflow checkpoint is queued for fresh authorization. Failed reads remain recorded; no uncertain tool or model call was replayed.";
  appendExecutionEvent(state, run, "protected.checkpoint_requeued", { stepIndex: progress.nextStepIndex, pendingBoundary, reason,
    outcome: "CHECKPOINT_QUEUED_NOT_EXECUTED" });
  return true;
}
