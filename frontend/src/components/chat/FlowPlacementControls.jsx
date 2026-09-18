import { useState } from "react";
import { canPlaceNode, insertionPositionValue } from "./flowPlacement";
import ConditionFields from "./ConditionFields";
import ReadValueFields from "./ReadValueFields";

const button = "min-h-8 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-primary/10 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40";
const input = "mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary dark:border-gray-700 dark:bg-darkBackground";
const mime = "application/x-workflow-node";

export function FlowMoveHandle({ entry, revision, disabled, onBegin }) {
  return <button type="button" className={`${button} workspace-move-handle text-gray-500`} aria-label={`Move ${entry.label}`} disabled={disabled} draggable={!disabled}
    onClick={() => onBegin(entry.id)} onDragStart={event => { if (disabled) { event.preventDefault(); return; } event.dataTransfer.setData(mime, JSON.stringify({ nodeId: entry.id, ...revision })); event.dataTransfer.effectAllowed = "move"; onBegin(entry.id); }}>
    <span aria-hidden="true">↕</span> Move
  </button>;
}

export function FlowPlacementPoint({ target, model, moving, revision, disabled, onInsert, onMove }) {
  const [over, setOver] = useState(false);
  const allowed = !disabled && moving && canPlaceNode(model, moving.nodeId, target.key);
  return <li className={`workspace-placement relative z-20 flex flex-wrap items-center gap-1 py-1 ${over && allowed ? "workspace-placement-over" : ""}`} aria-label={`Insertion point · ${target.label}`}
    onDragOver={event => { if (allowed) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(true); } }} onDragLeave={() => setOver(false)}
    onDrop={event => {
      event.preventDefault(); setOver(false);
      if (!allowed) return;
      try {
        const raw = event.dataTransfer.getData(mime);
        if (raw.length > 1024) return;
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Object.keys(value).length !== 4) return;
        if (value.nodeId === moving.nodeId && value.workflowId === revision.workflowId && value.baseVersion === revision.baseVersion && value.baseHash === revision.baseHash) onMove(moving.nodeId, target.key);
      } catch { /* Foreign/malformed drag data does not create a proposal. */ }
    }}>
    <button type="button" className={`${button} text-gray-500`} disabled={disabled} aria-label={`Insert step · ${target.label}`} onClick={() => onInsert(target)}>+ Insert here</button>
    {moving && <button type="button" className={`${button} text-primary`} disabled={!allowed} aria-label={`Place ${moving.nodeId} · ${target.label}`} onClick={() => onMove(moving.nodeId, target.key)}>Place selected step</button>}
  </li>;
}

export function ModelInsertionPosition({ model, value, onChange, label }) {
  return <label className="block text-xs text-gray-500">Insert position<select aria-label={label} className={input} value={value} onChange={event => onChange(event.target.value)} disabled={!model.valid}>
    {model.placements.map(target => <option key={target.key} value={insertionPositionValue(target)}>{target.label}</option>)}
  </select></label>;
}

export function CanvasInsertionForm({ target, disabled, onPreview, onCancel, onModel, allowAnalysis = false, allowAgent = false, allowReturn = true }) {
  const [kind, setKind] = useState("action"), [id, setId] = useState(""), [action, setAction] = useState("");
  const [predicate, setPredicate] = useState({ kind: "literal", value: false });
  const [output, setOutput] = useState({ schema: { type: "string" }, value: { kind: "literal", value: "" } });
  return <form aria-label="Insert canvas step" className="workspace-reveal mb-5 space-y-3 border-y border-primary/25 py-4" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    if (kind === "analysis" || kind === "agent") {
      if (kind === "analysis" ? allowAnalysis : allowAgent) onModel?.(kind, target);
      return;
    }
    if (kind === "return" && !allowReturn) return;
    const placement = { beforeNodeId: target.beforeNodeId, ...(target.destination ? { destination: target.destination } : {}) };
    const command = kind === "action" ? { type: "addNode", node: { id, action, parameters: {} }, ...placement }
      : kind === "if" ? { type: "addCondition", conditionId: id, predicate, ...placement } : { type: "addReturn", nodeId: id, output, ...placement };
    onPreview(id, command, { location: target.label }, { step: id, location: target.label, ...(kind === "action" ? { tool: action, parameters: "Configure required inputs after saving" } : kind === "if" ? { predicate, paths: "New empty If yes / If no paths" } : { output }) });
  }}>
    <h4 className="text-xs font-semibold">Insert step</h4><p className="break-words text-xs text-gray-500">{target.label}</p>
    <label className="block text-xs text-gray-500">Step type<select aria-label="Canvas step type" className={input} value={kind} onChange={event => setKind(event.target.value)}><option value="action">ERP tool action</option><option value="if">Condition · two paths</option>{allowAnalysis && <option value="analysis">Structured analysis</option>}{allowAgent && <option value="agent">Bounded runtime agent</option>}{allowReturn && <option value="return">Workflow return</option>}</select></label>
    {!["analysis", "agent"].includes(kind) && <label className="block text-xs text-gray-500">Stable step ID<input aria-label="Canvas step ID" className={input} value={id} onChange={event => setId(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" maxLength={64} required /></label>}
    {kind === "action" ? <label className="block text-xs text-gray-500">Registered tool<input aria-label="Canvas step tool" className={input} value={action} onChange={event => setAction(event.target.value)} required maxLength={128} /></label> : kind === "if" ? <ConditionFields value={predicate} onChange={setPredicate} /> : kind === "return" ? <ReadValueFields value={output} onChange={setOutput} /> : <p className="text-xs text-gray-500">Continue to the bounded model editor at this exact position. Review its input, answer contract and limits before saving.</p>}
    <p className="text-[10px] text-gray-500">Preview first. Saving creates a draft; publication and execution remain separate.</p>
    <div className="flex flex-wrap gap-2"><button className={`${button} text-primary`} disabled={disabled}>{["analysis", "agent"].includes(kind) ? "Configure model step" : "Preview insertion"}</button><button type="button" className={button} onClick={onCancel}>Cancel insertion</button></div>
  </form>;
}
