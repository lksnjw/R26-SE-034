import { Link } from "react-router-dom";

// A legacy description/build decision is not an exact transaction approval.
export default function PendingApprovalCard({ execution }) {
  if (!execution.pendingApproval && !execution.hasRuntimeApproval) return null;
  return <section className="border-y border-amber-300/60 py-4 text-gray-900 dark:border-amber-700/50 dark:text-gray-100" aria-label="Approval checkpoint">
    <h2 className="text-sm font-semibold">{execution.hasRuntimeApproval ? "Exact transaction approval" : "Legacy approval cannot resume"}</h2>
    <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{execution.pendingApproval?.description || execution.agentSummary}</p>
    <p className="mt-2 text-xs text-gray-500">Accepting a workflow edit does not authorize a transaction. Approval is not delivery or completion.</p>
    {execution.hasRuntimeApproval ? <Link className="mt-3 inline-block text-sm font-semibold text-primary dark:text-violet-300" to={`/executions/${encodeURIComponent(execution.id)}?view=approval`}>Review exact transaction</Link>
      : <p className="mt-3 text-xs text-gray-500">This record has no bound transaction payload. Safe runtime resume is unavailable; nothing will be auto-approved.</p>}
  </section>;
}
