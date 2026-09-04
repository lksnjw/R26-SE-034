import type { HandlerServices } from "../http/handlers/common.js";
import type { Execution } from "../repository/store.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import { executeReadWorkflow } from "./read-workflow.js";
import { ReadCheckpoints, ReadCheckpointFailure, ReadRunCancelled, reconcileInterruptedExecutions, type ReadExecutionHooks } from "./read-checkpoints.js";
import type { CompiledReadPlan } from "../workflows/compiled-read.js";

/** Shared synchronous/queued runner. Completion requires committed node
 * evidence; uncertain persistence never authorizes replay or another call. */
export async function completeCheckpointedRead(services: HandlerServices, initial: Execution, input: Record<string, unknown>, token: ValidationToken, signal?: AbortSignal, assertDispatchBinding?: () => void, compiledPlan?: CompiledReadPlan): Promise<Execution> {
  const executionId = initial.id, yaml = initial.workflowSnapshot!.yaml;
  const checkpoints = new ReadCheckpoints(services.repository, executionId, initial.readProgress!.epoch, yaml, signal, initial.workflowSnapshot?.compilation?.semanticHash, compiledPlan);
  const hooks: ReadExecutionHooks = {
    preparing: checkpoints.preparing.bind(checkpoints), completed: checkpoints.completed.bind(checkpoints), failed: checkpoints.failed.bind(checkpoints),
    condition: checkpoints.condition.bind(checkpoints), skipped: checkpoints.skipped.bind(checkpoints),
    value: checkpoints.value.bind(checkpoints), terminated: checkpoints.terminated.bind(checkpoints),
    dispatchIntent: async (index, nodeId, role) => { assertDispatchBinding?.(); await checkpoints.dispatchIntent(index, nodeId, role); },
  };
  let failed = false;
  try { await executeReadWorkflow(services, initial.startedBy.id, yaml, input, token, { traceId: initial.traceId, sessionId: initial.chatSessionId, workflowId: initial.workflowId, executionId, signal }, hooks, compiledPlan); }
  catch (error) {
    if (error instanceof ReadCheckpointFailure) { await checkpointFailure(); throw error; }
    failed = !(error instanceof ReadRunCancelled);
  }
  try { return await checkpoints.finish(failed); }
  catch (error) { await checkpointFailure(); throw error; }

  async function checkpointFailure(): Promise<void> {
    // Never promote uncommitted in-memory results to DONE, or start another call.
    // Best-effort recovery marking has no dispatch/replay authority.
    try {
      await services.repository.recoverPersistenceState();
      await reconcileInterruptedExecutions(services.repository, "CHECKPOINT_NOT_COMMITTED", executionId, initial.readProgress!.epoch);
    } catch { /* storage remains unavailable and writes stay fenced; startup will reconcile */ }
  }
}
