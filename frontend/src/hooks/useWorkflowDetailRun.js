import { useRef, useState } from "react";
import { workflowService } from "../services/workflow.service";
import { executionService } from "../services/execution.service";

const empty = { loading: false, result: null, error: null, unconfirmed: false };
export const canDismissRecordedRun = status => ["DONE", "FAILED", "CANCELLED"].includes(status);

/** One explicit admission, then read-only monitoring. Keep known or uncertain
 * runs locked until review; refetch errors cannot erase a successful receipt. */
export function useWorkflowDetailRun(workflowId, onChanged) {
  const [frames, setFrames] = useState(() => new Map());
  const locks = useRef(new Set());
  const state = frames.get(workflowId) || empty;
  const save = frame => setFrames(previous => new Map(previous).set(workflowId, frame));
  const run = async (input = {}) => {
    if (!workflowId || locks.current.has(workflowId)) return;
    locks.current.add(workflowId); save({ ...empty, loading: true });
    let sent = false;
    try {
      const readiness = await workflowService.readiness(workflowId);
      if (readiness.can_attempt_run !== true) throw new Error("This publication is not ready. Open the canvas to review its current validation, tools and inputs.");
      const mode = readiness.operation_job_admission === "operation-job/v1" ? "async-operation" : readiness.read_job_admission === "read-job-v1" ? "async-read" : null;
      if (!mode) throw new Error("Queued execution is unavailable. Open the canvas to inspect supported run options.");
      const idempotencyKey = crypto.randomUUID();
      sent = true;
      const result = await executionService.run(workflowId, input, { mode, idempotencyKey });
      if (typeof result?.id !== "string" || !result.id.trim()) throw new Error("The run receipt has no execution ID.");
      save({ ...empty, result });
      void Promise.resolve().then(() => onChanged?.()).catch(() => {});
    } catch (cause) {
      const executionId = cause?.response?.data?.meta?.executionId;
      if (sent && executionId) {
        try { const result = await executionService.get(executionId); if (result?.id !== executionId) throw new Error("Wrong receipt"); save({ ...empty, result }); return; }
        catch { /* Retain uncertainty; never repeat admission. */ }
      }
      const unconfirmed = sent && (!cause?.response || Boolean(executionId) || cause.response.status >= 500);
      if (!unconfirmed) locks.current.delete(workflowId);
      save({ ...empty, unconfirmed, error: unconfirmed ? "The run outcome is unconfirmed. Review Execution History before another run; nothing was retried." : cause?.response?.data?.message || cause?.message || "Run was not admitted." });
    }
  };
  const dismiss = snapshot => {
    if (!snapshot || !state.result || snapshot.id !== state.result.id || !canDismissRecordedRun(snapshot.status)) return;
    locks.current.delete(workflowId); save(empty);
  };
  return { state, run, dismiss };
}
