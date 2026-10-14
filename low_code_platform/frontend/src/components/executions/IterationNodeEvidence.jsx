import { useState } from "react";
import ReadableValue, { ReadableResult } from "../chat/ReadableValue";
import { iterationPositionLabel } from "../../utils/iterationEvidence";

const labels = { PREPARING: "Checking before dispatch", DISPATCH_INTENT: "Dispatch recorded · answer not saved", STARTED: "Collection started", DONE: "Confirmed", FAILED: "Stopped", UNKNOWN: "Outcome unknown", CANCELLED: "Cancelled before dispatch", SKIPPED: "Not evaluated", INTERRUPTED: "Interrupted", UNCONFIRMED: "Evidence incomplete" };
function AnswerDisclosure({ title, children }) {
  const [opened, setOpened] = useState(false);
  return <div className="mt-2 text-[10px]"><button type="button" className="min-h-8 text-left text-primary" aria-expanded={opened} onClick={() => setOpened(value => !value)}>{title}</button>{opened && <div className="mt-2 max-h-64 overflow-auto">{children}</div>}</div>;
}
function Receipt({ row }) {
  const value = row.confirmed && row.status === "DONE" && Object.hasOwn(row, "output");
  return <li className="border-b border-gray-100 py-2 last:border-0 dark:border-gray-800">
    <p className="text-[10px] font-medium">{iterationPositionLabel(row.iterations)} · {row.kind === "collection-item" ? "Collected item" : row.kind === "collection" ? "Collection" : row.kind === "merge" ? "Branch value" : row.kind === "condition" ? "Condition" : row.kind === "return" ? "Workflow return" : "Read"}</p>
    <p className={`mt-1 text-[10px] ${["UNKNOWN", "UNCONFIRMED", "FAILED"].includes(row.status) ? "text-amber-700 dark:text-amber-300" : "text-gray-500"}`}>{labels[row.status] || "Evidence incomplete"}{row.selected ? ` · ${row.selected === "then" ? "If yes" : "If no"}` : ""}</p>
    {row.kind === "collection" && row.confirmed && Number.isInteger(row.count) && <p className="mt-1 text-[10px] text-gray-500">{row.completedItems} of {row.count} typed item values saved{row.status !== "DONE" && " · aggregate not confirmed"}</p>}
    {row.status === "UNKNOWN" && <p className="mt-1 text-[10px] text-amber-700">The read may have reached ERP. No confirmed answer or automatic replay.</p>}
    {row.status === "UNCONFIRMED" && <p className="mt-1 text-[10px] text-gray-500">Refresh this run. No answer or branch is inferred from unmatched evidence.</p>}
    {row.status === "SKIPPED" && <p className="mt-1 text-[10px] text-gray-500">{row.reason?.kind === "empty-collection" ? "Empty collection" : row.reason?.kind === "return" ? "Workflow already returned" : "Another branch was selected"} · no tool call or answer.</p>}
    {row.notDispatched && <p className="mt-1 text-[10px] text-gray-500">No dispatch was recorded for this attempt.</p>}
    {value && <AnswerDisclosure title={row.kind === "action" ? "Saved item answer" : row.kind === "collection" ? "Saved collection aggregate" : "Saved typed value"}>{row.kind === "action" ? <ReadableResult value={row.output} /> : <ReadableValue value={row.output} />}</AnswerDisclosure>}
    {row.failureOutput && <AnswerDisclosure title="Saved tool failure response"><ReadableResult value={row.failureOutput} /></AnswerDisclosure>}
  </li>;
}

export default function IterationNodeEvidence({ model, nodeId, kinds }) {
  const [page, setPage] = useState(0);
  if (!model?.valid) return null;
  const rows = (model.nodes[nodeId]?.rows ?? []).filter(row => !kinds || kinds.includes(row.kind));
  if (!rows.length) return <p className="mt-2 text-[10px] text-gray-500">No item evidence recorded for this node in run {model.executionId}.</p>;
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 25) - 1)), start = current * 25;
  return <section aria-label={`Saved item evidence for ${nodeId}`} className="relative z-10 mt-2 border-l border-gray-200 pl-3 dark:border-gray-700">
    <p className="text-[10px] text-gray-500">Run {model.executionId} · {rows.length} saved boundaries</p>
    <ol>{rows.slice(start, start + 25).map(row => <Receipt key={`${row.kind}:${row.invocationId}`} row={row} />)}</ol>
    {rows.length > 25 && <div className="mt-2 flex items-center gap-3 text-[10px]"><button type="button" disabled={!current} onClick={() => setPage(current - 1)} className="min-h-8 text-primary disabled:opacity-40">Previous items</button><span>{start + 1}–{Math.min(start + 25, rows.length)} of {rows.length}</span><button type="button" disabled={start + 25 >= rows.length} onClick={() => setPage(current + 1)} className="min-h-8 text-primary disabled:opacity-40">Next items</button></div>}
  </section>;
}
