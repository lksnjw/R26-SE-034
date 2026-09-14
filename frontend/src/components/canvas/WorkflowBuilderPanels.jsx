import { AlertCircle, CheckCircle2, Zap } from "lucide-react";
import { apiErrorMessage } from "../../services/api";
import ReadableValue from "../chat/ReadableValue";
import BuilderModeControls from "./BuilderModeControls";

function extractReadableData(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw.structuredContent?.data)) return raw.structuredContent.data;
    if (Array.isArray(raw.content) && raw.content[0]?.type === "text") {
      try {
        const parsed = JSON.parse(raw.content[0].text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.data)) return parsed.data;
        return parsed;
      } catch {
        return raw.content[0].text;
      }
    }
    if (Array.isArray(raw.data)) return raw.data;
  }
  if (Array.isArray(raw) && raw.length > 0 && raw[0]?.type === "text") {
    try {
      const parsed = JSON.parse(raw[0].text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.data)) return parsed.data;
      return parsed;
    } catch {
      return raw[0].text;
    }
  }
  return raw;
}

function SmartOutput({ value, maxHeight = "max-h-64" }) {
  const data = extractReadableData(value);
  if (Array.isArray(data) && data.length > 0 && data[0] !== null && typeof data[0] === "object") {
    const keys = Object.keys(data[0]).filter((key) => data[0][key] !== null && data[0][key] !== undefined);
    return (
      <div className={`${maxHeight} space-y-2 overflow-y-auto`}>
        {data.map((item, index) => (
          <div key={index} className="rounded-md border border-slate-200 bg-white p-2.5 text-xs">
            {keys.map((key) => item[key] !== null && item[key] !== undefined ? (
              <div key={key} className="flex gap-2 py-0.5">
                <span className="w-28 shrink-0 font-semibold capitalize text-slate-400">{key.replaceAll("_", " ")}</span>
                <span className="break-all text-slate-800">{String(item[key])}</span>
              </div>
            ) : null)}
          </div>
        ))}
        <p className="pt-1 text-[10px] text-slate-400">{data.length} record{data.length !== 1 ? "s" : ""}</p>
      </div>
    );
  }
  if (typeof data === "string") return <p className="whitespace-pre-wrap text-xs text-slate-700">{data}</p>;
  if (data === null || data === undefined)
    return <p className="text-xs text-slate-500">No output was returned.</p>;
  if (Array.isArray(data)) {
    return (
      <div className={`${maxHeight} space-y-1 overflow-y-auto`}>
        {data.map((item, index) => (
          <div key={index} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
            <ReadableValue value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof data === "object") {
    return (
      <dl className={`${maxHeight} space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3`}>
        {Object.entries(data).map(([key, item]) => (
          <div key={key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 border-b border-slate-100 pb-2 last:border-0 last:pb-0">
            <dt className="text-xs font-semibold capitalize text-slate-400">{key.replaceAll("_", " ")}</dt>
            <dd className="min-w-0 text-xs text-slate-800"><ReadableValue value={item} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <p className="text-xs text-slate-700">{String(data)}</p>
  );
}

export function ExecutionResultPanel({ result, onClose }) {
  if (!result) return null;
  const { execution, timeline } = result;
  const succeeded = execution?.status === "DONE";

  return (
    <aside className="flex h-screen w-80 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-2">
          {succeeded ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <AlertCircle className="h-5 w-5 text-red-500" />}
          <h3 className="text-sm font-black text-slate-900">Execution Result</h3>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Close">✕</button>
      </div>
      <div className="space-y-4 p-4">
        <div className={`rounded-lg border p-3 text-xs ${succeeded ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          <p className={`font-bold uppercase tracking-wide ${succeeded ? "text-emerald-700" : "text-red-700"}`}>{execution?.status ?? "—"}</p>
          <p className="mt-1 font-mono text-[10px] text-slate-500">{execution?.id}</p>
          {(execution?.durationMs ?? 0) > 0 ? <p className="mt-1 text-slate-600">{execution.durationMs} ms</p> : null}
        </div>
        {Array.isArray(timeline) && timeline.length > 0 ? (
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Steps</p>
            <div className="space-y-2">
              {timeline.map((step, index) => (
                <div key={step.nodeId ?? index} className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-semibold text-slate-800">{step.label ?? step.nodeId}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${step.status === "DONE" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{step.status}</span>
                  </div>
                  {step.output ? <div className="mt-1.5"><SmartOutput value={step.output} maxHeight="max-h-24" /></div> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {execution?.finalOutput ? (
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Final Output</p>
            <SmartOutput value={execution.finalOutput} maxHeight="max-h-72" />
          </div>
        ) : null}
        {execution?.stepOutputs && Object.keys(execution.stepOutputs).length > 0 && !execution?.finalOutput ? (
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Step Outputs</p>
            {Object.entries(execution.stepOutputs).map(([stepId, value]) => (
              <div key={stepId} className="mb-3">
                <p className="mb-1 font-mono text-[10px] text-slate-400">{stepId}</p>
                <SmartOutput value={value} maxHeight="max-h-56" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export function CanvasValidationBanner({ result, onClose }) {
  if (!result) return null;
  const passed = result.passed === true;
  return (
    <div role="status" className={`shrink-0 border-b px-6 py-3 text-xs ${passed ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
      <div className="flex items-start justify-between gap-4">
        <div><p className="font-bold">{passed ? "Canvas passed the full validation gate" : "Canvas needs review"}</p>
          <p className="mt-1">{passed ? "Nothing was saved, published or executed." : result.message || "Fix the findings before publication."}</p></div>
        <button type="button" onClick={onClose} className="font-bold underline">Dismiss</button>
      </div>
      {!passed && result.findings?.length ? <ul className="mt-2 list-disc space-y-1 pl-5">{result.findings.slice(0, 8).map((item, index) => (
        <li key={`${item.node_id || "workflow"}-${index}`}>{item.node_id ? `${item.node_id}: ` : ""}{item.message || String(item)}</li>
      ))}</ul> : null}
    </div>
  );
}

export function BuilderHeader({ executionState, isExecuting, isValidating, onValidate, onRun, onDeploy, readOnly, statusCounts, workflow, onEditInChat }) {
  const stateCopy = {
    idle: "Draft · readiness not checked",
    running: "Running workflow",
    success: "Last run succeeded",
    error: "Run stopped with error",
  };
  return (
    <header className="flex h-[76px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-white"><Zap className="h-5 w-5" /></span>
          <div>
            <h1 className="max-w-[520px] truncate text-lg font-black text-slate-950">{workflow?.name || "Agentic Workflow Builder"}</h1>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {stateCopy[executionState]} · {statusCounts.running} running · {statusCounts.success} success · {statusCounts.error} error
            </p>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onEditInChat ? (
          <button type="button" onClick={onEditInChat} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            Edit in Chat
          </button>
        ) : null}
        <BuilderModeControls readOnly={readOnly} isExecuting={isExecuting} isValidating={isValidating} onValidate={onValidate} onDeploy={onDeploy} onRun={onRun} />
      </div>
    </header>
  );
}

export function BuilderLoadState({ embedded, error }) {
  return (
    <div className={`${embedded ? "relative h-full" : "fixed inset-y-0 right-0 left-0 z-50 md:left-16"} grid place-items-center bg-slate-100 p-6 text-center`}>
      <p className={`text-sm font-semibold ${error ? "text-red-600" : "text-slate-500"}`}>
        {error ? apiErrorMessage(error, "Workflow preview unavailable.") : "Loading workflow preview..."}
      </p>
    </div>
  );
}
