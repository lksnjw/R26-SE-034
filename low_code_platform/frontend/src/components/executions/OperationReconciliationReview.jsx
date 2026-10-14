import { useState } from "react";
import ReadableValue from "../chat/ReadableValue";
import { completeApprovalDisplay } from "./RuntimeApprovalReview";
import OperationReconciliationEvidence from "./OperationReconciliationEvidence";
import { executionService } from "../../services/execution.service";

export default function OperationReconciliationReview({ execution, onReload, statusQueries }) {
  const review = execution.operationReconciliation;
  const resolutionBasis = review.history.at(-1)?.basis;
  const [outcome, setOutcome] = useState("UNRESOLVED"), [kind, setKind] = useState("erp-record");
  const [reference, setReference] = useState(""), [note, setNote] = useState(""), [observedAt, setObservedAt] = useState("");
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [receipt, setReceipt] = useState(null), [notice, setNotice] = useState("");
  const complete = typeof review.toolName === "string" && !!review.toolName.trim() && typeof review.remoteToolName === "string" && !!review.remoteToolName.trim() && completeApprovalDisplay(review.arguments);
  const available = review.canRecord === true && complete && !busy && !uncertain && !receipt;
  const observed = observedAt ? new Date(observedAt) : null;
  const ready = available && confirmed && reference.trim() && note.trim() && observed && Number.isFinite(observed.getTime());
  const observedNow = () => {
    const now = new Date(), local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    setObservedAt(local); setConfirmed(false);
  };
  const reload = async () => {
    setBusy(true);
    try { await onReload(); setUncertain(false); setConfirmed(false); setNotice("Authoritative case reloaded. Check its saved evidence before another decision."); }
    catch { setNotice("Case reload failed. No decision was retried. Keep this case locked until reload succeeds."); }
    finally { setBusy(false); }
  };
  const recordEvidence = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const result = await executionService.reconcile(execution.id, { intentId: review.intentId, baseVersion: review.version, factsHash: review.factsHash,
        decisionKey: crypto.randomUUID(), outcome, evidence: { kind, reference: reference.trim(), note: note.trim(), observedAt: observed.toISOString() } });
      if (result?.executionId !== execution.id || result.intentId !== review.intentId || typeof result.recordId !== "string" || result.outcome !== outcome ||
          result.version !== review.version + 1 || result.state !== (outcome === "UNRESOLVED" ? "OPEN" : "RESOLVED") || result.canResume !== false || result.noReplay !== true || result.toolWasCalled !== false || result.basis !== "operator-attestation")
        throw new Error("Unconfirmed reconciliation receipt");
      setReceipt(result); setNotice(outcome === "UNRESOLVED" ? "Evidence saved. The case remains unresolved. No operation was called or retried." : "Operator evidence saved and this run closed—not completed successfully. No action or later node was resumed.");
      try { await onReload(); } catch { setNotice("Evidence was acknowledged, but refreshing failed. Reload the case; do not submit it again."); }
    } catch (error) {
      const status = error?.response?.status;
      setNotice([403, 409, 422].includes(status) ? `${error?.response?.data?.message || "Evidence denied or case changed."} Reload the case before recording again.` : "Evidence acknowledgement is unknown. Reload authoritative state before another decision. Nothing was automatically retried.");
      setUncertain(true);
    } finally { setBusy(false); }
  };
  const field = "mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm disabled:opacity-50 dark:border-gray-700";
  return <section className="min-w-0 space-y-5 text-gray-900 dark:text-gray-100" aria-label="Uncertain operation review">
    <div><h1 className="page-heading text-gray-950 dark:text-white">Reconcile operation</h1><p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{execution.workflowName} · {review.nodeId}</p></div>
    <div className="border-y border-gray-200 py-4 dark:border-gray-700"><p className="text-sm font-semibold">{receipt?.state || review.state} · revision {receipt?.version || review.version}</p><p className="mt-2 text-sm">The action may have taken effect, but no confirmed SDK answer was saved.</p><p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{review.explanation}</p></div>
    <dl className="grid gap-4 text-xs sm:grid-cols-2">{Object.entries({ Tool: review.toolName || "Unavailable", "Exact remote tool": review.remoteToolName || "Unavailable", Requester: review.requesterId, Invocation: review.invocationId,
      "Local operation key—not an ERP idempotency guarantee": review.operationKey, "Intent saved": review.preparedAt }).map(([label, value]) => <div key={label}><dt className="text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
    <div><h2 className="mb-3 text-sm font-semibold">Exact business arguments</h2><ReadableValue value={review.arguments} /></div>
    {statusQueries}
    {review.history.length > 0 && <div className="space-y-4"><h2 className="text-sm font-semibold">Saved external evidence</h2>{review.history.map(record => <OperationReconciliationEvidence key={record.id} record={record} />)}</div>}
    {!complete && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">The exact tool or complete argument display is unavailable. Recording is disabled; a shortened preview is not a full review.</p>}
    {!review.canRecord && review.state === "OPEN" && <p className="text-sm text-gray-500 dark:text-gray-400">Recording requires an independent active account with explicit execution:reconcile permission. The requester cannot reconcile their own action.</p>}
    {notice && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{notice}</p>}
    {review.state === "OPEN" && review.canRecord && <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">Check the actual ERP record or delivery audit first. Record a safe reference, not passwords, tokens or unnecessary personal data.</p>
      <label className="block text-xs">Observed outcome<select className={field} aria-label="Observed outcome" value={outcome} onChange={event => { setOutcome(event.target.value); setConfirmed(false); }} disabled={!available}><option value="UNRESOLVED">Still unresolved—keep the case open</option><option value="APPLIED">Effect observed—close without replay</option><option value="NOT_APPLIED">No effect observed—close without replay</option></select></label>
      <label className="block text-xs">Evidence source<select className={field} aria-label="Evidence source" value={kind} onChange={event => setKind(event.target.value)} disabled={!available}><option value="erp-record">ERP record</option><option value="delivery-audit">Delivery audit</option><option value="external-support">External support investigation</option></select></label>
      <label className="block text-xs">Evidence reference<input className={field} aria-label="Evidence reference" value={reference} maxLength={500} onChange={event => setReference(event.target.value)} disabled={!available} /></label>
      <label className="block text-xs">What you checked<textarea className={field} aria-label="What you checked" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} disabled={!available} /></label>
      <label className="block text-xs">When you observed the evidence (your local time)<input className={field} type="datetime-local" step="1" aria-label="Evidence observed at" value={observedAt} onInput={event => setObservedAt(event.currentTarget.value)} onChange={event => setObservedAt(event.target.value)} disabled={!available} /></label>
      <button type="button" className="min-h-8 text-xs font-semibold text-primary disabled:opacity-40 dark:text-violet-300" disabled={!available} onClick={observedNow}>Observed just now</button>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!available} />I independently checked this evidence. This is an operator attestation, not a tool-confirmed result, delivery guarantee or permission to resume or resend.</label>
      <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-white transition-opacity disabled:opacity-40" disabled={!ready} onClick={recordEvidence}>Record external evidence</button>
    </div>}
    {review.state === "RESOLVED" && <p className="text-sm text-gray-500 dark:text-gray-400">{resolutionBasis === "queried-operation-state" ? "Closed by an independently reviewed ERP status observation." : "Closed by operator evidence."} The original SDK outcome remains unacknowledged; later nodes were not run. Any recovery needs a separately reviewed artifact.</p>}
    <button type="button" className="text-sm font-semibold text-primary disabled:opacity-40 dark:text-violet-300" disabled={busy} onClick={reload}>{busy ? "Waiting for acknowledgement…" : "Reload exact case"}</button>
  </section>;
}
