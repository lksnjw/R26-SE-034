import { useEffect, useRef, useState } from "react";
import ReadableValue from "../chat/ReadableValue";
import { operationRecoveryService } from "../../services/operation-recovery.service";

const button = "inline-flex min-h-9 items-center rounded-md px-3 py-2 text-xs font-semibold transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 dark:text-violet-300 dark:hover:bg-gray-800";

export default function OperationRecoveryArtifacts({ executionId }) {
  const [history, setHistory] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [admitConfirmed, setAdmitConfirmed] = useState(false), [notice, setNotice] = useState(""), [uncertain, setUncertain] = useState(false);
  const mounted = useRef(true);
  const load = async signal => {
    setLoading(true); setError("");
    try { const value = await operationRecoveryService.history(executionId, signal ? { signal } : {}); if (mounted.current) { setHistory(value); setUncertain(false); } return value; }
    catch (cause) { if (cause?.name !== "CanceledError" && mounted.current) { setHistory(null); setError(cause?.response?.data?.message || cause?.message || "Recovery plan history is unavailable."); } throw cause; }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; const controller = new AbortController(), timer = setTimeout(() => { void load(controller.signal).catch(() => {}); }, 0);
    return () => { mounted.current = false; clearTimeout(timer); controller.abort(); }; }, [executionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async () => {
    if (!history?.canCreate || !confirmed || busy || uncertain) return;
    const reconciliation = history.state === "CLOSED_NOT_APPLIED" ? history : null;
    if (!reconciliation) return;
    const command = { intentId: history.intentId, sourceVersion: history.sourceVersion, factsHash: history.factsHash,
      reconciliationId: history.reconciliationId, queryId: history.queryId, idempotencyKey: crypto.randomUUID() };
    setBusy(true); setNotice("");
    try {
      const result = await operationRecoveryService.create(history, command);
      if (!mounted.current) return;
      setNotice(result.replayed ? "The original recovery-plan request was found. No new action or execution was created." : "Immutable recovery plan saved. It has no dispatch authority and did not change or resume the source run.");
      setConfirmed(false);
      try { await load(); }
      catch { setUncertain(true); setNotice("The recovery plan was acknowledged, but its history could not be reloaded. Do not create another plan; reload authoritative history first. No ERP action was sent."); }
    } catch (cause) {
      if (!mounted.current) return;
      const denied = [400, 401, 403, 404, 409, 422].includes(cause?.response?.status);
      setUncertain(true); setNotice(denied ? `${cause?.response?.data?.message || "Recovery planning was denied or its source changed."} Reload before another request.` :
        "Recovery-plan acknowledgement is unknown. Reload authoritative history before another request; do not use a new key. No ERP action was sent.");
    } finally { if (mounted.current) setBusy(false); }
  };
  const admit = async () => {
    const artifact = history?.artifacts[0]; if (!history?.canAdmit || !artifact || !admitConfirmed || busy || uncertain) return;
    setBusy(true); setNotice("");
    try {
      const result = await operationRecoveryService.admit(history, artifact, { artifactHash: artifact.artifactHash, idempotencyKey: crypto.randomUUID() });
      if (!mounted.current) return;
      setAdmitConfirmed(false); setNotice(result.replayed ? "The original recovery admission was found. No additional execution or SDK call was created." :
        "Separate recovery execution queued. It has a new identity and must receive fresh independent approval before any SDK dispatch.");
      try { await load(); }
      catch { setUncertain(true); setNotice("Recovery admission was acknowledged, but linked history could not be reloaded. Do not admit another execution; reload authoritative history first."); }
    } catch (cause) {
      if (!mounted.current) return;
      const denied = [400, 401, 403, 404, 409, 422].includes(cause?.response?.status); setUncertain(true);
      setNotice(denied ? `${cause?.response?.data?.message || "Recovery admission was denied or its current contracts changed."} Reload before another request.` :
        "Recovery-admission acknowledgement is unknown. Reload authoritative history before another request; no approval or SDK result is assumed.");
    } finally { if (mounted.current) setBusy(false); }
  };
  if (loading && !history) return <section aria-label="Linked recovery plan" className="surface-panel rounded-2xl p-5 text-sm"><p role="status">Loading linked recovery status…</p></section>;
  return <section aria-label="Linked recovery plan" className="surface-panel space-y-4 rounded-2xl p-5 text-sm">
    <div><h2 className="section-title">Linked recovery plan</h2><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">A separate immutable plan for a confirmed not-applied outcome. This is never a retry button.</p></div>
    {error && <p role="alert" className="text-amber-800 dark:text-amber-300">{error} No recovery authority is assumed.</p>}
    {history && <>
      <p className="leading-5 text-gray-600 dark:text-gray-300">{history.explanation}</p>
      {history.artifacts.map(artifact => <article key={artifact.id} className="space-y-3 border-l border-gray-200 pl-3 dark:border-gray-700">
        <p className="font-semibold">Recovery plan saved · review required</p>
        <p className="break-words text-xs text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">{artifact.id} · linked to query {artifact.source.queryId}</p>
        <dl className="grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-gray-500">Action</dt><dd className="font-semibold">{artifact.action.toolName}</dd></div><div><dt className="text-gray-500">Source result</dt><dd>No effect observed</dd></div></dl>
        <div><p className="mb-2 text-xs font-semibold">Exact planned arguments</p><ReadableValue value={artifact.action.arguments} /></div>
        <p className="text-xs text-gray-500 dark:text-gray-400">Created by {artifact.createdBy.id} · {new Date(artifact.createdAt).toLocaleString()}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">No dispatch authority. A later action needs current capability validation, fresh independent approval, and new execution, intent and idempotency identities.</p>
      </article>)}
      {history.linkedExecution && <div className="space-y-2 border-t border-gray-200 pt-4 text-xs dark:border-gray-700"><p className="font-semibold">Separate recovery execution · {history.linkedExecution.status}</p>
        <a className="break-words font-semibold text-primary [overflow-wrap:anywhere] dark:text-violet-300" href={`/executions/${encodeURIComponent(history.linkedExecution.executionId)}`}>Open recovery execution {history.linkedExecution.executionId}</a>
        <p className="text-gray-500 dark:text-gray-400">This is a new execution. The source run remains closed and unchanged.</p></div>}
      {history.canCreate && !uncertain && <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />I understand this saves a plan only. It does not retry, dispatch, resume or mark the original SDK outcome successful.</label>
        <button className={`${button} bg-primary/10 text-primary`} disabled={busy || !confirmed} onClick={() => { void create(); }}>Create linked recovery plan</button>
      </div>}
      {history.canAdmit && !uncertain && <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
        <p className="text-xs leading-5">Admission creates a separate one-action workflow and execution from this exact plan. Current capability and policy checks run again. The new action cannot dispatch until another independent reviewer approves its exact arguments.</p>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={admitConfirmed} onChange={event => setAdmitConfirmed(event.target.checked)} disabled={busy} />Create a new recovery execution with a new intent and idempotency boundary; keep the original run closed and unchanged.</label>
        <button className={`${button} bg-primary/10 text-primary`} disabled={busy || !admitConfirmed} onClick={() => { void admit(); }}>Queue separate recovery execution</button>
      </div>}
    </>}
    {notice && <p role="status" className="leading-5 text-gray-600 dark:text-gray-300">{notice}</p>}
    {(uncertain || error) && <button className={button} disabled={busy || loading} onClick={() => { setBusy(true); void load().then(() => { setNotice("Authoritative recovery history reloaded. Review it before another request."); }).catch(() => {}).finally(() => { if (mounted.current) setBusy(false); }); }}>Reload recovery history</button>}
  </section>;
}
