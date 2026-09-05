import type { HandlerServices } from "../http/handlers/common.js";
import type { Execution } from "../repository/store.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import type { CompiledReadPlan } from "../workflows/compiled-read.js";
import { dispatchReadTool } from "../tools/read-tool-broker.js";
import { ErpbridgeMcpToolError } from "../tools/erpbridge-mcp-client.js";
import { ReadCheckpointFailure, ReadRunCancelled, reconcileInterruptedExecutions } from "./read-checkpoints.js";
import { ReadIterationCheckpoints } from "./read-iteration-checkpoints.js";
import { assertIterationDispatchBinding } from "../workflows/read-iteration-dispatch-binding.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";

/** Shared server driver for synchronous/queued collection controllers. No run
 * admission or HTTP wiring yet: publication/storage/lease/UI qualification
 * remain required. Never accepts client-produced cursors, outputs or evidence. */
export async function completeCheckpointedCollectionRead(services: HandlerServices, initial: Execution, input: Record<string, unknown>, token: ValidationToken,
  compiledPlan: CompiledReadPlan, bindingKey: string, signal?: AbortSignal, assertDispatchBinding?: () => void): Promise<Execution> {
  const captured = structuredClone(initial), plan = structuredClone(compiledPlan), snapshot = captured.workflowSnapshot;
  if (!snapshot || !captured.readProgress || !captured.iterationProgress || snapshot.executionProfile !== "collection-read-v1" || token.registry_hash !== snapshot.registryHash)
    throw new Error("Collection driver requires an admitted immutable run identity");
  const journal = new ReadIterationCheckpoints(services.repository, captured.id, captured.readProgress.epoch, snapshot.yaml, plan, input, services.registries.snapshot().tools, bindingKey, signal);
  const session = services.erpbridgeSession, registryHash = services.registries.hash(), generation = session?.discoveryGeneration ?? 0;
  const roleMap = canonicalJSONBytes(services.config.erpbridgeRoleMap);
  const assertBinding = () => {
    if (services.erpbridgeSession !== session || services.registries.hash() !== registryHash || session?.available === false ||
        (session?.discoveryGeneration ?? 0) !== generation || !roleMap.equals(canonicalJSONBytes(services.config.erpbridgeRoleMap))) throw new Error("Collection controller context changed");
    assertDispatchBinding?.();
  };
  const assertBoundary = (state: Parameters<typeof assertIterationDispatchBinding>[1]) => {
    assertBinding(); assertIterationDispatchBinding(services, state, captured.id, captured.readProgress!.epoch, snapshot.yaml, plan, captured.iterationProgress!.admittedRole);
  };
  let failed = false;
  try {
    for (let count = 0; count <= 5000; count++) {
      const point = await journal.advance(assertBoundary);
      if (!point) return await journal.finish(false, assertBoundary);
      if (count === 5000 || !point.valid) { failed = true; break; }
      if (point.kind !== "action") continue;
      const node = plan.ir.root.nodes[point.sourceIndex]!;
      try {
        const output = await dispatchReadTool(services, captured.startedBy.id, node.capability.action, point.arguments!, {
          traceId: captured.traceId, sessionId: captured.chatSessionId, workflowId: captured.workflowId, executionId: captured.id, signal,
          plan: { yaml: snapshot.yaml, stepIndex: point.sourceIndex, token, toolId: node.capability.toolId, contractHash: node.capability.contractHash,
            ...(node.capability.admission ? { admissionPin: node.capability.admission } : {}) },
          iteration: { checkpoints: journal, plan, visit: point.visit, assertBinding },
        });
        // Commit even after cancellation/revocation. No dependent item sees a
        // result before its exact attempt/output receipt is acknowledged.
        await journal.completed(point.visit, output);
      } catch (error) {
        if (error instanceof ReadCheckpointFailure || error instanceof ReadRunCancelled) throw error;
        if (error instanceof ErpbridgeMcpToolError) await journal.completed(point.visit, error.result);
        else await journal.failed(point.visit); // intent => UNKNOWN; pre-intent => not dispatched
        failed = true; break;
      }
    }
    return await journal.finish(failed);
  } catch (error) {
    if (error instanceof ReadCheckpointFailure) {
      // An uncertain store acknowledgement is never permission to replay, to
      // trust an in-memory answer or to start the next item.
      try { await services.repository.recoverPersistenceState(); await reconcileInterruptedExecutions(services.repository, "CHECKPOINT_NOT_COMMITTED", captured.id, captured.readProgress.epoch); }
      catch { /* storage remains fenced; startup reconciliation is still required */ }
      throw error;
    }
    if (error instanceof ReadRunCancelled) return journal.finish();
    throw error;
  }
}
