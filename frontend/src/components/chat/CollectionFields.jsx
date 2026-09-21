import { useState } from "react";
import ReadValueFields from "./ReadValueFields";

export function flowLoops(flow) {
  const result = []; let count = 0;
  const visit = (block, depth) => { if (depth > 8 || !Array.isArray(block?.nodes)) return; for (const node of block.nodes) {
    if (++count > 300) return;
    if (node?.kind === "foreach") { result.push(node); visit(node.body, depth + 1); }
    else if (node?.kind === "if") { visit(node.then, depth + 1); visit(node.else, depth + 1); }
    else if (node?.kind === "protect") { visit(node.body, depth + 1); visit(node.handler, depth + 1); }
  } };
  visit(flow, 0); return result;
}
export function collectionOwners(flow) {
  const result = new Map(); let count = 0;
  const visit = (block, loops, depth) => { if (depth > 8 || !Array.isArray(block?.nodes)) return; for (const node of block.nodes) {
    if (++count > 300) return;
    if (node?.kind === "action") result.set(node.nodeId, loops);
    else if (node?.kind === "foreach") visit(node.body, [...loops, { id: node.id, maxItems: node.maxItems }], depth + 1);
    else if (node?.kind === "if") { visit(node.then, loops, depth + 1); visit(node.else, loops, depth + 1); }
    else if (node?.kind === "protect") { visit(node.body, loops, depth + 1); visit(node.handler, loops, depth + 1); }
  } };
  visit(flow, [], 0); return result;
}
export default function CollectionFields({ value, onChange, authoring }) {
  return <div className="space-y-4"><h5 className="text-xs font-medium">Collection input</h5><ReadValueFields label="Source list" value={value.items} onChange={items => onChange({ ...value, items })} dataSources={authoring?.itemSources} />
    <label className="block text-xs text-gray-500">Maximum items<input aria-label="Maximum collection items" type="number" min={1} max={100} step={1} value={value.maxItems} onChange={event => { const next = event.target.valueAsNumber; if (Number.isInteger(next) && next >= 1 && next <= 100) onChange({ ...value, maxItems: next }); }} className="mt-1 w-full rounded-md border bg-transparent px-3 py-2" /></label>
    <h5 className="text-xs font-medium">Collect one value per completed item</h5><ReadValueFields label="Collected item" value={value.collect} onChange={collect => onChange({ ...value, collect })} dataSources={authoring?.collectSources} />
    <p className="text-[10px] text-gray-500">Input contract must be a list. Inside the body use collection ID → item or index; afterward only collection ID → value is available. Missing data fails. The item limit never silently truncates a larger list; saved-workflow readiness decides whether this collection can run.</p>
  </div>;
}
export function IterationFixturePicker({ nodeId, loops, onAdd, fixtures }) {
  const [indices, setIndices] = useState(() => loops.map(() => 0));
  const address = [...loops.flatMap((loop, index) => [loop.id, String(indices[index])]), nodeId].join("/");
  const valid = loops.every((loop, index) => Number.isInteger(indices[index]) && indices[index] >= 0 && indices[index] < loop.maxItems);
  return <div className="space-y-2 border-l border-gray-200 pl-3"><p className="text-xs font-medium">{nodeId} · per-item test responses</p>{loops.map((loop, index) => <label key={loop.id} className="block text-xs text-gray-500">{loop.id} · item number<input aria-label={`${nodeId} ${loop.id} fixture item number`} type="number" min={1} max={loop.maxItems} step={1} value={Number.isNaN(indices[index]) ? "" : indices[index] + 1} onChange={event => setIndices(old => old.map((value, position) => position === index ? event.target.valueAsNumber - 1 : value))} className="ml-2 w-20 rounded-md border bg-transparent px-2 py-1" /></label>)}
    <button type="button" disabled={!valid || Object.hasOwn(fixtures, address) || Object.keys(fixtures).length >= 1000} className="text-xs text-primary disabled:opacity-40" onClick={() => { if (valid && !Object.hasOwn(fixtures, address)) onAdd(address); }}>Add item response for {nodeId}</button>
    <p className="text-[10px] text-gray-500">Item numbers are explicit test positions, not fetched records. Unused responses are reported.</p>
  </div>;
}
