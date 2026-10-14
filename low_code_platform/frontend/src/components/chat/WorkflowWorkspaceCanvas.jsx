import { lazy, Suspense, useMemo, useState } from "react";
import { parseWorkflowPreview, workflowSource } from "./workflowPreview";
import { workflowChoices, selectedWorkflowChoice } from "./workflowChoices";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";
import WorkflowWorkspaceEditor from "./WorkflowWorkspaceEditor";
import ReadableValue from "./ReadableValue";
const ChatArtifactPanel = lazy(() => import("./ChatArtifactPanel"));

export default function WorkflowWorkspaceCanvas({ messages, initialWorkflowContext = null, selectionStorageKey, sessionId, actorId, canEdit = false, canControl = false, onChatChanged, onNodeContext, onFocusChat }) {
  const drafts = useMemo(() => {
    const saved = workflowChoices(messages);
    const workflowId = initialWorkflowContext?.workflowId;
    if (!workflowId || saved.some((draft) => draft.artifact.workflowId === workflowId)) return saved;
    return [{ key: `workflow:${workflowId}`, aliases: [`handoff:${workflowId}`], lastSeen: -1, artifact: { workflowId, ...(initialWorkflowContext.yaml ? { yaml: initialWorkflowContext.yaml } : {}), ...(initialWorkflowContext.selectedNodeId ? { nodeId: initialWorkflowContext.selectedNodeId } : {}) } }, ...saved];
  }, [messages, initialWorkflowContext]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [selection, setSelection] = useState(() => {
    try {
      const stored = JSON.parse(readWorkspaceValue(selectionStorageKey, "{}"));
      return stored && typeof stored === "object" ? stored : {};
    } catch { return {}; }
  });
  const { selectedDraft = "", selectedNode = null } = selection;
  const select = (next) => {
    setSelection(next);
    writeWorkspaceValue(selectionStorageKey, JSON.stringify(next));
  };
  const current = selectedWorkflowChoice(drafts, selectedDraft);
  const yaml = workflowSource(current?.artifact);
  const preview = parseWorkflowPreview(yaml);
  const node = (selectedNode?.draftKey === current?.key || current?.aliases?.includes(selectedNode?.draftKey))
    ? preview.steps.find((step) => step.id === selectedNode.id) : null;
  return (
    <section aria-label="Workflow canvas" className="flex h-full min-h-[320px] flex-col border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-darkBackgroundVery">
      <header className="border-b border-gray-200 px-5 py-3 dark:border-gray-800">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Workflow canvas</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">Steps, decisions and answers</p>
          </div>
          <span className="rounded-full border border-gray-200 px-2.5 py-1 text-[10px] font-medium text-gray-600 dark:border-gray-700 dark:text-gray-300">{current?.artifact.workflowId ? "Saved for review" : "Not running"}</span>
        </div>
        {drafts.length > 0 && (
          <select aria-label="Workflow draft" value={current.key} onChange={(event) => select({ selectedDraft: event.target.value, selectedNode: null })} className="mt-2 w-full rounded border border-gray-200 bg-white p-1 text-xs dark:border-gray-700 dark:bg-darkBackground">
            {drafts.map((draft, index) => <option key={draft.key} value={draft.key}>{draft.artifact.workflowId ? "Workflow" : "Draft"} {index + 1}{draft.artifact.workflowId ? ` · ${draft.artifact.workflowId}` : ""}</option>)}
          </select>
        )}
      </header>
      {current?.artifact.workflowId ? <WorkflowWorkspaceEditor key={current.artifact.workflowId} workflowId={current.artifact.workflowId} sessionId={sessionId} actorId={actorId} simple canEdit={canEdit} canControl={canControl} initialSelectedNodeId={current.artifact.nodeId ?? current.artifact.proposal?.nodeId ?? ""} selectionStorageKey={selectionStorageKey} onChatChanged={onChatChanged} onNodeContext={onNodeContext} onFocusChat={onFocusChat} savedProposals={messages.map((item) => item.artifacts?.proposal).filter(Boolean)} /> : <div className="flex-1 overflow-y-auto px-5 py-6">
        {!current ? (
          <div className="mx-auto max-w-sm py-12 text-center">
            <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold text-primary">1</div>
            <h3 className="text-lg font-semibold">Your workflow starts here</h3>
            <p className="mt-3 text-sm leading-6 text-gray-500">Describe an outcome in chat. A draft will appear here so you can review each step before publishing or running it.</p>
            <p className="mt-5 text-xs text-gray-500">ERP tools will remain blocked until the workspace connection is verified.</p>
          </div>
        ) : (
          <>
            <h3 className="mb-2 text-base font-semibold">{preview.name ?? "Workflow draft"}</h3>
            <p className="mb-5 text-xs leading-5 text-gray-500">Review the steps in order. Open a step to see what it uses; advanced source and generation details stay available below.</p>
            {preview.error && <p role="alert" className="mb-4 text-sm text-amber-700 dark:text-amber-400">{preview.error}</p>}
            <ol className="space-y-3">
              {preview.steps.map((step, index) => (
                <li key={step.id}>
                  <button type="button" aria-pressed={node?.id === step.id} onClick={() => select({ selectedDraft: current.key, selectedNode: { draftKey: current.key, id: step.id } })} className={`flex w-full items-start gap-3 rounded-lg border bg-white p-3 text-left dark:bg-darkBackground ${node?.id === step.id ? "border-primary ring-1 ring-primary" : "border-gray-200 dark:border-gray-700"}`}>
                    <span className="font-mono text-xs text-gray-400">{String(index + 1).padStart(2, "0")}</span>
                    <span className="min-w-0"><span className="block break-words text-sm font-medium">{step.label}</span><span className="mt-1 block break-words text-xs text-gray-500">ERP step · select to review or edit</span></span>
                  </button>
                </li>
              ))}
            </ol>
            {node && <aside aria-label="Selected node details" className="mt-5 border-t border-gray-200 pt-4 dark:border-gray-700"><h4 className="mb-3 text-sm font-semibold">{node.label}</h4><ReadableValue value={node.source} /><p className="mt-3 text-xs text-gray-500">Read-only preview. Save this workflow before requesting a scoped node change.</p></aside>}
            <details className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700"><summary className="cursor-pointer text-xs font-medium">Technical workflow source</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-words text-xs">{yaml}</pre></details>
            <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
              <button type="button" aria-expanded={showDiagnostics} onClick={() => setShowDiagnostics((value) => !value)} className="text-xs font-medium">{showDiagnostics ? "Hide" : "Show"} generation details</button>
              {showDiagnostics && <div className="mt-3"><p className="mb-3 text-xs text-gray-500">Returned generation checks are not live ERP readiness or execution approval.</p><Suspense fallback={<p className="text-xs">Loading generation details…</p>}><ChatArtifactPanel artifact={current.artifact} /></Suspense></div>}
            </div>
          </>
        )}
      </div>}
    </section>
  );
}
