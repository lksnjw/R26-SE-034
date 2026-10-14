export const reconciliationOutcomeLabel = outcome => ({ APPLIED: "Effect observed", NOT_APPLIED: "No effect observed", UNRESOLVED: "Still unresolved" }[outcome] || "Evidence unavailable");
export default function OperationReconciliationEvidence({ record }) {
  if (record?.basis === "queried-operation-state" && record.observation) return <section className="min-w-0 space-y-2 border-l border-gray-200 pl-3 text-xs dark:border-gray-700" aria-label="Reviewed ERP status observation">
    <p className="font-semibold">{reconciliationOutcomeLabel(record.outcome)} · reviewed ERP status observation</p>
    <p className="break-words [overflow-wrap:anywhere]">Saved query {record.queryId}</p>
    <p className="text-gray-500 dark:text-gray-400">Observed {record.observation.observedAt} · state settled under the reviewed contract</p>
    <p className="text-gray-500 dark:text-gray-400">Accepted by {record.actorId} · {record.recordedAt}</p>
    <p className="text-gray-500 dark:text-gray-400">Not confirmation of the original SDK answer or recipient delivery. No resume or replay.</p>
  </section>;
  if (!record || record.basis !== "operator-attestation" || !record.evidence) return null;
  return <div className="min-w-0 space-y-2 border-l border-gray-200 pl-3 text-xs dark:border-gray-700" aria-label="Operator evidence">
    <p className="font-semibold">{reconciliationOutcomeLabel(record.outcome)} · operator attestation</p>
    <p className="break-words [overflow-wrap:anywhere]">{record.evidence.reference}</p>
    <p className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{record.evidence.note}</p>
    <p className="text-gray-500 dark:text-gray-400">{record.evidence.kind} · observed {record.evidence.observedAt}</p>
    <p className="text-gray-500 dark:text-gray-400">Recorded by {record.actorId} · {record.recordedAt}</p>
    <p className="text-gray-500 dark:text-gray-400">Not a saved tool answer or independently verified delivery. No resume or replay.</p>
  </div>;
}
