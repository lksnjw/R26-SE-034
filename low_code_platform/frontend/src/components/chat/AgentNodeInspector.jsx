import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import NodePrompt from "./NodePrompt";
import ModelInputFields from "./ModelInputFields";
import ReadableValue from "./ReadableValue";
import { SchemaContractFields } from "./ReadValueFields";

const inputClass = "mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground";
const buttonClass = "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800";
const integer = (value, fallback) => Number.isInteger(value) ? value : fallback;
const predicateType = (value) => value === null ? "null" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";

export default function AgentNodeInspector({ node, canEdit, busy, onPreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring, connections = [] }) {
  const source = node.source, predicate = source.completion_predicate ?? { path: ["complete"], equals: true };
  const [description, setDescription] = useState(source.description ?? "");
  const [instruction, setInstruction] = useState(source.instruction ?? "");
  const [agentInput, setAgentInput] = useState(source.input ?? "");
  const [allowedActions, setAllowedActions] = useState(source.allowed_actions ?? []);
  const [connectionId, setConnectionId] = useState(source.connection_id ?? authoring?.connectionId ?? connections.find(item => item.primary)?.id ?? "erpbridge-default");
  const [dataClass, setDataClass] = useState(source.data_class ?? "internal");
  const [model, setModel] = useState(source.model ?? "");
  const [maxInputItems, setMaxInputItems] = useState(integer(source.max_input_items, 200));
  const [maxInputChars, setMaxInputChars] = useState(integer(source.max_input_chars, 20000));
  const [maxOutputTokens, setMaxOutputTokens] = useState(integer(source.max_output_tokens, 1024));
  const [maxTotalTokens, setMaxTotalTokens] = useState(integer(source.max_total_tokens, 4096));
  const [maxRounds, setMaxRounds] = useState(integer(source.max_rounds, 4));
  const [maxToolCalls, setMaxToolCalls] = useState(integer(source.max_tool_calls, 8));
  const [maxWallTimeMs, setMaxWallTimeMs] = useState(integer(source.max_wall_time_ms, 30000));
  const [outputSchema, setOutputSchema] = useState(source.output_schema ?? { type: "object", properties: {}, required: [], additionalProperties: false });
  const [completionPath, setCompletionPath] = useState((predicate.path ?? []).join("."));
  const [completionType, setCompletionType] = useState(predicateType(predicate.equals));
  const [completionValue, setCompletionValue] = useState(predicate.equals === null ? "" : String(predicate.equals ?? ""));
  const sources = authoring?.dataSources ?? [];
  const actionChoices = useMemo(() => [...new Set([...(source.allowed_actions ?? []), ...(authoring?.actions ?? [])])], [authoring?.actions, source.allowed_actions]);
  const completionEquals = () => completionType === "null" ? null : completionType === "boolean" ? completionValue === "true" : completionType === "number" ? Number(completionValue) : completionValue;

  if (!canEdit) return <aside aria-label="Selected agent details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="flex items-center gap-2"><Icon icon="lucide:bot" className="h-4 w-4 text-primary" /><h4 className="text-sm font-semibold">Bounded runtime agent · {node.id}</h4></div>
    <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-xs"><dt className="text-gray-500">Connection</dt><dd>{connectionId}</dd><dt className="text-gray-500">Task</dt><dd>{instruction}</dd><dt className="text-gray-500">Input</dt><dd><ReadableValue value={agentInput} /></dd><dt className="text-gray-500">Allowed reads</dt><dd>{allowedActions.join(", ")}</dd><dt className="text-gray-500">Completion</dt><dd>{completionPath} equals {String(predicate.equals)}</dd><dt className="text-gray-500">Limits</dt><dd>{maxRounds} rounds · {maxToolCalls} calls · {maxTotalTokens} tokens · {(maxWallTimeMs / 1000).toFixed(0)} seconds · concurrency 1</dd></dl>
  </aside>;

  return <aside aria-label="Selected agent details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="flex items-center gap-2"><Icon icon="lucide:bot" className="h-4 w-4 text-primary" /><div><h4 className="text-sm font-semibold">Bounded runtime agent · {node.id}</h4><p className="mt-0.5 text-[10px] text-gray-500">Dynamic selection is limited to these reviewed reads. Effects remain separate deterministic nodes with independent approval.</p></div></div>
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); onPreview({ description, ...(source.connection_id || connections.length ? { connection_id: connectionId } : {}), instruction, input: agentInput, allowed_actions: allowedActions,
      output_schema: outputSchema, completion_predicate: { path: completionPath.split(".").filter(Boolean), equals: completionEquals() }, data_class: dataClass, model,
      max_input_items: Number(maxInputItems), max_input_chars: Number(maxInputChars), max_output_tokens: Number(maxOutputTokens), max_total_tokens: Number(maxTotalTokens),
      max_rounds: Number(maxRounds), max_tool_calls: Number(maxToolCalls), max_wall_time_ms: Number(maxWallTimeMs), max_concurrency: 1 }); }}>
      <label className="block text-xs text-gray-500">Label<input aria-label="Agent label" className={inputClass} value={description} onChange={event => setDescription(event.target.value)} maxLength={2000} /></label>
      {connections.length > 0 && <label className="block text-xs text-gray-500">ERPBridge connection<select aria-label="Agent ERPBridge connection" className={inputClass} value={connectionId} onChange={event => setConnectionId(event.target.value)}>{connections.map(item => <option key={item.id} value={item.id}>{item.id}{item.primary ? " · primary" : ""}</option>)}</select></label>}
      <label className="block text-xs text-gray-500">Trusted task instruction<textarea aria-label="Agent instruction" className={`${inputClass} min-h-24 resize-y leading-5`} value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} required /></label>
      <ModelInputFields value={agentInput} onChange={setAgentInput} sources={sources} label="Agent input" />
      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-700"><legend className="px-1 text-xs text-gray-500">Exact read-only capability allow-list</legend><div className="mt-1 space-y-2">{actionChoices.map(action => <label key={action} className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={`Allow agent action ${action}`} checked={allowedActions.includes(action)} onChange={() => setAllowedActions(current => current.includes(action) ? current.filter(value => value !== action) : [...current, action])} />{action}</label>)}</div>{!actionChoices.length && <p className="text-[10px] text-amber-700">No reviewed read-only capabilities are available for this node.</p>}</fieldset>
      <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs text-gray-500">Data classification<select aria-label="Agent data class" className={inputClass} value={dataClass} onChange={event => setDataClass(event.target.value)}><option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option></select></label><label className="block text-xs text-gray-500">Pinned model<input aria-label="Agent model" className={inputClass} value={model} onChange={event => setModel(event.target.value)} placeholder="Use reviewed provider default" maxLength={256} /></label></div>
      <div className="grid gap-3 sm:grid-cols-3"><label className="block text-xs text-gray-500">Maximum rounds<input aria-label="Agent maximum rounds" className={inputClass} type="number" min="1" max="8" value={maxRounds} onChange={event => setMaxRounds(event.target.valueAsNumber)} required /></label><label className="block text-xs text-gray-500">Maximum tool calls<input aria-label="Agent maximum tool calls" className={inputClass} type="number" min="0" max="16" value={maxToolCalls} onChange={event => setMaxToolCalls(event.target.valueAsNumber)} required /></label><label className="block text-xs text-gray-500">Maximum wall time (ms)<input aria-label="Agent maximum wall time" className={inputClass} type="number" min="1000" max="120000" step="1000" value={maxWallTimeMs} onChange={event => setMaxWallTimeMs(event.target.valueAsNumber)} required /></label></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="block text-xs text-gray-500">Maximum items<input aria-label="Agent maximum items" className={inputClass} type="number" min="1" max="10000" value={maxInputItems} onChange={event => setMaxInputItems(event.target.valueAsNumber)} required /></label><label className="block text-xs text-gray-500">Maximum characters<input aria-label="Agent maximum characters" className={inputClass} type="number" min="1" max="200000" value={maxInputChars} onChange={event => setMaxInputChars(event.target.valueAsNumber)} required /></label><label className="block text-xs text-gray-500">Per-turn output tokens<input aria-label="Agent maximum output tokens" className={inputClass} type="number" min="1" max="8192" value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.valueAsNumber)} required /></label><label className="block text-xs text-gray-500">Total tokens<input aria-label="Agent maximum total tokens" className={inputClass} type="number" min="1" max="32768" value={maxTotalTokens} onChange={event => setMaxTotalTokens(event.target.valueAsNumber)} required /></label></div>
      <div className="border-t border-gray-100 pt-4 dark:border-gray-800"><SchemaContractFields schema={outputSchema} onChange={setOutputSchema} label="Structured completion contract" /></div>
      <div className="grid gap-3 sm:grid-cols-3"><label className="block text-xs text-gray-500">Completion field path<input aria-label="Agent completion path" className={`${inputClass} font-mono`} value={completionPath} onChange={event => setCompletionPath(event.target.value)} placeholder="complete" required /></label><label className="block text-xs text-gray-500">Comparison type<select aria-label="Agent completion type" className={inputClass} value={completionType} onChange={event => setCompletionType(event.target.value)}><option value="boolean">Boolean</option><option value="string">Text</option><option value="number">Number</option><option value="null">Null</option></select></label><label className="block text-xs text-gray-500">Required value{completionType === "boolean" ? <select aria-label="Agent completion value" className={inputClass} value={completionValue} onChange={event => setCompletionValue(event.target.value)}><option value="true">True</option><option value="false">False</option></select> : completionType === "null" ? <input aria-label="Agent completion value" className={inputClass} value="null" disabled /> : <input aria-label="Agent completion value" className={inputClass} type={completionType === "number" ? "number" : "text"} value={completionValue} onChange={event => setCompletionValue(event.target.value)} required />}</label></div>
      <p className="text-[10px] leading-4 text-gray-500">Concurrency is fixed at one. Saving edits only the draft; publication and execution recheck every capability, provider origin, data class, current role, exact arguments and budget.</p>
      <button disabled={busy || allowedActions.length === 0} className={buttonClass}><Icon icon="lucide:git-compare-arrows" />Preview agent edit</button>
    </form>
    {sharedChat ? <p className="mt-5 border-t border-gray-100 pt-4 text-xs leading-5 text-gray-500 dark:border-gray-800">This agent node is selected in the main chat. Describe one scoped task, allow-list, completion or budget change; review the proposal before applying it.</p>
      : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} label="Ask the agent about this runtime node" placeholder="Change the task, allowed reads, completion contract or bounds…" scopeHelp="Only this bounded agent node is in scope. A proposal cannot add write authority, approve egress, publish or run." />}
  </aside>;
}
