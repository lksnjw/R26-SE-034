import { useState } from "react";
import { Icon } from "@iconify/react";
import NodePrompt from "./NodePrompt";
import { SchemaContractFields } from "./ReadValueFields";

const inputClass = "mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground";
const buttonClass = "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800";
const number = (value, fallback) => Number.isInteger(value) ? value : fallback;

export default function AnalysisNodeInspector({ node, canEdit, busy, onPreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring }) {
  const source = node.source;
  const [description, setDescription] = useState(source.description ?? "");
  const [instruction, setInstruction] = useState(source.instruction ?? "");
  const [analysisInput, setAnalysisInput] = useState(source.input ?? "");
  const [dataClass, setDataClass] = useState(source.data_class ?? "internal");
  const [model, setModel] = useState(source.model ?? "");
  const [maxInputItems, setMaxInputItems] = useState(number(source.max_input_items, 200));
  const [maxInputChars, setMaxInputChars] = useState(number(source.max_input_chars, 20000));
  const [maxOutputTokens, setMaxOutputTokens] = useState(number(source.max_output_tokens, 2048));
  const [outputSchema, setOutputSchema] = useState(source.output_schema ?? { type: "object", properties: {}, required: [], additionalProperties: false });
  const sources = authoring?.dataSources ?? [];

  if (!canEdit) return <aside aria-label="Selected analysis details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="flex items-center gap-2"><Icon icon="lucide:brain-circuit" className="h-4 w-4 text-primary" /><h4 className="text-sm font-semibold">Structured analysis · {node.id}</h4></div>
    <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-xs"><dt className="text-gray-500">Instruction</dt><dd>{instruction}</dd><dt className="text-gray-500">Input</dt><dd className="break-all font-mono text-[10px]">{analysisInput}</dd><dt className="text-gray-500">Data class</dt><dd>{dataClass}</dd><dt className="text-gray-500">Model</dt><dd>{model || "Active reviewed provider default"}</dd><dt className="text-gray-500">Limits</dt><dd>{maxInputItems} items · {maxInputChars.toLocaleString()} characters · {maxOutputTokens.toLocaleString()} output tokens</dd></dl>
  </aside>;

  return <aside aria-label="Selected analysis details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="flex items-center gap-2"><Icon icon="lucide:brain-circuit" className="h-4 w-4 text-primary" /><div><h4 className="text-sm font-semibold">Structured analysis · {node.id}</h4><p className="mt-0.5 text-[10px] text-gray-500">One bounded model transformation. It cannot call ERP tools or approve a later action.</p></div></div>
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); onPreview({ description, instruction, input: analysisInput, output_schema: outputSchema,
      data_class: dataClass, model, max_input_items: Number(maxInputItems), max_input_chars: Number(maxInputChars), max_output_tokens: Number(maxOutputTokens) }); }}>
      <label className="block text-xs text-gray-500">Label<input aria-label="Analysis label" className={inputClass} value={description} onChange={event => setDescription(event.target.value)} maxLength={2000} /></label>
      <label className="block text-xs text-gray-500">Instruction<textarea aria-label="Analysis instruction" className={`${inputClass} min-h-24 resize-y leading-5`} value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} required /></label>
      <label className="block text-xs text-gray-500">Acknowledged prior output<input aria-label="Analysis input" className={`${inputClass} font-mono`} list={`analysis-sources-${node.id}`} value={analysisInput} onChange={event => setAnalysisInput(event.target.value)} placeholder="{{prior_node.structuredContent.field}}" maxLength={1000} required /></label>
      <datalist id={`analysis-sources-${node.id}`}>{sources.map(item => <option key={item.expression} value={item.expression}>{item.label}</option>)}</datalist>
      <p className="-mt-2 text-[10px] leading-4 text-gray-500">Use one exact field from an earlier saved node. Workflow input, templates and future outputs are rejected.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-gray-500">Data classification<select aria-label="Analysis data class" className={inputClass} value={dataClass} onChange={event => setDataClass(event.target.value)}><option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option></select></label>
        <label className="block text-xs text-gray-500">Pinned model<input aria-label="Analysis model" className={inputClass} value={model} onChange={event => setModel(event.target.value)} placeholder="Use reviewed provider default" maxLength={256} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-xs text-gray-500">Maximum items<input aria-label="Analysis maximum items" className={inputClass} type="number" min="1" max="10000" value={maxInputItems} onChange={event => setMaxInputItems(event.target.valueAsNumber)} required /></label>
        <label className="block text-xs text-gray-500">Maximum characters<input aria-label="Analysis maximum characters" className={inputClass} type="number" min="1" max="200000" value={maxInputChars} onChange={event => setMaxInputChars(event.target.valueAsNumber)} required /></label>
        <label className="block text-xs text-gray-500">Maximum output tokens<input aria-label="Analysis maximum output tokens" className={inputClass} type="number" min="1" max="8192" value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.valueAsNumber)} required /></label>
      </div>
      <div className="border-t border-gray-100 pt-4 dark:border-gray-800"><SchemaContractFields schema={outputSchema} onChange={setOutputSchema} label="Structured answer contract" /></div>
      <p className="text-[10px] leading-4 text-gray-500">Saving changes only the draft. Publication rechecks the declared prior field and bounds; execution separately checks the reviewed provider origin, model and data class.</p>
      <button disabled={busy} className={buttonClass}><Icon icon="lucide:git-compare-arrows" />Preview analysis edit</button>
    </form>
    {sharedChat ? <p className="mt-5 border-t border-gray-100 pt-4 text-xs leading-5 text-gray-500 dark:border-gray-800">This analysis node is selected in the main chat. Describe the exact instruction, input, schema, classification, model or bound to change; review the proposal before applying it.</p>
      : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} label="Ask the agent about this analysis" placeholder="Change the instruction, prior output, schema, classification, model or bounds…" scopeHelp="Only this analysis node is in scope. The proposal cannot approve egress, publish the workflow or run a later effect." />}
  </aside>;
}
