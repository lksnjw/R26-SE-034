import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import { ReadableResult } from "../chat/ReadableValue";
import IterationNodeEvidence from "./IterationNodeEvidence";

/*******************************************************************************
 * Function: OutputBlock
 *
 * Performs the Output Block operation on block for the ExecutionOutputPanel module.
 ******************************************************************************/
function OutputBlock({ value }) {
  return (
    <div data-testid="output-block" className="max-h-[420px] overflow-auto">
      <ReadableResult value={value} />
    </div>
  );
}

/**
 * Shows what the run produced. For a completed run the final output leads; for
 * a run that stopped part way the steps that did complete are still shown, so
 * partial results are never lost behind the failure message.
 */
/*******************************************************************************
 * Function: ExecutionOutputPanel
 *
 * Performs the Execution Output Panel operation on output panel for the ExecutionOutputPanel module.
 ******************************************************************************/
function ExecutionOutputPanel({ execution, iterationModel }) {
  if (!execution) return null;
  const { stepOutputs, status } = execution;
  const collection = Boolean(execution.iterationProgress || execution.workflowSnapshot?.executionProfile === "collection-read-v1");
  const finalOutput = collection ? iterationModel?.finalOutput : execution.finalOutput;
  const stepEntries = collection ? [] : Object.entries(stepOutputs || {});
  const itemNodes = collection && iterationModel?.valid ? Object.values(iterationModel.nodes).filter(node => node.kind === "action" && node.rows.length) : [];
  const returned = collection ? iterationModel?.finalKind === "return" : Object.values(execution.readProgress?.values || {}).some(receipt => receipt.kind === "return" && receipt.status === "DONE");
  const hasFinal = collection ? iterationModel?.valid && iterationModel.hasFinal : finalOutput !== undefined && (finalOutput !== null || returned && Object.hasOwn(execution, "finalOutput"));

  if (!hasFinal && stepEntries.length === 0 && !itemNodes.length) {
    return (
      <Card>
        <h2 className="section-title mb-3">Workflow output</h2>
        {collection && !iterationModel?.valid && <p role="alert" className="mb-3 text-xs text-amber-700">Saved item answers need a matching run snapshot and timeline. Refresh this run; no result is inferred.</p>}
        <p data-testid="no-output" className="text-sm text-gray-500">
          {status === "RUNNING" ? "No confirmed output has been saved yet." : "This run did not produce a confirmed output."}
        </p>
      </Card>
    );
  }

  const partial = status !== "DONE";

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="section-title">Workflow output</h2>
        {partial ? (
          <span
            data-testid="partial-output-badge"
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
          >
            <Icon icon="mdi:progress-alert" className="h-4 w-4" />
            {status === "RUNNING" ? "Partial — run still active" : "Partial — run not completed"}
          </span>
        ) : null}
      </div>

      {hasFinal ? (
        <div data-testid="final-output" className="mb-5">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">
            {returned ? "Saved workflow return" : partial ? collection ? "Last completed item" : "Last completed step" : "Final output"}
          </p>
          {returned && finalOutput === null && <p className="mb-2 text-xs text-gray-500">Explicit null returned; this is a confirmed value, not a missing answer.</p>}
          <OutputBlock value={finalOutput} />
        </div>
      ) : null}

      {itemNodes.length > 0 && <section aria-label="Saved per-item answers"><h3 className="mb-2 text-xs font-semibold">Saved per-item answers</h3>{itemNodes.map(node => <div key={node.id} className="mt-3"><h4 className="text-xs font-medium">{node.id}</h4><IterationNodeEvidence key={`${execution.id}:${node.id}`} model={iterationModel} nodeId={node.id} /></div>)}</section>}

      {stepEntries.length > 0 ? (
        <div data-testid="step-outputs">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Saved step answers</p>
          <div className="space-y-3">
            {stepEntries.map(([stepId, value]) => (
              <div key={stepId}>
                <p className="mb-1 font-mono text-xs font-semibold text-gray-600 dark:text-gray-300">{stepId}</p>
                <OutputBlock value={value} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default ExecutionOutputPanel;
