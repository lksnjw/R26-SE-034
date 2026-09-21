import type { HandlerServices } from "../http/handlers/common.js";
import type { Execution } from "../repository/store.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import type { CompiledReadPlan } from "../workflows/compiled-read.js";
import { acknowledgedReadToolFailure, dispatchReadTool } from "../tools/read-tool-broker.js";
import { ReadCheckpointFailure, ReadRunCancelled, reconcileInterruptedExecutions, assertCurrentRunController } from "./read-checkpoints.js";
import { ReadIterationCheckpoints } from "./read-iteration-checkpoints.js";
import { assertIterationDispatchBinding } from "../workflows/read-iteration-dispatch-binding.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { ReadWorkerLeaseFailure, type ReadWorkerContext } from "./read-worker-lease.js";
import { boundMcpConnection, selectedMcpConnectionId } from "../tools/mcp-dispatch-context.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";

/** Shared server driver for admitted immutable collection controllers.
 * Never accepts client-produced cursors, outputs, permissions or evidence. */
export async function completeCheckpointedCollectionRead(services: HandlerServices, initial: Execution, input: Record<string, unknown>, token: ValidationToken,
  compiledPlan: CompiledReadPlan, bindingKey: string, signal?: AbortSignal, assertDispatchBinding?: () => void, worker?: ReadWorkerContext): Promise<Execution> {
  const captured = structuredClone(initial), plan = structuredClone(compiledPlan), snapshot = captured.workflowSnapshot;
  if (!snapshot || !captured.readProgress || !captured.iterationProgress || snapshot.executionProfile !== "collection-read-v1" || token.registry_hash !== snapshot.registryHash)
    throw new Error("Collection driver requires an admitted immutable run identity");
  const journal = new ReadIterationCheckpoints(services.repository, captured.id, captured.readProgress.epoch, snapshot.yaml, plan, input, services.registries.snapshot().tools, bindingKey, signal);
  const registryHash = services.registries.hash(), pinnedIds = plan.ir.root.nodes.map(node => node.capability.admission?.connectionId).filter((value): value is string => !!value);
  const connectionIds = [...new Set(pinnedIds.length ? pinnedIds : parseWorkflowYAMLStrict(snapshot.yaml).steps.map(step => selectedMcpConnectionId(services, step.connection_id)))];
  const bindings = new Map(connectionIds.map(id => { const bound = boundMcpConnection(services, id); return [id,
    { ...bound, generation: bound.session.discoveryGeneration ?? 0, roleMapHash: canonicalJSONBytes(bound.roleMap) }] as const; }));
  const assertActive = worker?.assertActive.bind(worker), assertWorkerDispatch = worker?.assertDispatch.bind(worker);
  let denied: ReadCheckpointFailure | ReadRunCancelled | undefined;
  const assertBinding = () => {
    assertActive?.(); if (denied) throw denied;
    if (services.registries.hash() !== registryHash) throw new Error("Collection registry changed");
    for (const [connectionId, expected] of bindings) { const current = boundMcpConnection(services, connectionId);
      if (current.session !== expected.session || current.session.available === false || (current.session.discoveryGeneration ?? 0) !== expected.generation ||
          !expected.roleMapHash.equals(canonicalJSONBytes(current.roleMap))) throw new Error("Collection connection context changed"); }
    assertDispatchBinding?.();
  };
  const assertBoundary = (state: Parameters<typeof assertIterationDispatchBinding>[1]) => {
    assertBinding(); assertIterationDispatchBinding(services, state, captured.id, captured.readProgress!.epoch, snapshot.yaml, plan, captured.iterationProgress!.admittedRole);
  };
  const assertObserved = (state: Parameters<typeof assertIterationDispatchBinding>[1]) => {
    assertIterationDispatchBinding(services, state, captured.id, captured.readProgress!.epoch, snapshot.yaml, plan, captured.iterationProgress!.admittedRole);
    assertCurrentRunController(state as Parameters<typeof assertCurrentRunController>[0], state.executions[captured.id]!, captured.startedBy.id, captured.iterationProgress!.admittedRole);
    if (state.executions[captured.id]!.readProgress?.cancellation || signal?.aborted) throw new ReadRunCancelled();
  };
  // SDK entry cannot await a fresh repository read. Acknowledged publication,
  // review, controller or epoch changes synchronously deny the captured run.
  // The normal journal/authorizer still performs its full fresh checks.
  const unobserve = services.repository.observeCommits({ committed: state => {
    if (denied) return;
    try { assertObserved(state); } catch (error) { denied = error instanceof ReadRunCancelled ? error : new ReadCheckpointFailure(error); }
  }, unavailable: () => { denied ??= new ReadCheckpointFailure(new Error("Authoritative collection storage is unavailable")); } });
  let failed = false;
  try {
    await services.repository.readAuthoritative(assertObserved);
    for (let count = 0; count <= 5000; count++) {
      const point = await journal.advance(assertBoundary);
      assertActive?.();
      if (!point) return await journal.finish(false, assertBoundary);
      if (count === 5000 || !point.valid) { failed = true; break; }
      if (point.kind !== "action") continue;
      const node = plan.ir.root.nodes[point.sourceIndex]!;
      try {
        const output = await dispatchReadTool(services, captured.startedBy.id, node.capability.action, point.arguments!, {
          traceId: captured.traceId, sessionId: captured.chatSessionId, workflowId: captured.workflowId, executionId: captured.id, signal,
          assertDispatch: () => { assertBinding(); assertWorkerDispatch?.(); },
          plan: { yaml: snapshot.yaml, stepIndex: point.sourceIndex, token, toolId: node.capability.toolId, contractHash: node.capability.contractHash,
            ...(node.capability.admission ? { admissionPin: node.capability.admission } : {}) },
          iteration: { checkpoints: journal, plan, visit: point.visit, assertBinding },
        });
        // Commit even after cancellation/revocation. No dependent item sees a
        // result before its exact attempt/output receipt is acknowledged.
        await journal.completed(point.visit, output);
      } catch (error) {
        if (error instanceof ReadCheckpointFailure || error instanceof ReadRunCancelled || error instanceof ReadWorkerLeaseFailure) throw error;
        const failure = acknowledgedReadToolFailure(error);
        if (failure) await journal.completed(point.visit, failure.result);
        else await journal.failed(point.visit); // intent => UNKNOWN; pre-intent => not dispatched
        failed = true; break;
      }
    }
    assertActive?.(); return await journal.finish(failed);
  } catch (error) {
    if (error instanceof ReadCheckpointFailure || error instanceof ReadWorkerLeaseFailure || signal?.reason instanceof ReadWorkerLeaseFailure) {
      // An uncertain store acknowledgement is never permission to replay, to
      // trust an in-memory answer or to start the next item.
      try { await services.repository.recoverPersistenceState(); await reconcileInterruptedExecutions(services.repository, error instanceof ReadWorkerLeaseFailure || signal?.reason instanceof ReadWorkerLeaseFailure ? "READ_WORKER_LEASE_LOST" : "CHECKPOINT_NOT_COMMITTED", captured.id, captured.readProgress.epoch); }
      catch { /* storage remains fenced; startup reconciliation is still required */ }
      throw error;
    }
    if (error instanceof ReadRunCancelled) {
      try { assertActive?.(); return await journal.finish(); }
      catch (failure) {
        try { await services.repository.recoverPersistenceState(); await reconcileInterruptedExecutions(services.repository, "CHECKPOINT_NOT_COMMITTED", captured.id, captured.readProgress.epoch); } catch { /* still fenced */ }
        throw failure;
      }
    }
    throw error;
  } finally { unobserve(); }
}
