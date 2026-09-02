import { useState } from "react";
import { executionService } from "../../services/execution.service";
import { executionEventLabel } from "../../utils/executionEvents";
import ExecutionStatus from "./ExecutionStatus";

export default function ExecutionRunControls({ execution, canControl = false, monitor, onChanged }) {
  const [requesting, setRequesting] = useState(false), [acknowledged, setAcknowledged] = useState(false), [error, setError] = useState("");
  if (!execution) return monitor?.error ? <div role="alert" className="text-xs text-amber-700">{monitor.error}{monitor.reconnecting && " Reconnecting updates automatically."}<button className="ml-2 text-primary" onClick={monitor.refresh}>Refresh run</button></div> : null;
  const running = execution.status === "RUNNING" || execution.status === "PENDING";
  const pending = running && (acknowledged || Boolean(execution.readProgress?.cancellation));
  const recovery = execution.status === "RECOVERY_REQUIRED";
  const requestCancel = async () => {
    setRequesting(true); setError("");
    try {
      await executionService.cancel(execution.id);
      setAcknowledged(true); monitor?.refresh(); onChanged?.();
    } catch (cause) {
      setError(cause?.response?.data?.message || "Cancellation was not confirmed. Refresh this run before trying again.");
      monitor?.refresh();
    } finally { setRequesting(false); }
  };
  return <section aria-label="Execution controls" className="space-y-3 border-y border-gray-200 py-3 text-xs dark:border-gray-700">
    <div className="flex flex-wrap items-center gap-2"><ExecutionStatus status={execution.status} failure={execution.failure} /><span className="break-all font-mono text-[10px] text-gray-500">{execution.id}</span>
      {monitor && <button onClick={monitor.refresh} className="ml-auto min-h-8 px-2 text-primary">Refresh run</button>}
      {canControl && running && execution.readProgress?.profile === "read-progress-v1" && <button disabled={requesting || pending || monitor?.denied} onClick={requestCancel} className="min-h-8 rounded-md border border-gray-300 px-3 disabled:opacity-50 dark:border-gray-700">{pending ? "Cancellation requested" : requesting ? "Requesting…" : "Request cancellation"}</button>}
    </div>
    {pending && <p role="status" className="text-amber-700 dark:text-amber-300">Cancellation is pending. An in-flight read may finish; its saved answer is retained. Further calls stop when the request is observed.</p>}
    {recovery && <p role="status" className="text-amber-700 dark:text-amber-300">Recovery review required. Saved answers are retained; an unconfirmed call may have reached ERP. No automatic retry or replay was performed.</p>}
    {execution.status === "CANCELLED" && <p className="text-gray-500">No further reads will start. Confirmed saved answers remain available; remote processing is not confirmed stopped.</p>}
    {execution.readProgress?.persistence === "memory-only" && <p className="text-gray-500">Memory-only run · checkpoints will not survive server restart.</p>}
    {(error || monitor?.error) && <p role="alert" className="text-amber-700 dark:text-amber-300">{error || monitor.error}{!monitor?.denied && " Displayed answers are the last confirmed snapshot, not fresh status."}</p>}
    {monitor?.reconnecting && <p role="status" className="text-gray-500">Reconnecting run updates automatically. No business operation is being replayed.</p>}
    {!!monitor?.events?.length && <details><summary className="cursor-pointer text-gray-500">Saved run history · {monitor.cursor} events</summary><ol className="mt-2 max-h-56 space-y-2 overflow-auto border-l border-gray-200 pl-3 dark:border-gray-700">{monitor.events.slice(-200).map((event) => <li key={event.sequence}><span className="mr-2 font-mono text-[10px] text-gray-400">{event.sequence}</span>{executionEventLabel(event)}{event.nodeId && <span className="ml-2 font-mono text-[10px]">{event.nodeId}</span>}<time className="ml-2 text-[10px] text-gray-400" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time></li>)}</ol>{monitor.events.length > 200 && <p className="mt-2 text-gray-500">Showing the latest 200 saved events.</p>}</details>}
  </section>;
}
