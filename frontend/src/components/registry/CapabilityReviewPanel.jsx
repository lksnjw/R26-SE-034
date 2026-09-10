import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { capabilityService } from "../../services/capability.service";
import { apiErrorMessage } from "../../services/api";
import { usePermissions } from "../../hooks/usePermissions";
import Button from "../shared/ui/Button";

const words = (value) => String(value ?? "Not recorded").replaceAll("_", " ").toLowerCase();
const label = (value) => words(value).replace(/^./, (letter) => letter.toUpperCase());
const storageKey = (actorId) => `workflow.capability-decision.${encodeURIComponent(actorId)}`;
function restoreDecision(actorId) {
  try {
    const text = sessionStorage.getItem(storageKey(actorId));
    if (!text) return null;
    if (text.length > 8192) throw new Error();
    const value = JSON.parse(text);
    if (!["review", "disable"].includes(value.action) || typeof value.capabilityId !== "string" ||
        !value.capabilityId || value.capabilityId.length > 256 || !value.body || typeof value.body.note !== "string" ||
        !value.body.note.trim() || value.body.note.length > 2000) throw new Error();
    if (value.action === "review" && (typeof value.body.observationId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.body.contractHash) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(value.body.decisionKey) || value.body.dataClass !== "internal" || value.body.retryPolicy !== "never" ||
        !(value.body.effectClass === "read" && value.body.riskClass === "low" || ["write", "notification"].includes(value.body.effectClass) && ["low", "medium"].includes(value.body.riskClass) && value.body.requireIndependentApproval === true))) throw new Error();
    if (value.action === "disable" && (typeof value.body.revisionId !== "string" || !Number.isSafeInteger(value.body.baseVersion) || value.body.baseVersion < 1)) throw new Error();
    return value;
  } catch { return { invalid: true }; }
}

// Inspect data as labelled fields, never HTML or a raw JSON document. Budgets
// protect the inspector; an incomplete rendering disables new review.
function fitsInspector(value, depth = 0, budget = { remaining: 1200 }) {
  if (depth > 16 || --budget.remaining < 0) return false;
  if (value && typeof value === "object") return Object.values(value).every((item) => fitsInspector(item, depth + 1, budget));
  return true;
}
function Fields({ value, depth = 0 }) {
  if (depth > 16) return <p>Nested detail exceeds the inspector limit.</p>;
  if (value === null || value === undefined) return <span>Not specified</span>;
  if (typeof value !== "object") return <span className="whitespace-pre-wrap break-words">{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</span>;
  const entries = Object.entries(value);
  if (!entries.length) return <span>No entries</span>;
  return <dl className="space-y-2">{entries.slice(0, 60).map(([key, item]) => <div key={key} className="border-l border-gray-200 pl-3 dark:border-gray-700">
    <dt className="text-xs font-semibold text-gray-500">{Array.isArray(value) ? `Item ${Number(key) + 1}` : label(key)}</dt>
    <dd className="mt-1 text-sm"><Fields value={item} depth={depth + 1} /></dd>
  </div>)}{entries.length > 60 ? <p>Additional entries exceed the inspector limit.</p> : null}</dl>;
}
function fullyVisible(value) {
  if (!fitsInspector(value)) return false;
  if (value && typeof value === "object") return Object.keys(value).length <= 60 && Object.values(value).every(fullyVisible);
  return true;
}

export default function CapabilityReviewPanel() {
  const { actorId, role, has } = usePermissions();
  if (!has("registry:read")) return null;
  return <ReviewWorkspace key={actorId} actorId={actorId} canReview={Boolean(actorId && role === "Platform Admin" && has("registry:write"))} />;
}

function ReviewWorkspace({ actorId, canReview }) {
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [pending, setPending] = useState(() => restoreDecision(actorId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [inventory, setInventory] = useState([]);
  const lock = useRef(false);
  const query = useQuery({ queryKey: ["capability-review", actorId, offset], queryFn: () => capabilityService.catalog(offset), retry: false });
  const entries = query.data?.capabilities ?? [];
  const selected = entries.find((entry) => entry.capabilityId === selectedId) ?? null;
  const ready = !query.isFetching && !query.error && Boolean(query.data);
  const mutationAllowed = canReview && ready && query.data.persistence !== "unsupported-for-admission";

  async function run(action, task) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await task(); }
    catch (failure) { setError(apiErrorMessage(failure, `${action} could not be confirmed. Reload status before deciding what to do next.`)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function sendDecision(decision) {
    const result = await capabilityService[decision.action](decision.capabilityId, decision.body);
    const admission = decision.action === "review" ? result?.admission : result;
    if (admission?.capabilityId !== decision.capabilityId || !["AVAILABLE", "DISABLED", "BLOCKED"].includes(admission?.state) || !Number.isSafeInteger(admission?.version) ||
        (decision.action === "review" && (result?.revision?.capabilityId !== decision.capabilityId || result?.revision?.observationId !== decision.body.observationId || result?.revision?.contractHash !== decision.body.contractHash)) ||
        (decision.action === "disable" && (admission?.state !== "DISABLED" || admission?.revisionId !== decision.body.revisionId))) {
      throw new Error("Decision acknowledgement is invalid");
    }
    // Keep the exact request until a receipt is confirmed. Retries of a saved
    // review cannot re-enable a capability that has subsequently been disabled.
    sessionStorage.removeItem(storageKey(actorId)); setPending(null);
    setMessage(decision.action === "review" ? "Review decision acknowledged. Current authority is shown in the reloaded catalog, not inferred from this receipt." : "Disable acknowledged. New dispatch is blocked; already-sent remote work is not rolled back.");
    await query.refetch();
  }
  function decide(action, entry, note) {
    if (!mutationAllowed || pending || busy) return;
    run("Decision", async () => {
      if (action === "review" && !entry.reviewEligible) throw new Error("Review unavailable");
      const decision = { action, capabilityId: entry.capabilityId, body: action === "review" ? {
        observationId: entry.observation.id, contractHash: entry.observation.contractHash,
        decisionKey: `review_${crypto.randomUUID()}`, effectClass: entry.observation.definition.is_read_only ? "read" : entry.observation.definition.operation_contract?.effect_class,
        riskClass: entry.observation.definition.is_read_only ? "low" : entry.observation.definition.risk_level.toLowerCase(), dataClass: "internal", retryPolicy: "never", note: note.trim(),
        ...(entry.observation.definition.is_read_only ? {} : { requireIndependentApproval: true }),
      } : { revisionId: entry.admission.revisionId, baseVersion: entry.admission.version, note: note.trim() } };
      // No credentials, arguments or results are stored. If local persistence
      // fails, don't submit a request whose decision identity could be lost.
      sessionStorage.setItem(storageKey(actorId), JSON.stringify(decision)); setPending(decision);
      await sendDecision(decision);
    });
  }
  return <section aria-label="ERP capability review" className="border-t border-gray-200 pt-6 dark:border-gray-800">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="section-title">ERP capability review</h2><p className="mt-2 max-w-3xl text-sm text-gray-500">Discovery records evidence. An administrator reviews capability contracts; each operation still needs independent exact approval.</p></div>
      <div className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => query.refetch()}>Reload review status</Button>
        {canReview ? <Button disabled={!ready || busy || Boolean(pending) || !query.data?.connection.discoveryAvailable} onClick={() => run("Discovery", async () => {
          const result = await capabilityService.discover();
          if (result?.authorityGranted !== false || !Array.isArray(result?.unreviewedInventory)) throw new Error("Unsupported discovery response");
          setInventory(result.unreviewedInventory); setOffset(0); setSelectedId(null);
          setMessage(`Discovery saved; no tool enabled. ${result.blockedCount ?? 0} existing admissions blocked by drift.`);
          await query.refetch();
        })}>{busy ? "Working…" : "Refresh discovery"}</Button> : null}
      </div>
    </div>
    {!canReview ? <p className="mt-3 text-sm text-gray-500">Read only. Current Platform Admin registry permission is required for decisions.</p> : null}
    {query.isLoading ? <p className="mt-4" role="status">Loading capability review…</p> : null}
    {query.error ? <p className="mt-4 text-sm text-red-700" role="alert">Review status unavailable. No new decisions can be submitted.</p> : null}
    {query.data ? <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-y border-gray-200 py-3 text-sm dark:border-gray-800">
      <p>Session: <strong>{label(query.data.connection.state)}</strong></p><p>Storage: <strong>{label(query.data.persistence)}</strong></p>
      <p className="w-full text-xs text-gray-500">Initialization is not proof of ERP authorization, delivery, or live tool readiness. {query.data.persistence === "memory-only" ? "Reviews in this mode do not survive a server restart." : "Distributed revocation is not qualified."}</p>
    </div> : null}
    {pending ? <div className="mt-4 border-l-2 border-amber-500 pl-4 text-sm" role="status">
      <p className="font-semibold">{pending.invalid ? "The local decision record needs recovery." : `Unconfirmed ${pending.action} decision`}</p>
      <p className="mt-1">No success is assumed. Keep the exact request for an acknowledgement retry, or reload authority before ending local retries.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!pending.invalid && canReview ? <Button disabled={busy} onClick={() => run("Decision retry", () => sendDecision(pending))}>Retry exact decision</Button> : null}
        <Button variant="secondary" disabled={busy} onClick={() => run("Decision recovery", async () => {
          const result = await query.refetch(); if (result.error || !result.data) throw new Error("Status unavailable");
          sessionStorage.removeItem(storageKey(actorId)); setPending(null);
          setMessage("Local retries ended after reloading status. This does not undo any saved decision; inspect current authority before submitting another review.");
        })}>Reload status and end local retries</Button>
      </div>
    </div> : null}
    {error ? <p role="alert" className="mt-4 text-sm text-red-700">{error}</p> : null}
    {message ? <p role="status" className="mt-4 text-sm text-gray-600 dark:text-gray-300">{message}</p> : null}
    <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.3fr)]">
      <div><h3 className="text-sm font-semibold">Current capability states</h3>
        {!entries.length && ready ? <p className="mt-3 text-sm text-gray-500">No capability observations. Configure a supported backend session, then refresh discovery.</p> : null}
        <ul className="mt-3 divide-y divide-gray-200 dark:divide-gray-800">{entries.map((entry) => {
          const definition = entry.observation?.definition ?? entry.revision?.definition;
          return <li key={entry.capabilityId}><button disabled={busy || Boolean(pending)} aria-pressed={selectedId === entry.capabilityId} onClick={() => setSelectedId(entry.capabilityId)} className="w-full rounded-lg px-2 py-3 text-left transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-primary dark:hover:bg-gray-800">
            <span className="block text-sm font-semibold">{definition?.display_name || definition?.name || entry.capabilityId}</span><span className="mt-1 block text-xs text-gray-500">{label(entry.effectiveState)} · {entry.observation?.toolId ?? entry.revision?.toolId}</span>
          </button></li>;
        })}</ul>
        <div className="mt-4 flex items-center gap-3"><Button variant="ghost" disabled={!offset || busy || Boolean(pending)} onClick={() => { setOffset(offset - 10); setSelectedId(null); }}>Previous</Button><span className="text-xs">Page {offset / 10 + 1}</span><Button variant="ghost" disabled={!ready || !query.data?.hasMoreCapabilities || busy || Boolean(pending)} onClick={() => { setOffset(offset + 10); setSelectedId(null); }}>Next</Button></div>
      </div>
      {selected ? <CapabilityInspector key={`${selected.capabilityId}:${selected.observation?.id}:${selected.admission?.version}`} entry={selected} canReview={mutationAllowed && !busy && !pending} onDecision={decide} /> : <p className="text-sm text-gray-500">Select a capability to inspect its inputs, output contract, roles, and current authority.</p>}
    </div>
    {inventory.length ? <details className="mt-6"><summary className="cursor-pointer text-sm font-semibold">Unmapped remote tools ({inventory.length})</summary><p className="my-2 text-sm text-gray-500">These names have no local reviewed contract. They are not executable. Inventory is from this discovery request only.</p><ul className="space-y-2 text-sm">{inventory.map((item) => <li key={item.remoteName} className="break-all">{item.remoteName} — {label(item.reason)}</li>)}</ul></details> : null}
  </section>;
}

function CapabilityInspector({ entry, canReview, onDecision }) {
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const definition = entry.observation?.definition ?? entry.revision?.definition;
  const operation = definition?.is_read_only === false;
  const reportCoverage = definition?.report_coverage_contract?.profile === "report-coverage/v1" ? definition.report_coverage_contract : null;
  const projectedRelation = reportCoverage?.key_projection;
  const requestedRelation = reportCoverage?.requested_key_coverage;
  const complete = fullyVisible(definition);
  const validNote = note.trim().length > 0 && note.length <= 2000;
  return <div className="min-w-0">
    <h3 className="text-base font-semibold">Contract and authority</h3>
    <dl className="mt-3 space-y-2 break-words text-sm"><div><dt className="text-xs text-gray-500">Current state (not a dispatch guarantee)</dt><dd>{label(entry.effectiveState)}</dd></div>
      <div><dt className="text-xs text-gray-500">Review eligibility</dt><dd>{entry.reviewEligible ? operation ? "Supported operation contract; independent approval required for every invocation" : "Supported read; explicit review required" : label(entry.reviewReason)}</dd></div>
      <div><dt className="text-xs text-gray-500">Observation time</dt><dd>{entry.observation?.discoveredAt ?? "No observation"}</dd></div>
      <div><dt className="text-xs text-gray-500">Exact contract hash</dt><dd className="font-mono text-xs">{entry.observation?.contractHash ?? entry.revision?.contractHash}</dd></div>
      <div><dt className="text-xs text-gray-500">Output schema validation</dt><dd>{definition?.bridge_contract?.output_schema ? "Declared schema checked before downstream use" : "No declared output schema; bounded result handling still applies"}</dd></div>
      {reportCoverage ? <div><dt className="text-xs text-gray-500">Scheduled report coverage</dt><dd>Exact {reportCoverage.start_parameter} → {reportCoverage.end_parameter} interval; connector must attest complete result, no remaining page, returned items and matching count.
        {projectedRelation ? <span className="mt-1 block">Related-record role: identifies the complete <strong>{projectedRelation.relation_name}</strong> key set from the primary records for a later reviewed report.</span> : null}
        {requestedRelation ? <span className="mt-1 block">Related-record role: accepts the reviewed <strong>{requestedRelation.relation_name}</strong> keys through <strong>{requestedRelation.keys_parameter}</strong> and must return each requested record exactly once.</span> : null}
        <span className="mt-1 block">This evidence does not approve a later effect.</span></dd></div> : null}
      {entry.revision ? <div><dt className="text-xs text-gray-500">Current saved review</dt><dd>{entry.revision.id} · {entry.revision.reviewedBy.id} · {entry.revision.reviewedAt}</dd></div> : null}
      {entry.admission?.reason ? <div><dt className="text-xs text-gray-500">Stored block reason</dt><dd>{label(entry.admission.reason)}</dd></div> : null}
    </dl>
    {entry.revision ? <details className="mt-4"><summary className="cursor-pointer text-sm font-semibold">Saved review policy and previous contract</summary><div className="mt-3 max-h-[28rem] overflow-auto">{fullyVisible(entry.revision.definition) ? <Fields value={{ policy: entry.revision.policy, definition: entry.revision.definition }} /> : <p>Saved definition exceeds the inspector budget. Inspect the complete saved revision through the administrator API.</p>}</div></details> : null}
    <details open className="mt-4"><summary className="cursor-pointer text-sm font-semibold">Observed definition · inputs, outputs, roles, and constraints</summary><div className="mt-3 max-h-[32rem] overflow-auto pr-2">{complete ? <Fields value={definition} /> : <p className="text-sm">This definition exceeds the readable inspector budget. New review is unavailable; inspect and simplify the contract using the administrator API.</p>}</div></details>
    {canReview ? <div className="mt-5 border-t border-gray-200 pt-4 dark:border-gray-800">
      <p className="text-sm">{operation ? `Operation policy: ${definition.operation_contract?.effect_class || "unsupported"} · ${definition.risk_level} risk · internal data · independent exact approval · no automatic replay. This review does not authorize a particular send or ERP change.` : "Supported policy: read-only · low risk · internal data · no application replay. This does not approve external email or data sharing."}</p>
      <label className="mt-3 block text-sm font-semibold">Decision note<textarea aria-label="Capability decision note" maxLength={2000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 bg-transparent p-3 font-normal dark:border-gray-700" /></label>
      <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />I inspected this exact contract and understand this changes authority for new dispatch.</label>
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={!entry.reviewEligible || !complete || !validNote || !confirmed} onClick={() => onDecision("review", entry, note)}>{operation ? "Save explicit operation review" : "Save explicit read review"}</Button>
        {entry.admission && entry.admission.state !== "DISABLED" ? <Button variant="danger" disabled={!validNote || !confirmed} onClick={() => onDecision("disable", entry, note)}>Disable new dispatch</Button> : null}</div>
    </div> : null}
  </div>;
}
