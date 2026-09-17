import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import { ReadableResult } from "../chat/ReadableValue";
import IterationNodeEvidence from "./IterationNodeEvidence";
import { isActiveExecution } from "../../utils/executionEvents";

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
  const coverageMap = execution.reportCoverages && typeof execution.reportCoverages === "object" && !Array.isArray(execution.reportCoverages) ? execution.reportCoverages : {};
  const coverages = Object.values(coverageMap).filter(value => value?.profile === "schedule-report-coverage/v1");
  if (!coverages.length && execution.reportCoverage?.profile === "schedule-report-coverage/v1") coverages.push(execution.reportCoverage);
  const projected = coverages.filter(value => value.relatedRecords?.mode === "PROJECTED");
  const matched = coverages.filter(value => value.relatedRecords?.mode === "REQUESTED_MATCHED");
  const relatedMatch = projected.length === 1 && matched.length === 1 &&
    projected[0].relatedRecords.relationName === matched[0].relatedRecords.relationName &&
    projected[0].relatedRecords.keyCount === matched[0].relatedRecords.keyCount &&
    projected[0].relatedRecords.keysHash === matched[0].relatedRecords.keysHash;

  if (!hasFinal && stepEntries.length === 0 && !itemNodes.length && !coverages.length) {
    return (
      <Card>
        <h2 className="section-title mb-3">Workflow output</h2>
        {collection && !iterationModel?.valid && <p role="alert" className="mb-3 text-xs text-amber-700">Saved item answers need a matching run snapshot and timeline. Refresh this run; no result is inferred.</p>}
        <p data-testid="no-output" className="text-sm text-gray-500">
          {isActiveExecution(status) ? "No confirmed output has been saved yet." : "This run did not produce a confirmed output."}
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
            {isActiveExecution(status) ? "Partial — run still active" : "Partial — run not completed"}
          </span>
        ) : null}
      </div>

      {coverages.length ? (
        <section data-testid="report-coverage" aria-label="Scheduled report coverage" className="mb-5 border-y border-emerald-200 py-4 text-sm dark:border-emerald-800">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="font-semibold text-emerald-950 dark:text-emerald-100">Complete report window confirmed</h3>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{coverages.length} reviewed {coverages.length === 1 ? "dataset" : "datasets"} saved for this scheduled run.</p></div>
            <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
              {relatedMatch ? "All related records matched" : "Connector attestation saved"}
            </span>
          </div>
          {relatedMatch ? <div className="mt-4 border-l-2 border-emerald-500 pl-3" data-testid="related-record-match">
            <p className="font-semibold text-emerald-950 dark:text-emerald-100">Related records matched exactly</p>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">Every projected {projected[0].relatedRecords.relationName} key was requested and returned once · {projected[0].relatedRecords.keyCount} keys verified.</p>
          </div> : null}
          <div className="mt-4 divide-y divide-emerald-200 dark:divide-emerald-900">
            {coverages.map(coverage => {
              const pagination = ["report-page-evidence/v1", "report-cursor-evidence/v1"].includes(coverage.pagination?.profile) ? coverage.pagination : null;
              const relation = coverage.relatedRecords;
              return <details key={coverage.nodeId} className="group py-3 first:pt-0 last:pb-0" open={coverages.length === 1}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-1 outline-none transition-colors hover:text-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:hover:text-emerald-200">
                  <span><span className="font-semibold">{coverage.nodeId}</span><span className="ml-2 text-xs text-gray-500">{coverage.itemCount} records</span></span>
                  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{relation?.mode === "PROJECTED" ? "Keys identified" : relation?.mode === "REQUESTED_MATCHED" ? "Records matched" : "Window covered"}</span>
                </summary>
                <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                  <div><dt className="font-semibold">Covered interval</dt><dd>{new Date(coverage.startAt).toLocaleString()} → {new Date(coverage.endAt).toLocaleString()}</dd></div>
                  <div><dt className="font-semibold">Records verified</dt><dd>{coverage.itemCount}</dd></div>
                  {relation ? <div><dt className="font-semibold">Related-record proof</dt><dd>{relation.mode === "PROJECTED" ? "Required keys identified from primary records" : "Requested keys returned exactly once"}</dd></div> : null}
                  {pagination ? <><div><dt className="font-semibold">Pages confirmed</dt><dd>{pagination.pageCount}{pagination.profile === "report-page-evidence/v1" ? ` · ${pagination.firstPage} through ${pagination.lastPage}` : " · protected cursor continuation"}</dd></div><div><dt className="font-semibold">Declared report total</dt><dd>{pagination.totalCount ?? "Evidence unavailable"}</dd></div><div><dt className="font-semibold">Stable report snapshot</dt><dd>{pagination.snapshotHash ? "Confirmed across every page" : "Evidence unavailable"}</dd></div></> : null}
                  <div><dt className="font-semibold">Confirmed</dt><dd>{new Date(coverage.confirmedAt).toLocaleString()}</dd></div>
                </dl>
              </details>;
            })}
          </div>
          <p className="mt-4 text-xs text-emerald-900/80 dark:text-emerald-200/80">This proves each reviewed connector result covered the scheduled interval, exhausted any declared pagination and matched its declared record total. It does not approve or prove delivery of a later effect.</p>
        </section>
      ) : null}

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
