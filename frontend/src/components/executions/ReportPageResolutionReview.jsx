import { useState } from "react";
import ReadableValue from "../chat/ReadableValue";
import SchemaFields from "../chat/SchemaFields";
import { executionService } from "../../services/execution.service";

const seed = (schema, depth = 0) => {
  if (!schema || depth > 8) return null;
  if (schema.type === "object") return Object.fromEntries((schema.required || []).filter(key => schema.properties?.[key]).map(key => [key, seed(schema.properties[key], depth + 1)]));
  if (schema.type === "array") return [];
  return ({ string: "", integer: 0, number: 0, boolean: false, null: null })[schema.type] ?? null;
};
const localNow = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };

export default function ReportPageResolutionReview({ execution, onReload }) {
  const review = execution.reportPageResolution, [output, setOutput] = useState(() => seed(review.outputSchema));
  const [reference, setReference] = useState(""), [note, setNote] = useState(""), [observedAt, setObservedAt] = useState("");
  const [confirmPage, setConfirmPage] = useState(false), [confirmAbandon, setConfirmAbandon] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [receipt, setReceipt] = useState(null), [notice, setNotice] = useState("");
  const observed = observedAt ? new Date(observedAt) : null, evidenceReady = reference.trim() && note.trim() && observed && Number.isFinite(observed.getTime());
  const available = review.state === "OPEN" && review.canRecord && !busy && !uncertain && !receipt;
  const submit = async outcome => {
    if (!available || !evidenceReady || outcome === "PAGE_CONFIRMED" && !confirmPage || outcome === "ABANDONED" && !confirmAbandon) return;
    setBusy(true); setNotice("");
    const command = { profile: "report-page-resolution-command/v1", intentId: review.intentId, baseVersion: review.version, factsHash: review.factsHash,
      decisionKey: crypto.randomUUID(), outcome, evidence: { reference: reference.trim(), note: note.trim(), observedAt: observed.toISOString() },
      ...(outcome === "PAGE_CONFIRMED" ? { output: { content: [], structuredContent: output } } : {}) };
    try {
      const result = await executionService.resolveReportPage(execution.id, command);
      if (result?.executionId !== execution.id || result.intentId !== review.intentId || typeof result.recordId !== "string" || result.outcome !== outcome ||
          result.version !== 2 || result.noReplay !== true || result.toolWasCalled !== false || result.resumeQueued !== (outcome === "PAGE_CONFIRMED") || result.pageAccepted !== (outcome === "PAGE_CONFIRMED"))
        throw new Error("Unconfirmed report-page resolution receipt");
      setReceipt(result); setNotice(outcome === "PAGE_CONFIRMED" ? "Captured page accepted. The worker continues from the next page or cursor; the uncertain call was not replayed." :
        "Occurrence abandoned. No page was replayed, no action was approved and no effect was dispatched.");
      try { await onReload(); } catch { setNotice("The decision was acknowledged, but refreshing failed. Reload the case; do not submit it again."); }
    } catch (error) {
      const status = error?.response?.status;
      setNotice([403, 409, 422].includes(status) ? `${error?.response?.data?.message || "Resolution denied or case changed."} Reload exact evidence before another decision.` :
        "Resolution acknowledgement is unknown. Reload authoritative state before another decision; the uncertain page was not automatically replayed.");
      setUncertain(true);
    } finally { setBusy(false); }
  };
  const reload = async () => { setBusy(true); try { await onReload(); setUncertain(false); setNotice("Authoritative case reloaded. Review it again before deciding."); }
    catch { setNotice("Case reload failed. Keep this case locked until authoritative state is available."); } finally { setBusy(false); } };
  const field = "mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm disabled:opacity-50 dark:border-gray-700";
  return <section className="min-w-0 space-y-5 text-gray-900 dark:text-gray-100" aria-label="Uncertain report page review">
    <div><h1 className="page-heading text-gray-950 dark:text-white">Resolve report continuation</h1><p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{execution.workflowName} · {review.nodeId}</p></div>
    <div className="border-y border-gray-200 py-4 dark:border-gray-700"><p className="text-sm font-semibold">{receipt?.state || review.state} · case revision {receipt?.version || review.version}</p>
      <p className="mt-2 text-sm">Page {review.pointer} has an uncertain transport outcome. {review.continuationProfile === "opaque-cursor/v1" ? "Its raw continuation remains protected." : "Its server-owned page number is shown below."}</p>
      <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{review.explanation}</p></div>
    <dl className="grid gap-4 text-xs sm:grid-cols-2">{Object.entries({ Tool: review.toolName, "Exact remote tool": review.remoteToolName, Requester: review.requesterId,
      "Continuation type": review.continuationProfile === "opaque-cursor/v1" ? "Protected cursor" : "Page number", "Uncertain page": review.pointer,
      "Previously confirmed pages": review.confirmedPages, "Previously confirmed records": review.confirmedItems, ...(review.cursorHash ? { "Protected cursor fingerprint": review.cursorHash } : {}) }).map(([label, value]) => <div key={label}><dt className="text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
    <div><h2 className="mb-3 text-sm font-semibold">Bound report arguments</h2><ReadableValue value={review.arguments} /></div>
    {review.history.length > 0 && <div><h2 className="mb-3 text-sm font-semibold">Saved resolution evidence</h2><ol className="space-y-3">{review.history.map(record => <li key={record.id} className="border-l-2 border-gray-200 pl-3 text-xs dark:border-gray-700"><p className="font-semibold">{record.outcome === "PAGE_CONFIRMED" ? "Captured page accepted" : "Occurrence abandoned"} · page {record.pointer}</p><p className="mt-1">Reference: {record.evidence.reference}</p><p className="mt-1 text-gray-500">{record.evidence.note}</p><time className="mt-1 block text-gray-400" dateTime={record.recordedAt}>{new Date(record.recordedAt).toLocaleString()}</time></li>)}</ol></div>}
    {!review.canRecord && review.state === "OPEN" && <p className="text-sm text-gray-500">Resolution requires an independent active account with explicit execution:reconcile permission. The requester cannot resolve their own page.</p>}
    {notice && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{notice}</p>}
    {review.state === "OPEN" && review.canRecord && <div className="space-y-4">
      <div><h2 className="mb-2 text-sm font-semibold">Independently captured page fields</h2><p className="mb-3 text-xs text-gray-500">Enter the captured connector fields in this typed form. The server validates the reviewed output schema, exact window, continuation, snapshot, count and bounds.</p>
        <SchemaFields label="Captured page" schema={review.outputSchema} value={output} onChange={setOutput} allowReferences={false} /></div>
      <label className="block text-xs">Evidence reference<input className={field} aria-label="Report evidence reference" value={reference} maxLength={500} onChange={event => setReference(event.target.value)} disabled={!available} /></label>
      <label className="block text-xs">What you independently checked<textarea className={field} aria-label="Report evidence note" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} disabled={!available} /></label>
      <label className="block text-xs">When the evidence was observed<input className={field} type="datetime-local" step="1" aria-label="Report evidence observed at" value={observedAt} onChange={event => setObservedAt(event.target.value)} disabled={!available} /></label>
      <button type="button" className="min-h-8 text-xs font-semibold text-primary disabled:opacity-40" disabled={!available} onClick={() => { setObservedAt(localNow()); setConfirmPage(false); setConfirmAbandon(false); }}>Observed just now</button>
      <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmPage} onChange={event => { setConfirmPage(event.target.checked); setConfirmAbandon(false); }} disabled={!available} />I independently captured this exact page. Validate it and continue only from the next continuation.</label>
        <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-white disabled:opacity-40" disabled={!available || !evidenceReady || !confirmPage} onClick={() => submit("PAGE_CONFIRMED")}>Validate captured page and continue</button></div>
      <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmAbandon} onChange={event => { setConfirmAbandon(event.target.checked); setConfirmPage(false); }} disabled={!available} />No trustworthy captured result is available. Close this occurrence without another page call or effect.</label>
        <button type="button" className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-700 disabled:opacity-40 dark:border-red-900 dark:text-red-300" disabled={!available || !evidenceReady || !confirmAbandon} onClick={() => submit("ABANDONED")}>Abandon this occurrence</button></div>
    </div>}
    {review.state === "RESOLVED" && <p className="text-sm text-gray-500">This case is closed. A captured page continuation never proves recipient delivery; any later effect still requires its own exact approval.</p>}
    <button type="button" className="text-sm font-semibold text-primary disabled:opacity-40" disabled={busy} onClick={reload}>{busy ? "Waiting for acknowledgement…" : "Reload exact case"}</button>
  </section>;
}
