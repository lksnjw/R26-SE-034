import { useEffect, useRef, useState } from "react";
import { workflowService } from "../../services/workflow.service";
import { parseWorkflowPreview } from "./workflowPreview";
import ReadableValue from "./ReadableValue";

const button = "inline-flex min-h-8 items-center rounded-md px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-800";
const errorText = error => error?.response?.data?.message || error?.message || "Saved history could not be loaded.";
const labels = { baseline: "Starting snapshot", updateNode: "Node edited", addNode: "Node added", updateAnalysis: "Analysis edited", addAnalysis: "Analysis added", removeNode: "Node removed", moveNode: "Node moved", updateCollection: "Collection edited", wrapCollection: "Collection created", removeCollection: "Collection removed", updateCondition: "Condition edited", addCondition: "Condition added", wrapNode: "Condition created", removeCondition: "Condition removed", setConditionMerge: "Branch output edited", addReturn: "Return added", updateReturn: "Return edited", removeReturn: "Return removed", restoreDraft: "Source replaced", restoreVersion: "Saved revision restored", undoDraft: "Edit undone", redoDraft: "Edit redone", setControlFlow: "Flow edited" };

// Key this component by the current revision. Old requests cannot replace a
// new draft's history or manufacture an undo stack after a reconnect.
export default function WorkflowEditHistory({ workflowId, record, canEdit, busy, onRestore }) {
  const [page, setPage] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null), [previewing, setPreviewing] = useState(false);
  const active = useRef(false), previewEpoch = useRef(0);
  const { version, contentHash } = record;
  useEffect(() => {
    let current = true;
    active.current = true;
    workflowService.editHistory(workflowId, { version, contentHash }).then(value => { if (current) setPage(value); })
      .catch(cause => { if (current) setError(errorText(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; active.current = false; };
  }, [workflowId, version, contentHash]);
  const more = async () => {
    setLoading(true); setError("");
    try { const next = await workflowService.editHistory(workflowId, record, page.nextBeforeId); if (active.current) setPage(previous => ({ ...next, entries: [...previous.entries, ...next.entries] })); }
    catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { if (active.current) setLoading(false); }
  };
  const inspect = async entry => {
    const epoch = ++previewEpoch.current; setPreviewing(true); setSelected(null); setError("");
    try { const source = await workflowService.editHistoryVersion(workflowId, record, entry); if (active.current && epoch === previewEpoch.current) setSelected({ ...entry, ...source }); }
    catch (cause) { if (active.current && epoch === previewEpoch.current) setError(errorText(cause)); }
    finally { if (active.current && epoch === previewEpoch.current) setPreviewing(false); }
  };
  const preview = selected ? parseWorkflowPreview(selected.yaml) : null;
  return <section aria-label="Saved workflow edit history" className="workspace-reveal mt-4 border-y border-gray-200 py-4 dark:border-gray-700">
    <h4 className="text-xs font-semibold">Saved edit history</h4>
    <p className="mt-1 text-[10px] text-gray-500">Undo and redo survive reopening this workflow. Restoring creates a new draft; publications and run answers stay unchanged.</p>
    {error && <p role="alert" className="mt-3 text-xs text-red-600">{error} Reload the workflow to refresh its revision.</p>}
    {page && <>{page.persistence === "memory-only" && <p className="mt-2 text-[10px] text-amber-700">Memory-only server · this history is lost on server restart. Reopening the browser does not erase it.</p>}<p className="mt-3 text-[10px] text-gray-500">{page.total} saved snapshots · {page.undoDepth} undo / {page.redoDepth} redo available. Quick undo keeps the latest {page.undoLimit}; older saved revisions remain below.</p>
      <ol className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">{page.entries.map(entry => <li key={entry.id} className="flex items-center justify-between gap-2 py-2">
        <div className="min-w-0 text-xs"><p className="break-words">v{entry.version} · {entry.artifactState === "PUBLISHED" ? "Published snapshot" : labels[entry.change?.type] || "Saved draft"}{entry.current ? " · current" : ""}</p>
          <p className="mt-1 break-words text-[10px] text-gray-500">{entry.change?.nodeId ? `${entry.change.nodeId} · ` : ""}{entry.nodeCount} action declarations{entry.createdBy?.name ? ` · ${entry.createdBy.name}` : ""}</p></div>
        <button className={button} aria-label={`Inspect saved revision ${entry.id}`} disabled={busy || previewing} onClick={() => inspect(entry)}>Inspect v{entry.version}</button>
      </li>)}</ol>{!page.entries.length && <p className="mt-2 text-xs text-gray-500">No saved snapshots yet. The next workspace edit records its starting draft.</p>}
      {page.nextBeforeId && <button className={`${button} mt-2`} disabled={loading || busy} onClick={more}>Load older revisions</button>}</>}
    {loading && <p role="status" className="mt-3 text-xs text-gray-500">Loading saved revisions…</p>}
    {previewing && <p role="status" className="mt-3 text-xs text-gray-500">Loading the selected saved snapshot…</p>}
    {selected && <section aria-label="Saved revision preview" className="mt-4 border-t pt-4 text-xs">
      <h5 className="font-semibold">Inspect v{selected.version} · {preview.name || "Saved workflow"}</h5>
      <p className="mt-1 text-[10px] text-gray-500">Historical content only—not a current validation result or an execution answer. The backend validates it again if you restore.</p>
      <p className="mt-2 text-[10px] text-gray-500">Restoring replaces the full draft, including its inputs, paths and actions. Review the saved settings and nodes below.</p>
      {preview.error ? <p role="alert" className="mt-2 text-amber-700">{preview.error}</p> : <><details className="mt-3"><summary className="cursor-pointer">Workflow settings and paths</summary><div className="mt-2"><ReadableValue value={{ description: preview.description, trigger: preview.trigger, metadata: preview.metadata }} /></div></details><ol className="mt-3 space-y-2">{preview.steps.map(step => <li key={step.id}><details><summary className="cursor-pointer break-words">{step.source.description || step.id} · {step.action}</summary><div className="mt-2"><ReadableValue value={step.source} /></div></details></li>)}</ol></>}
      {canEdit && <button className={`${button} mt-3 border border-gray-200 dark:border-gray-700`} disabled={busy || selected.current || Boolean(preview.error) || record.readinessUnknown} onClick={() => onRestore({ type: "restoreVersion", versionId: selected.id, contentHash: selected.contentHash })}>Restore as new draft</button>}
      {selected.current && <p className="mt-2 text-[10px] text-gray-500">This snapshot is already the current saved content.</p>}
    </section>}
  </section>;
}
