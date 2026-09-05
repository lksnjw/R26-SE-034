import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { parseWorkflowPreview } from "./workflowPreview";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";
import "./workflowWorkspace.css";
import ReadableValue, { ReadableResult } from "./ReadableValue";
import ValueFields from "./ValueFields";
import SchemaFields from "./SchemaFields";
import ReadFlowTree from "./ReadFlowTree";
import { useExecutionMonitor } from "../../hooks/useExecutionMonitor";
import ExecutionRunControls from "../executions/ExecutionRunControls";
import { isActiveExecution } from "../../utils/executionEvents";
import NodePrompt from "./NodePrompt";
import ConditionFields, { ScopeSelect, branchDestination, flowConditions, flowReturns } from "./ConditionFields";
import ReadValueFields, { SchemaContractFields, ReadBindingFields } from "./ReadValueFields";
import ReadSimulationPanel from "./ReadSimulationPanel";
import { flowLoops } from "./CollectionFields";
import CollectionInspector, { CollectionWrapForm } from "./CollectionInspector";
import IterationNodeEvidence from "../executions/IterationNodeEvidence";
import { projectIterationEvidence } from "../../utils/iterationEvidence";

const button = "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-800";
const input = "w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground";
const message = (error) => error?.response?.data?.message || error?.message || "The operation could not be completed.";
const emptyTimeline = [];
function ConditionInspector({ node, canEdit, busy, onPreview, onMergePreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring }) {
  const [predicate, setPredicate] = useState(node.predicate);
  const [merge, setMerge] = useState(node.merge || null);
  return <aside aria-label="Selected condition details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <h4 className="mb-4 text-sm font-semibold">Condition · {node.id}</h4>
    {canEdit ? <><form className="space-y-3" onSubmit={event => { event.preventDefault(); onPreview({ predicate }); }}>
      <ConditionFields value={predicate} onChange={setPredicate} dataSources={authoring?.dataSources} /><button disabled={busy} className={`${button} border border-gray-200 dark:border-gray-700`}>Preview condition edit</button>
    </form>{sharedChat ? <p className="mt-4 text-xs text-gray-500">This condition is selected in the main chat. Requests may change its predicate only; branch contents stay unchanged.</p> : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} />}</> : <ReadableValue value={node.predicate} />}
    <p className="mt-3 text-[10px] text-gray-500">If yes: {node.then.nodes.length} direct items · If no: {node.else.nodes.length} direct items. Move actions explicitly to change their scope.</p>
    {canEdit ? <form className="mt-4 space-y-4 border-t pt-4" onSubmit={event => { event.preventDefault(); onMergePreview(merge); }}><h5 className="text-xs font-semibold">Branch output</h5>
      <label className="text-xs text-gray-500"><input type="checkbox" aria-label="Declare branch output" checked={Boolean(merge)} onChange={event => setMerge(event.target.checked ? node.merge || { schema: { type: "string" }, then: { kind: "literal", value: "" }, else: { kind: "literal", value: "" } } : null)} /> Declare one typed output for both paths</label>
      {merge && <><SchemaContractFields schema={merge.schema} onChange={schema => setMerge({ ...merge, schema })} label="Branch output contract" />{["then", "else"].map(branch => <ReadBindingFields key={branch} value={merge[branch]} onChange={value => setMerge({ ...merge, [branch]: value })} dataSources={authoring?.mergeSources?.[branch]} label={`${branch === "then" ? "If yes" : "If no"} output`} />)}</>}
      <p className="text-[10px] text-gray-500">Only the selected path's value is exposed as {node.id} → value. Missing data fails; no default is substituted. A return inside a path bypasses this merge.</p>
      <button disabled={busy} className={button}>Preview branch output edit</button>
    </form> : node.merge && <ReadableValue value={node.merge} />}
  </aside>;
}
function ReturnInspector({ node, canEdit, busy, onPreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring }) {
  const [output, setOutput] = useState(node.output);
  return <aside aria-label="Selected return details" className="workspace-reveal mt-5 border-t pt-4"><h4 className="mb-4 text-sm font-semibold">Return · {node.id}</h4>
    {canEdit ? <><form className="space-y-3" onSubmit={event => { event.preventDefault(); onPreview(output); }}><ReadValueFields value={output} onChange={setOutput} dataSources={authoring?.dataSources} /><button disabled={busy} className={button}>Preview return edit</button></form>
      {sharedChat ? <p className="mt-4 text-xs text-gray-500">This return is selected in the main chat. Requests may change its output only; location and other nodes stay unchanged.</p> : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} />}</> : <ReadableValue value={node.output} />}
    <p className="mt-3 text-[10px] text-gray-500">A confirmed return stops all later actions on the selected path. Skipped actions have no tool answer.</p>
  </aside>;
}
function NodeInspector({ node, canEdit, busy, onPreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring }) {
  const [description, setDescription] = useState(node.source.description ?? "");
  const [action, setAction] = useState(node.source.action ?? "");
  const [parameters, setParameters] = useState(node.source.parameters ?? {});
  const [error, setError] = useState("");
  const tool = !node.source.kind || node.source.kind === "tool";
  const guide = authoring?.actions?.includes(action) ? authoring : null;
  return <aside aria-label="Selected node details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="mb-4 flex items-center gap-2"><Icon icon="lucide:sliders-horizontal" className="h-4 w-4 text-gray-400" /><h4 className="text-sm font-semibold">{node.id}</h4><span className="ml-auto text-[10px] text-gray-400">{node.source.kind || "tool"}</span></div>
    {canEdit ? <>
      <form onSubmit={(event) => { event.preventDefault(); try { onPreview({ description, ...(tool ? { action, parameters } : {}) }); setError(""); } catch (cause) { setError(message(cause)); } }} className="space-y-3">
        <label className="block text-xs text-gray-500">Label<input aria-label="Node label" className={`${input} mt-1`} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} /></label>
        {tool && <><label className="block text-xs text-gray-500">Registered tool<input aria-label="Node tool" className={`${input} mt-1 font-mono`} value={action} onChange={(event) => setAction(event.target.value)} required maxLength={128} /></label>
          <div className="space-y-2"><p className="text-xs text-gray-500">Parameters</p>{guide?.inputSchema ? <><p className="text-[10px] text-gray-500">Registered schema · required fields and scoped data. This is guidance, not live readiness.</p><SchemaFields schema={guide.inputSchema} value={parameters} onChange={setParameters} dataSources={guide.dataSources} /></> : <><p className="text-[10px] text-gray-500">No current supported schema guidance for this tool. Values are preserved; validation decides whether it can run.</p><ValueFields value={parameters} onChange={setParameters} /></>}</div></>}
        <button disabled={busy} className={`${button} border border-gray-200 dark:border-gray-700`}><Icon icon="lucide:git-compare-arrows" />Preview manual edit</button>
      </form>
      {sharedChat ? <p className="mt-5 border-t border-gray-100 pt-4 text-xs leading-5 text-gray-500 dark:border-gray-800">This node is selected for editing in the main chat. Describe your change there; review the returned proposal before applying it.</p> : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} />}
    </> : <ReadableValue value={node.source} />}
    {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
  </aside>;
}

export default function WorkflowWorkspaceEditor({ workflowId, sessionId, canEdit = false, canControl = false, selectionStorageKey, onChatChanged, savedProposals = [], onNodeContext, onFocusChat }) {
  const [record, setRecord] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => readWorkspaceValue(selectionStorageKey ? `${selectionStorageKey}.node` : null, ""));
  const [proposal, setProposal] = useState(null), [undo, setUndo] = useState([]), [redo, setRedo] = useState([]);
  const [resolvedProposals, setResolvedProposals] = useState([]), [notice, setNotice] = useState("");
  const [run, setRun] = useState(null), [timeline, setTimeline] = useState([]), [runInput, setRunInput] = useState({});
  const [submittingRun, setSubmittingRun] = useState(false);
  const [unconfirmedRun, setUnconfirmedRun] = useState(false);
  const monitor = useExecutionMonitor(run?.id, { enabled: run?.readProgress?.profile === "read-progress-v1" || run?.status === "RUNNING" });
  const shownRun = monitor.denied ? null : monitor.execution ?? run;
  const shownTimeline = monitor.denied ? emptyTimeline : monitor.execution ? monitor.timeline : timeline;
  const runActive = isActiveExecution(shownRun?.status);
  const snapshotMatches = shownRun?.workflowSnapshot?.yaml === record?.yaml;
  const [adding, setAdding] = useState(false), [newId, setNewId] = useState(""), [newAction, setNewAction] = useState("");
  const [addScope, setAddScope] = useState("root"), [moveScope, setMoveScope] = useState("root");
  const [conditionMode, setConditionMode] = useState(null), [conditionId, setConditionId] = useState("");
  const [conditionPredicate, setConditionPredicate] = useState({ kind: "literal", value: false }), [conditionBranch, setConditionBranch] = useState("then"), [conditionScope, setConditionScope] = useState("root");
  const [addingReturn, setAddingReturn] = useState(false), [returnId, setReturnId] = useState(""), [returnScope, setReturnScope] = useState("root");
  const [returnOutput, setReturnOutput] = useState({ schema: { type: "string" }, value: { kind: "literal", value: "" } });
  const [wrappingCollection, setWrappingCollection] = useState(false);
  const load = useCallback(async () => { const next = await workflowService.readiness(workflowId); setRecord(next); return next; }, [workflowId]);
  useEffect(() => {
    let active = true;
    workflowService.readiness(workflowId).then((value) => { if (active) setRecord(value); }).catch((cause) => { if (active) setError(message(cause)); });
    executionService.list({ workflowId }).then(async (runs) => {
      const latest = runs.filter((item) => item.workflowId === workflowId).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      if (!latest) return;
      const steps = await executionService.getTimeline(latest.id);
      if (active) { setRun(latest); setTimeline(steps); }
    }).catch(() => { /* Historical output is optional; never fabricate it. */ });
    return () => { active = false; };
  }, [workflowId]);
  const preview = useMemo(() => parseWorkflowPreview(record?.yaml), [record?.yaml]);
  const authoring = record?.authoring?.profile === "read-authoring/v1" && !record.readinessUnknown ? record.authoring : null;
  const iterationModel = useMemo(() => projectIterationEvidence(shownRun, shownTimeline, { yaml: record?.yaml, sourceHash: record?.contentHash, flow: authoring?.controlFlow, steps: preview.steps }), [shownRun, shownTimeline, record?.yaml, record?.contentHash, authoring?.controlFlow, preview.steps]);
  const node = preview.steps.find((step) => step.id === selected);
  const condition = flowConditions(authoring?.controlFlow).find(item => item.id === selected);
  const returnNode = flowReturns(authoring?.controlFlow).find(item => item.id === selected);
  const collection = flowLoops(authoring?.controlFlow).find(item => item.id === selected);
  const nodeId = node?.id || condition?.id || returnNode?.id, nodeLabel = node?.source.description || (condition ? `Condition ${condition.id}` : returnNode ? `Return ${returnNode.id}` : nodeId);
  const version = record?.version, contentHash = record?.contentHash;
  useEffect(() => {
    onNodeContext?.(canEdit && nodeId && contentHash ? { workflowId, sessionId, nodeId, label: nodeLabel, version, contentHash,
      onProposal: setProposal, clear: () => { setSelected(""); writeWorkspaceValue(selectionStorageKey ? `${selectionStorageKey}.node` : null, ""); } } : null);
    return () => onNodeContext?.(null);
  }, [onNodeContext, canEdit, workflowId, sessionId, nodeId, nodeLabel, version, contentHash, selectionStorageKey]);
  const pendingProposal = (proposal && !resolvedProposals.includes(proposal.id) ? proposal : null) || savedProposals.findLast((item) => item.workflowId === workflowId && item.status === "PROPOSED" && item.baseVersion === record?.version && item.baseHash === record?.contentHash && !resolvedProposals.includes(item.id));
  const select = id => { setSelected(id); writeWorkspaceValue(selectionStorageKey ? `${selectionStorageKey}.node` : null, id); setProposal(null); };
  const previewChange = (nodeId, command, before, after) => setProposal({ nodeId, baseVersion: record.version, baseHash: record.contentHash, command, before, after });
  const perform = async (action) => { setBusy(true); setError(""); try { await action(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const save = async (command, history = "edit", revision = record) => {
    const next = await workflowService.command(workflowId, revision, command);
    if (history === "edit") { setUndo((items) => [...items.slice(-19), record.yaml]); setRedo([]); }
    if (revision.proposalId) setResolvedProposals((items) => [...items, revision.proposalId]);
    setRecord({ ...next, readinessUnknown: true }); setProposal(null); setConditionMode(null); setAddingReturn(false); setWrappingCollection(false); setNotice("Draft saved. Publication and execution are separate actions."); onChatChanged?.();
    try { await load(); } catch { setNotice("Draft saved, but readiness could not be refreshed. Reload before publishing or running."); }
  };
  const attemptRun = async () => {
    if (submittingRun || unconfirmedRun || runActive || shownRun?.status === "RECOVERY_REQUIRED") return;
    setSubmittingRun(true); setError(""); setNotice("");
    try {
      const result = await workflowService.run(workflowId, runInput, ...(record.read_job_admission === "read-job-v1" ? [{ mode: "async-read", idempotencyKey: crypto.randomUUID() }] : []));
      setRun(result); setTimeline(await executionService.getTimeline(result.id));
    } catch (cause) {
      const executionId = cause?.response?.data?.meta?.executionId;
      if (executionId) {
        try { const result = await executionService.get(executionId); setRun(result); setTimeline(await executionService.getTimeline(executionId)); }
        catch { setUnconfirmedRun(true); setNotice(`Run ${executionId} was recorded, but its evidence could not be loaded. Open Execution History before starting another run.`); }
      } else if (!cause?.response) { setUnconfirmedRun(true); setNotice("The run response was not received. Its outcome is unconfirmed; check Execution History before starting another run. No automatic retry was sent."); }
      setError(message(cause));
    } finally { setSubmittingRun(false); }
  };
  if (!record) return <div className="p-5"><p className="text-xs text-gray-500">Loading saved workflow…</p>{error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}<button className={button} onClick={() => perform(load)}>Reload</button></div>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="border-b border-gray-200 px-5 py-3 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2"><h3 className="truncate text-sm font-semibold">{preview.name}</h3><span className="shrink-0 font-mono text-[10px] text-gray-500">draft v{record.version}</span></div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500"><span>{record.validation?.passed ? "Validation passed" : "Validation needs attention"}</span><span>{record.published ? "Published snapshot" : "Not published"}</span><span>{record.bridge === "discovery_available" ? "Live tools discovered · preflight required" : "ERP connection unavailable"}</span></div>
      <div className="mt-3 flex flex-wrap items-center gap-1">
        <button className={button} disabled={busy} onClick={() => perform(load)} aria-label="Reload workflow"><Icon icon="lucide:refresh-cw" /></button>
        {canEdit && <><button className={button} aria-label="Undo workflow edit" disabled={busy || !undo.length} onClick={() => perform(async () => { await save({ type: "restoreDraft", yaml: undo.at(-1) }, "undo"); setUndo((items) => items.slice(0, -1)); setRedo((items) => [...items, record.yaml]); })}><Icon icon="lucide:undo-2" /></button>
          <button className={button} aria-label="Redo workflow edit" disabled={busy || !redo.length} onClick={() => perform(async () => { await save({ type: "restoreDraft", yaml: redo.at(-1) }, "redo"); setRedo((items) => items.slice(0, -1)); setUndo((items) => [...items, record.yaml]); })}><Icon icon="lucide:redo-2" /></button>
          <button className={button} disabled={busy} onClick={() => setAdding((value) => !value)}><Icon icon="lucide:plus" />Add node</button>
          <button className={button} disabled={busy || record.readinessUnknown || preview.error} onClick={() => setConditionMode(value => value === "add" ? null : "add")}>Add condition</button>
          <button className={button} disabled={busy || record.readinessUnknown || preview.error} onClick={() => setAddingReturn(value => !value)}>Add return</button>
          <button className={`${button} ml-auto border border-gray-200 dark:border-gray-700`} disabled={busy || record.readinessUnknown || !record.validation?.passed || record.published && record.compilation?.state !== "BLOCKED"} onClick={() => perform(async () => { await workflowService.publish(workflowId, "Explicitly reviewed in chat workspace", record); setNotice("Draft published. Execution has not been requested."); await load(); })}>{record.published && record.compilation?.state === "BLOCKED" ? "Republish reviewed draft" : "Publish reviewed draft"}</button></>}
      </div>
    </div>
    <div className="flex-1 overflow-auto px-5 py-5">
      {notice && <p role="status" className="mb-4 text-xs text-gray-500">{notice}</p>}
      {error && <div role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30">{error}{pendingProposal && <p className="mt-1">Your unsaved proposal is retained. Reload if another edit changed the draft.</p>}</div>}
      {preview.error && <p role="alert" className="text-xs text-amber-700">{preview.error}</p>}
      {!!record.validation?.errors?.length && <details className="mb-4 text-xs"><summary className="cursor-pointer text-amber-700">Validation issues ({record.validation.errors.length})</summary><ul className="mt-2 space-y-1 text-gray-500">{record.validation.errors.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
      {!!record.issues?.length && <details className="mb-4 text-xs" open><summary className="cursor-pointer text-amber-700">Execution readiness issues ({record.issues.length})</summary><ul className="mt-2 space-y-1 text-gray-500">{record.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
      {(shownRun || monitor.denied) && <div className="mb-5"><ExecutionRunControls key={shownRun?.id || "unavailable"} execution={shownRun} canControl={canControl} monitor={monitor} />
        {shownRun && !snapshotMatches && <p className="mt-2 text-[10px] text-gray-500">These answers belong to a different or unverified run snapshot, not the current draft.</p>}
      </div>}
      {adding && <form className="mb-5 space-y-2 border-b border-gray-200 pb-4 dark:border-gray-700" onSubmit={(event) => { event.preventDefault(); perform(async () => { await save({ type: "addNode", node: { id: newId, action: newAction, parameters: {} }, beforeNodeId: null, ...branchDestination(addScope) }); setAdding(false); setNewId(""); setNewAction(""); }); }}>
        <input className={input} aria-label="New node ID" placeholder="Unique node ID" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" value={newId} onChange={(event) => setNewId(event.target.value)} required />
        <input className={input} aria-label="New node tool" placeholder="Exact registered tool name" value={newAction} onChange={(event) => setNewAction(event.target.value)} required />
        {authoring?.controlFlow && <ScopeSelect flow={authoring.controlFlow} value={addScope} onChange={setAddScope} label="New node destination" />}
        <button className={`${button} bg-primary/10 text-primary`} disabled={busy}>Add draft node</button><p className="text-[10px] text-gray-500">Fill required parameters in the inspector. Unavailable tools remain blocked drafts.</p>
      </form>}
      {conditionMode && <form aria-label="Create condition" className="mb-5 space-y-3 border-b border-gray-200 pb-4 dark:border-gray-700" onSubmit={event => {
        event.preventDefault();
        const command = conditionMode === "wrap" && node ? { type: "wrapNode", nodeId: node.id, conditionId, predicate: conditionPredicate, branch: conditionBranch } : { type: "addCondition", conditionId, predicate: conditionPredicate, beforeNodeId: null, ...branchDestination(conditionScope) };
        previewChange(conditionId, command, conditionMode === "wrap" && node ? node.source : "No condition at this destination", { conditionId, predicate: conditionPredicate, placement: conditionMode === "wrap" && node ? `${node.id} → ${conditionBranch === "then" ? "If yes" : "If no"}` : conditionScope === "root" ? "Main sequence end · empty paths" : `${conditionScope.replace(":then", " · If yes").replace(":else", " · If no")} · empty paths` });
      }}>
        <h4 className="text-xs font-semibold">{conditionMode === "wrap" && node ? `Wrap ${node.id} in a condition` : "Create empty condition paths"}</h4>
        <input aria-label="New condition ID" className={input} value={conditionId} onChange={event => setConditionId(event.target.value)} placeholder="Unique stable condition ID" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" required />
        <ConditionFields value={conditionPredicate} onChange={setConditionPredicate} />
        {conditionMode === "wrap" && node ? <select aria-label="Wrapped node branch" className={input} value={conditionBranch} onChange={event => setConditionBranch(event.target.value)}><option value="then">Put selected action in If yes</option><option value="else">Put selected action in If no</option></select> : <ScopeSelect flow={authoring?.controlFlow} value={conditionScope} onChange={setConditionScope} label="New condition destination" />}
        <button className={button} disabled={busy}>Preview new condition</button><button type="button" className={button} onClick={() => setConditionMode(null)}>Cancel condition creation</button>
      </form>}
      <p className="mb-4 text-[10px] leading-4 text-gray-500">{authoring?.controlFlow ? "Structured read flow · exactly one path per boolean condition. Branch outputs remain in scope." : "Source-order flow · conditions and approvals are preserved, not inferred as branch paths."}</p>
      {addingReturn && <form aria-label="Create return" className="mb-5 space-y-3 border-b pb-4" onSubmit={event => { event.preventDefault(); previewChange(returnId, { type: "addReturn", nodeId: returnId, output: returnOutput, beforeNodeId: null, ...branchDestination(returnScope) }, "No return at this destination", { id: returnId, output: returnOutput, destination: returnScope }); }}><h4 className="text-xs font-semibold">Declare workflow return</h4><input aria-label="New return ID" className={input} value={returnId} onChange={event => setReturnId(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" placeholder="Unique stable return ID" required /><ScopeSelect flow={authoring?.controlFlow} value={returnScope} onChange={setReturnScope} label="New return destination" /><ReadValueFields value={returnOutput} onChange={setReturnOutput} /><button disabled={busy} className={button}>Preview new return</button><button type="button" className={button} onClick={() => setAddingReturn(false)}>Cancel return creation</button></form>}
      {iterationModel && !iterationModel.valid && <p role="alert" className="mb-3 text-xs text-amber-700">{iterationModel.error}</p>}
      <ReadFlowTree flow={authoring?.controlFlow} steps={preview.steps} selectedId={selected} onSelectCondition={select} iterations={iterationModel} decisions={!iterationModel && snapshotMatches ? shownRun?.readProgress?.decisions : undefined} values={!iterationModel && snapshotMatches ? shownRun?.readProgress?.values : undefined} valueOutputs={!iterationModel && snapshotMatches ? shownRun?.valueOutputs : undefined} renderAction={(step, index) => {
          const attempt = !iterationModel ? shownTimeline.find((item) => item.nodeId === step.id) : undefined;
          const output = !iterationModel ? shownRun?.stepOutputs?.[step.id] ?? (attempt?.status === "FAILED" ? attempt.output : undefined) : undefined;
          return <li key={step.id} className="relative">
            <button type="button" aria-pressed={node?.id === step.id} onClick={() => select(step.id)} className={`workspace-node relative z-10 flex w-full items-center gap-3 rounded-lg border bg-white px-4 py-3 text-left dark:bg-darkBackground ${node?.id === step.id ? "border-primary ring-1 ring-primary/20" : "border-gray-200 dark:border-gray-700"}`}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gray-50 text-xs text-gray-400 dark:bg-gray-900">{snapshotMatches && attempt?.status === "DONE" ? <Icon icon="lucide:check" /> : snapshotMatches && attempt?.status === "FAILED" ? <Icon icon="lucide:triangle-alert" /> : String(index + 1).padStart(2, "0")}</span>
              <span className="min-w-0 flex-1"><span className="block break-words text-xs font-semibold">{step.source.description || step.id}</span><span className="mt-1 block break-words font-mono text-[10px] text-gray-500">{step.action}</span></span>
              {step.source.condition && <span className="text-[9px] text-gray-500">condition</span>}
              <Icon icon="lucide:chevron-right" className="h-3 w-3 text-gray-400" />
            </button>
            <IterationNodeEvidence key={`${iterationModel?.executionId}:${step.id}`} model={iterationModel} nodeId={step.id} />
            {output !== undefined && <details className="relative z-10 ml-10 mt-2 rounded-md bg-white/80 px-3 py-2 text-[10px] dark:bg-gray-900"><summary className="cursor-pointer">{attempt?.status === "FAILED" ? "Node failure response" : "Node answer"} · run {shownRun.id}</summary><div className="mt-2 max-h-64 overflow-auto"><ReadableResult value={output} /></div></details>}
            {attempt?.status === "FAILED" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-red-600">In this run, this node failed or was blocked. Following nodes were not executed.</p>}
            {attempt?.status === "UNKNOWN" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-amber-700 dark:text-amber-300">Outcome unknown · the read may have reached ERP, but no confirmed answer was saved. No automatic replay.</p>}
            {attempt?.status === "RUNNING" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">{attempt.phase === "DISPATCH_INTENT" ? "Read dispatch recorded · waiting for a saved answer" : "Checking this node before dispatch"}</p>}
            {attempt?.outcome === "NOT_DISPATCHED" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">No dispatch was recorded for this attempt.</p>}
            {attempt?.status === "SKIPPED" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">Skipped in this run · {attempt.outcome === "AFTER_RETURN" ? `workflow returned at ${attempt.returnId}` : "another branch was selected"}. This node was not called and has no answer.</p>}
          </li>;
        }} />
      {node && <><details key={`${node.id}:${record.version}`} open={!onNodeContext} className="mt-5 border-t border-gray-200 pt-3 text-xs dark:border-gray-700"><summary className="cursor-pointer font-medium">Node settings · {node.id}</summary><NodeInspector node={node} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${node.id}` : null} authoring={authoring?.nodes?.find(item => item.nodeId === node.id)} onPreview={(patch) => setProposal({ nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash, command: { type: "updateNode", nodeId: node.id, patch }, before: node.source, after: { ...node.source, ...patch } })} /></details>
        {canEdit && <div className="mt-3 flex flex-wrap gap-1">{onFocusChat && <button className={`${button} text-primary lg:hidden`} onClick={onFocusChat}>Edit this node in chat</button>}{authoring?.controlFlow && <ScopeSelect flow={authoring.controlFlow} value={moveScope} onChange={setMoveScope} label="Move node destination" />}<button className={button} disabled={busy || !authoring?.controlFlow && preview.steps.at(-1)?.id === node.id} onClick={() => perform(() => save({ type: "moveNode", nodeId: node.id, beforeNodeId: null, ...branchDestination(moveScope) }))}>{authoring?.controlFlow ? "Move to selected scope end" : "Move to end"}</button><button className={button} disabled={busy} onClick={() => setConditionMode("wrap")}>Wrap node in condition</button><button className={`${button} text-red-600`} disabled={busy} onClick={() => setProposal({ nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash, command: { type: "removeNode", nodeId: node.id }, before: node.source, after: null })}>Remove node…</button></div>}</>}
      {condition && <><ConditionInspector key={`${condition.id}:${record.version}`} node={condition} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: condition.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${condition.id}` : null} authoring={authoring?.conditions?.find(item => item.nodeId === condition.id)} onPreview={patch => previewChange(condition.id, { type: "updateCondition", nodeId: condition.id, patch }, condition.predicate, patch.predicate)} onMergePreview={merge => previewChange(condition.id, { type: "setConditionMerge", nodeId: condition.id, merge }, condition.merge || "No declared output", merge)} />
        {canEdit && <><button className={`${button} mt-3 text-red-600`} disabled={busy || condition.then.nodes.length > 0 || condition.else.nodes.length > 0} onClick={() => previewChange(condition.id, { type: "removeCondition", nodeId: condition.id }, condition, null)}>Remove empty condition…</button>{(condition.then.nodes.length > 0 || condition.else.nodes.length > 0) && <p className="mt-1 text-[10px] text-gray-500">Move or remove both paths' contents before removing this condition. Nothing is silently flattened.</p>}</>}
      </>}
      {returnNode && <><ReturnInspector key={`${returnNode.id}:${record.version}`} node={returnNode} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: returnNode.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${returnNode.id}` : null} authoring={authoring?.returns?.find(item => item.nodeId === returnNode.id)} onPreview={output => previewChange(returnNode.id, { type: "updateReturn", nodeId: returnNode.id, patch: { output } }, returnNode.output, output)} />{canEdit && <button disabled={busy} className={`${button} mt-3 text-red-600`} onClick={() => previewChange(returnNode.id, { type: "removeReturn", nodeId: returnNode.id }, returnNode, null)}>Remove return…</button>}</>}
      {node && canEdit && <><button className={`${button} mt-3`} disabled={busy || record.readinessUnknown} onClick={() => setWrappingCollection(value => !value)}>Wrap node in collection</button>{wrappingCollection && <CollectionWrapForm key={`${node.id}:${record.version}`} nodeId={node.id} busy={busy} onCancel={() => setWrappingCollection(false)} onPreview={(command, before, after) => previewChange(node.id, command, before, after)} />}</>}
      {collection && <CollectionInspector key={`${collection.id}:${record.version}`} node={collection} canEdit={canEdit} busy={busy} onPreview={(command, before, after) => previewChange(collection.id, command, before, after)} onRemove={() => previewChange(collection.id, { type: "removeCollection", nodeId: collection.id }, collection, null)} />}
      {canEdit && pendingProposal && <section aria-label="Node change preview" className="workspace-reveal mt-5 border-y border-primary/25 py-4">
        <h4 className="text-xs font-semibold">Review change · {pendingProposal.nodeId}</h4><p className="mt-1 text-[10px] text-gray-500">Based on draft v{pendingProposal.baseVersion}. Unrelated nodes are unchanged.</p>
        <details className="mt-3 text-[10px]"><summary className="cursor-pointer">Before</summary><div className="mt-2 max-h-56 overflow-auto"><ReadableValue value={pendingProposal.before} /></div></details>
        <p className="mt-3 text-[10px] text-gray-500">After{pendingProposal.after === null ? " · node will be removed" : ""}</p><div className="mt-1 max-h-64 overflow-auto"><ReadableValue value={pendingProposal.after} /></div>
        {pendingProposal.validation && <p className="mt-2 text-[10px] text-gray-500">{pendingProposal.validation.passed ? "Proposal validation passed · not published" : "Proposal has validation issues · may only be saved as a blocked draft"}</p>}
        <div className="mt-3 flex gap-2"><button className={`${button} bg-primary text-white hover:bg-primary/90`} disabled={busy} onClick={() => perform(() => save(pendingProposal.command, "edit", { version: pendingProposal.baseVersion, contentHash: pendingProposal.baseHash, proposalId: pendingProposal.id }))}>Apply to draft</button><button className={button} disabled={busy} onClick={() => perform(async () => { if (pendingProposal.id) { await workflowService.command(workflowId, record, { type: "discardProposal", proposalId: pendingProposal.id }); setResolvedProposals((items) => [...items, pendingProposal.id]); onChatChanged?.(); } setProposal(null); setNotice("Proposal discarded. The workflow was not changed."); })}>Discard</button></div>
      </section>}
      <details className="mt-6 border-t border-gray-200 pt-4 text-xs dark:border-gray-700"><summary className="cursor-pointer">Run published read workflow</summary><p className="mt-2 text-[10px] text-gray-500">Publish explicitly and verify the connection first. Runtime authorization is rechecked for each call.</p><div className="mt-3">{authoring?.inputSchema ? <SchemaFields label="Run inputs" schema={authoring.inputSchema} value={runInput} onChange={setRunInput} allowReferences={false} /> : <ValueFields label="Run inputs" value={runInput} onChange={setRunInput} />}</div><button className={`${button} mt-2 bg-primary/10 text-primary`} disabled={busy || submittingRun || unconfirmedRun || runActive || shownRun?.status === "RECOVERY_REQUIRED" || !record.can_attempt_run} onClick={attemptRun}><Icon icon="lucide:play" />Run published version</button>{submittingRun && <p role="status" className="mt-2 text-gray-500">{record.read_job_admission === "read-job-v1" ? "Checking and admitting the published read job. Progress appears when its identifier is returned." : "Run request in progress. This synchronous endpoint has not returned its run identifier yet."} Editing a draft does not alter a running snapshot.</p>}{unconfirmedRun && <a href="/executions" className="mt-2 block text-primary">Review execution history · outcome unconfirmed</a>}</details>
      <ReadSimulationPanel workflowId={workflowId} record={record} steps={preview.steps} canControl={canControl} disabled={busy || record.readinessUnknown || Boolean(preview.error)} />
      {shownRun && <div className="mt-4 border-t border-gray-200 pt-3 text-[10px] text-gray-500 dark:border-gray-700"><p>Run {shownRun.id} · {shownRun.status} · published v{shownRun.workflowSnapshot?.version ?? "unknown"}</p><p className="mt-1">Answers belong to this run snapshot, not unsaved edits.</p>{shownRun.agentSummary && <p className="mt-2">{shownRun.agentSummary}</p>}<a href={`/executions/${encodeURIComponent(shownRun.id)}`} className="mt-2 inline-block text-primary">Open full run evidence</a></div>}
      <details className="mt-5 text-xs"><summary className="cursor-pointer">Saved source</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-words text-[10px]">{record.yaml}</pre></details>
      {busy && <p role="status" className="mt-4 text-xs text-gray-500">Working… no completed result is assumed.</p>}
    </div>
  </div>;
}
