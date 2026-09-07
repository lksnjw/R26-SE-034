import { useEffect, useRef, useState } from "react";
import { useOperationStatusQueries } from "../../hooks/useOperationStatusQueries";
import { operationReadbackService } from "../../services/operation-readback.service";

const labels = { QUEUED: "Query queued", RUNNING: "Checking ERP state", ANSWERED: "Status observation saved", FAILED: "No qualified observation", CANCELLED: "Query cancelled before dispatch", RECOVERY_REQUIRED: "Query answer unconfirmed" };
const outcomes = { APPLIED: "Applied condition observed", NOT_APPLIED: "Not-applied condition observed", UNRESOLVED: "Operation state still unresolved" };
const button = "inline-flex min-h-9 items-center rounded-md px-3 py-2 text-xs font-semibold transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 dark:text-violet-300 dark:hover:bg-gray-800";
const time = value => new Date(value).toLocaleString();

export default function OperationStatusQueries({ executionId, intentId, nodeId, onHistoryChanged }) {
  return <StatusQueries key={`${executionId}:${intentId || ""}:${nodeId || ""}`} executionId={executionId} intentId={intentId} nodeId={nodeId} onHistoryChanged={onHistoryChanged} />;
}
function StatusQueries({ executionId, intentId, nodeId, onHistoryChanged }) {
  const monitor = useOperationStatusQueries(executionId, { intentId, nodeId }), { history, loading, error } = monitor;
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [pending, setPending] = useState(null);
  const [showOlder, setShowOlder] = useState(false);
  // Keep active controls visible even if a returned history is not sorted.
  const visibleJobs = history?.jobs.filter((job, index) => showOlder || index < 3 || ["QUEUED", "RUNNING"].includes(job.state)) ?? [];
  const inFlight = useRef(false), mounted = useRef(true);
  const lastEvidence = useRef(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!history) return;
    const evidence = JSON.stringify(history.jobs.map(job => [job.id, job.state, job.dispatchIntentRecorded, job.completedAt, job.cancellationRequested]));
    if (evidence === lastEvidence.current) return;
    lastEvidence.current = evidence;
    // Only full-run surfaces provide this read-only refresh. Minimum recovery
    // review never requests an execution, timeline or private logs.
    onHistoryChanged?.();
  }, [history, onHistoryChanged]);
  const submit = async request => {
    if (inFlight.current || !history || loading || error) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try {
      const result = request.kind === "admit" ? await operationReadbackService.admit(request.source, request.command) : await operationReadbackService.cancel(request.source, request.id);
      if (!mounted.current) return;
      setPending(null);
      setNotice(request.kind === "admit" ? result.replayed ? "Original query request found. Saved history shows its current state; the original action was not replayed." : "Read-only query admitted. Admission is not an answer; the original action remains uncertain." :
        result.state === "RUNNING" ? "Query cancellation requested. An in-flight transport may still finish; no original action was cancelled or replayed." : "Saved query state confirmed. The original action was not changed.");
      monitor.refresh();
    } catch (cause) {
      if (!mounted.current) return;
      const denied = [400, 401, 403, 404, 409, 422, 429].includes(cause?.response?.status);
      setPending({ ...request, denied });
      setNotice(denied ? "Query command was denied or the case changed. Reload saved history before deciding what to do next." :
        "Query acknowledgement is unconfirmed. Reload saved history, then explicitly check this same request. Nothing is automatically resubmitted.");
      // A fresh GET must precede a same-key explicit check. Clear old access.
      monitor.refresh();
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const start = () => {
    if (!history?.canQuery || pending || busy || loading || error) return;
    const source = { executionId, intentId: history.intentId, nodeId: history.nodeId };
    void submit({ kind: "admit", source, command: { intentId: history.intentId, baseVersion: history.baseVersion, factsHash: history.factsHash, idempotencyKey: crypto.randomUUID() } });
  };
  return <section className="workspace-reveal min-w-0 space-y-3 border-t border-gray-200 pt-4 text-xs text-gray-900 dark:border-gray-700 dark:text-gray-100" aria-label="ERP status queries">
    <div><h2 className="font-semibold">ERP status queries</h2><p className="mt-1 break-words text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">Run {executionId}{history ? ` · node ${history.nodeId}` : nodeId ? ` · node ${nodeId}` : ""}</p></div>
    <p className="leading-5 text-gray-600 dark:text-gray-300">Checks the reviewed operation-state condition. It does not confirm the original send, recipient delivery or permission to resume.</p>
    {loading && <p role="status">Loading saved query history…</p>}
    {error && <p role="alert" className="text-amber-800 dark:text-amber-300">{error} No saved evidence is shown until a valid reload.</p>}
    {history && <>
      {history.memoryOnly && <p className="text-amber-800 dark:text-amber-300">Memory mode · this history is not durable across server restart.</p>}
      {history.jobs.length === 0 ? <p className="text-gray-500 dark:text-gray-400">No saved status queries. This is not evidence that the action did or did not happen.</p> : <ol className="max-h-72 space-y-4 overflow-y-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" tabIndex={0} aria-label="Saved status observations">
        {visibleJobs.map(job => <li key={job.id} className="min-w-0 space-y-2 border-l border-gray-200 pl-3 dark:border-gray-700">
          <p className="font-semibold">{labels[job.state]}</p>
          {job.observation ? <><p>{outcomes[job.observation.outcome]}</p><dl className="grid gap-x-4 gap-y-2 text-gray-600 dark:text-gray-300 sm:grid-cols-2">
            <div><dt>Observed</dt><dd>{time(job.observation.observedAt)}</dd></div><div><dt>State settled</dt><dd>{job.observation.settled ? "Yes, under the reviewed contract" : "No · keep unresolved"}</dd></div>
          </dl></> : <p className="text-gray-600 dark:text-gray-300">{job.queryOutcome === "UNQUALIFIED_RESULT" ? "The returned evidence did not match the reviewed identity or freshness requirements." : job.queryOutcome === "UNKNOWN" ? "A query intent was saved, but no trustworthy query answer is available." : "No query dispatch intent is recorded; no observation is available."}</p>}
          <p className="break-words text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">{job.actorId} · requested {time(job.createdAt)} · {job.id}</p>
          {job.cancellationRequested && <p className="text-gray-500 dark:text-gray-400">Cancellation request saved for this query—not for the original action.</p>}
          {job.canCancel && <button className={button} disabled={busy || !!pending || loading || !!error} onClick={() => { void submit({ kind: "cancel", id: job.id, source: { executionId, intentId: history.intentId, nodeId: history.nodeId } }); }}>Cancel status query</button>}
        </li>)}
      </ol>}
      {(showOlder || history.jobs.length > visibleJobs.length) && <button className={button} aria-expanded={showOlder} onClick={() => setShowOlder(value => !value)}>{showOlder ? "Show recent queries" : `Show older queries (${history.jobs.length - visibleJobs.length})`}</button>}
      {!history.canQuery && <p className="text-gray-500 dark:text-gray-400">A new query is unavailable: the case may be closed, a query may be pending, or current permissions, connection or reviewed status capability may not allow it.</p>}
    </>}
    {notice && <p role="status" className="leading-5 text-gray-600 dark:text-gray-300">{notice}</p>}
    {pending && <div className="space-y-2"><p className="leading-5 text-amber-800 dark:text-amber-300">{pending.kind === "admit" ? "Check the same query request only after reviewing history. If admission was never saved, this explicitly queues that read-only query. It never resends the original action." : "Checking again explicitly repeats only this query's cancellation request. It never cancels the original action."}</p>
      <button className={button} disabled={busy || loading || !!error || !history} onClick={() => { void submit(pending); }}>Check same query request</button>
      {pending.denied && <button className={button} disabled={busy || loading || !!error || !history} onClick={() => { setPending(null); setNotice("Saved history loaded. Any new query uses the current case revision; no action was automatically submitted."); }}>Use reloaded case</button>}</div>}
    <div className="flex flex-wrap gap-2"><button className={`${button} bg-primary/10 text-primary`} disabled={busy || loading || !!error || !!pending || !history?.canQuery} onClick={start}>Query current ERP state</button>
      <button className={button} disabled={busy || loading} onClick={monitor.refresh}>Reload status history</button></div>
    <p className="text-[10px] leading-4 text-gray-500 dark:text-gray-400">The original SDK outcome stays unacknowledged. No automatic resend, case closure or later-node execution. Matching entity data is not proof that this particular send caused it.</p>
  </section>;
}
