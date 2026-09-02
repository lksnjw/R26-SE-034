import { ReadableResult } from "./ReadableValue";
import { isActiveChatOperation } from "../../hooks/useChatOperationMonitor";

const stages = {
  QUEUED: "Queued", PREPARING: "Checking request", MODEL: "Assistant analysis",
  GENERATING: "Preparing workflow proposal", DRAFT_SAVED: "Workflow draft saved", VERIFYING: "Verifying ERP read",
  READING: "Waiting for ERPBridge", READ_SAVED: "Confirmed read saved", READ_STOPPED: "Read stopped",
  ANSWERED: "Response saved", FAILED: "Preparation stopped", CANCELLED: "Cancelled",
  RECOVERY_REQUIRED: "Recovery review required",
};
const attempts = { PREPARING: "Preparing", DISPATCH_INTENT: "Dispatched · awaiting confirmation", DONE: "Confirmed result saved", FAILED: "Failed", UNKNOWN: "Outcome unconfirmed · do not replay" };
const toolLabel = name => name.replace(/[_-]+/g, " ");

export default function ChatOperationProgress({ operation, events = [], error, reconnecting, onCancel, cancelling, onRefresh }) {
  if (!operation && !error) return null;
  const active = operation && isActiveChatOperation(operation.status);
  return <section aria-label="Saved chat progress" className="border-l-2 border-primary/30 pl-3 text-xs leading-5 text-gray-600 dark:text-gray-300">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p role="status" className="font-semibold text-gray-900 dark:text-white">{reconnecting ? "Reconnecting · last saved progress" : stages[operation?.stage] || "Saved operation progress"}</p>
        {operation && <p className="text-[11px] text-gray-500">{operation.modelBinding?.requestedModel || operation.modelBinding?.model || "No model bound"} · {operation.persistence === "durable" ? "Saved on server" : "Memory only · lost on server restart"}</p>}
      </div>
      {active && <button type="button" disabled={cancelling || operation.cancellationRequested} onClick={onCancel} className="shrink-0 text-xs text-primary underline disabled:opacity-50">{cancelling || operation.cancellationRequested ? "Cancel requested" : "Cancel request"}</button>}
    </div>
    {operation?.cancellationRequested && <p className="mt-1">Cancellation does not prove that remote work was rolled back.</p>}
    {operation?.status === "RECOVERY_REQUIRED" && <p className="mt-1">Processing stopped with an uncertain or interrupted outcome. Review saved evidence before starting a new request; nothing will be replayed automatically.</p>}
    {operation?.status === "FAILED" && <p className="mt-1">The request stopped before a response could be saved. Check connection and permissions before submitting a new request.</p>}
    {operation?.status === "ANSWERED" && <p className="mt-1">A saved response is not proof of email delivery, workflow execution or scheduling.</p>}
    {operation?.artifactRefs?.map(reference => <p key={reference.id} className="mt-1">Workflow draft saved · {reference.id}. Find it in Workflows; it has not been published or executed.</p>)}
    {operation?.attempts?.length > 0 && <div className="mt-2 space-y-2">{operation.attempts.map(attempt => <details key={attempt.id} className="border-t border-gray-100 pt-2 dark:border-gray-800">
      <summary className="cursor-pointer"><span className="font-medium">{toolLabel(attempt.toolName)}</span> · {attempts[attempt.status] || "Unknown status"}</summary>
      <div className="mt-2">{["DONE", "FAILED"].includes(attempt.status) && attempt.output !== undefined ? <ReadableResult value={attempt.output} /> : <p>{attempt.status === "UNKNOWN" ? "No confirmed answer is available. An automatic retry could duplicate remote work." : "No confirmed result has been saved for this attempt."}</p>}</div>
    </details>)}</div>}
    {events.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-gray-500">Recorded stages · {events.length}</summary><ol className="mt-1 space-y-1">{events.slice(-20).map(event => <li key={event.sequence}>{stages[event.stage] || "Saved stage"} <time className="text-gray-500" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time></li>)}</ol>{events.length > 20 && <p className="text-gray-500">Showing the latest 20 recorded stages.</p>}</details>}
    {error && <p role="alert" className="mt-2">{error}</p>}
    {onRefresh && <button type="button" onClick={onRefresh} className="mt-2 text-xs text-primary underline">Refresh saved progress</button>}
  </section>;
}
