import { Icon } from "@iconify/react";
import { isGovernanceBlock } from "../../constants/workflowStatus";
import StepLogItem from "./StepLogItem";
import { ReadableResult } from "../chat/ReadableValue";

/*******************************************************************************
 * Function: ExecutionTimeline
 *
 * Performs the Execution Timeline operation on timeline for the ExecutionTimeline module.
 ******************************************************************************/
function ExecutionTimeline({ timeline = [] }) {
  if (timeline.length === 0) return <p className="text-sm text-gray-500">No step timeline was recorded.</p>;
  return (
    <div className="space-y-3">
      {timeline.map((step, index) => {
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
            {blocked ? (
              <p className="ml-9 mt-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                <Icon icon="mdi:shield-alert-outline" className="h-4 w-4" />
                Blocked by {step.failure.ruleId} — tool never called
              </p>
            ) : null}
            {step.status === "UNKNOWN" && <p className="ml-9 mt-1 text-xs text-amber-700 dark:text-amber-300">The read may have reached ERP, but no confirmed answer was saved. Do not assume success or retry it automatically.</p>}
            {step.status === "SKIPPED" && <p className="ml-9 mt-1 text-xs text-gray-500">Not selected by the recorded condition. No tool call or answer.</p>}
            {step.outcome === "CONDITION_SELECTED" && <p className="ml-9 mt-1 text-xs text-gray-500">{step.output?.selectedBranch} selected · deterministic condition, not an ERP tool result.</p>}
            {step.outcome === "NOT_DISPATCHED" && <p className="ml-9 mt-1 text-xs text-gray-500">No dispatch was recorded for this attempt.</p>}
            {step.status === "FAILED" && step.output?.isError === true && <details className="ml-9 mt-2 text-xs"><summary className="cursor-pointer">Saved tool failure response</summary><div className="mt-2"><ReadableResult value={step.output} /></div></details>}
          </div>
        );
      })}
    </div>
  );
}

export default ExecutionTimeline;
