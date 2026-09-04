import { useState } from "react";
import { flowLoops } from "./CollectionFields";

const control = "w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground";
const same = (a, b) => a?.source === b?.source && a?.nodeId === b?.nodeId && JSON.stringify(a?.path) === JSON.stringify(b?.path);

// Explicit predicate editing only; no execution, JSON editor or implicit
// conversion. Unrecognized references are preserved for deliberate repair.
export default function ConditionFields({ value, onChange, dataSources = [] }) {
  const choices = dataSources.filter(source => source.schema?.type === "boolean");
  const match = choices.findIndex(source => same(source.binding, value));
  const [manual, setManual] = useState(false);
  const mode = value.kind === "literal" ? "literal" : !manual && match >= 0 ? "data" : "reference";
  return <div className="space-y-3">
    <label className="block text-xs text-gray-500">Predicate<select aria-label="Condition input mode" className={`${control} mt-1`} value={mode} onChange={event => {
      const next = event.target.value; setManual(next === "reference");
      onChange(next === "literal" ? { kind: "literal", value: false } : next === "data" ? choices[0].binding : value.kind === "ref" ? value : { kind: "ref", source: "workflowInput", path: [] });
    }}><option value="literal">Enter Yes or No</option><option value="data" disabled={!choices.length}>Use in-scope boolean data</option><option value="reference">Enter a reference · validation required</option></select></label>
    {mode === "literal" ? <select aria-label="Condition value" className={control} value={String(value.value)} onChange={event => onChange({ kind: "literal", value: event.target.value === "true" })}><option value="false">No</option><option value="true">Yes</option></select>
      : mode === "data" ? <select aria-label="Condition data source" className={control} value={match} onChange={event => onChange(choices[Number(event.target.value)].binding)}>{choices.map((source, index) => <option key={source.expression || index} value={index}>{source.label} · boolean</option>)}</select>
      : <>
        <select aria-label="Condition reference source" className={control} value={value.source} onChange={event => onChange({ kind: "ref", source: event.target.value, ...(event.target.value === "nodeOutput" ? { nodeId: "" } : {}), path: value.path })}><option value="workflowInput">Workflow input</option><option value="nodeOutput">Earlier action output</option></select>
        {value.source === "nodeOutput" && <input aria-label="Condition source node" className={control} value={value.nodeId || ""} onChange={event => onChange({ ...value, nodeId: event.target.value })} placeholder="Exact earlier in-scope node ID" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" required />}
        <input aria-label="Condition field path" className={control} value={value.path.join(".")} onChange={event => onChange({ ...value, path: event.target.value ? event.target.value.split(".") : [] })} placeholder="Field path, e.g. structuredContent.ready" pattern="[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*" />
        <p className="text-[10px] text-gray-500">This reference is preserved, not confirmed. Scope and actual boolean type are checked by the compiler and runner.</p>
      </>}
    <p className="text-[10px] text-gray-500">Exactly one path is selected at runtime. Missing or non-boolean data fails; it is not treated as No.</p>
  </div>;
}

export function flowConditions(flow) {
  const result = [];
  const visit = (block, depth) => {
    if (depth > 8 || !Array.isArray(block?.nodes) || result.length > 100) return;
    for (const node of block.nodes) if (node?.kind === "if") { result.push(node); visit(node.then, depth + 1); visit(node.else, depth + 1); }
    else if (node?.kind === "foreach") visit(node.body, depth + 1);
  };
  visit(flow, 0); return result;
}
export function flowReturns(flow) {
  const result = [];
  const visit = (block, depth) => {
    if (depth > 8 || !Array.isArray(block?.nodes) || result.length > 100) return;
    for (const node of block.nodes) {
      if (node?.kind === "return") result.push(node);
      if (node?.kind === "if") { visit(node.then, depth + 1); visit(node.else, depth + 1); }
      if (node?.kind === "foreach") visit(node.body, depth + 1);
    }
  };
  visit(flow, 0); return result;
}
export function branchDestination(value) {
  if (!value || value === "root") return {};
  const [conditionId, branch] = value.split(":");
  return { destination: branch === "body" ? { loopId: conditionId, scope: "body" } : { conditionId, branch } };
}
export function ScopeSelect({ flow, value, onChange, label }) {
  return <label className="block text-xs text-gray-500">{label}<select aria-label={label} className={`${control} mt-1`} value={value} onChange={event => onChange(event.target.value)}><option value="root">Main sequence · end</option>{flowConditions(flow).flatMap(node => ["then", "else"].map(branch => <option key={`${node.id}:${branch}`} value={`${node.id}:${branch}`}>{node.id} · {branch === "then" ? "If yes" : "If no"} · end</option>))}{flowLoops(flow).map(node => <option key={`${node.id}:body`} value={`${node.id}:body`}>{node.id} · collection body · end</option>)}</select></label>;
}
