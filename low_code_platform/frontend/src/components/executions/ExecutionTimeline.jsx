import { Icon } from "@iconify/react";
import { useState } from "react";
import { isGovernanceBlock } from "../../constants/workflowStatus";
import StepLogItem from "./StepLogItem";
import { ReadableResult } from "../chat/ReadableValue";
import { iterationPositionLabel } from "../../utils/iterationEvidence";
import OperationReconciliationEvidence from "./OperationReconciliationEvidence";

/*******************************************************************************
 * Function: ExecutionTimeline
 *
 * Performs the Execution Timeline operation on timeline for the ExecutionTimeline module.
 ******************************************************************************/
function ExecutionTimeline({ timeline = [] }) {
  const [page, setPage] = useState(0);
  if (timeline.length === 0) return <p className="text-sm text-gray-500">No step timeline was recorded.</p>;
  const current = Math.min(page, Math.max(0, Math.ceil(timeline.length / 50) - 1)), start = current * 50;
  return (
    <div className="space-y-3">
      {timeline.slice(start, start + 50).map((step, offset) => {
        const index = start + offset;
        const blocked = step.status === "FAILED" && isGovernanceBlock(step.failure);
        // A blocked step reads BLOCKED, not FAILED: nothing crashed.
        const chip = blocked ? "BLOCKED" : step.status === "UNKNOWN" ? "Outcome unknown" : step.status;
        const label = step.label || step.nodeId;
        return (
          <div
            key={step.id || `${step.nodeId}-${index}`}
            data-testid="timeline-step"
            data-blocked={blocked ? "true" : "false"}
          >
            <StepLogItem index={index} log={`${label}: ${chip}`} tone={blocked ? "blocked" : undefined} />
            {step.invocationId && <p className="ml-9 mt-1 text-xs text-gray-500">{iterationPositionLabel(step.iterations)}</p>}
            {blocked ? (
              <p className="ml-9 mt-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                <Icon icon="mdi:shield-alert-outline" className="h-4 w-4" />
                Blocked by {step.failure.ruleId} — tool never called
              </p>
            ) : null}
            {step.status === "UNKNOWN" && <p className="ml-9 mt-1 text-xs text-amber-700 dark:text-amber-300">{step.sideEffect ? "The operation may have taken effect in ERP, but no confirmed SDK result was saved. Do not assume success or replay automatically." : "The read may have reached ERP, but no confirmed answer was saved. Do not assume success or retry it automatically."}</p>}
            {step.reconciliation && <div className="ml-9 mt-2"><OperationReconciliationEvidence record={step.reconciliation} /></div>}
            {step.status === "SKIPPED" && <p className="ml-9 mt-1 text-xs text-gray-500">{step.reason?.kind === "empty-collection" ? "Empty collection. No tool call or answer." : step.outcome === "AFTER_RETURN" || step.reason?.kind === "return" ? `Skipped after return ${step.returnId || step.reason.returnId}. No tool call or answer.` : "Not selected by the recorded condition. No tool call or answer."}</p>}
            {step.outcome === "CONDITION_SELECTED" && <p className="ml-9 mt-1 text-xs text-gray-500">{step.output?.selectedBranch} selected · deterministic condition, not an ERP tool result.</p>}
            {["VALUE_MERGED", "WORKFLOW_RETURNED"].includes(step.outcome) && <div className="ml-9 mt-2"><p className="mb-1 text-xs text-gray-500">{step.outcome === "VALUE_MERGED" ? "Selected branch value saved" : "Workflow returned · later actions stopped"} · no tool call</p><ReadableResult value={step.output?.value} /></div>}
            {step.outcome === "VALUE_INVALID" && <p className="ml-9 mt-1 text-xs text-amber-700">Typed value missing or invalid. No substitute result or dependent dispatch.</p>}
            {step.outcome === "NOT_DISPATCHED" && <p className="ml-9 mt-1 text-xs text-gray-500">No dispatch was recorded for this attempt.</p>}
            {step.status === "FAILED" && step.output?.isError === true && <details className="ml-9 mt-2 text-xs"><summary className="cursor-pointer">Saved tool failure response</summary><div className="mt-2"><ReadableResult value={step.output} /></div></details>}
          </div>
        );
      })}
      {timeline.length > 50 && <div className="flex items-center gap-3 text-xs"><button type="button" disabled={!current} className="min-h-8 text-primary disabled:opacity-40" onClick={() => setPage(current - 1)}>Previous boundaries</button><span>{start + 1}–{Math.min(start + 50, timeline.length)} of {timeline.length}</span><button type="button" disabled={start + 50 >= timeline.length} className="min-h-8 text-primary disabled:opacity-40" onClick={() => setPage(current + 1)}>Next boundaries</button></div>}
    </div>
  );
}

export default ExecutionTimeline;
