import ReadableValue from "./ReadableValue";

// Typed mapping presentation is shared with selected-condition proposals.
import { contract, mapping } from "./readBindingPreview";
function summary(config, patch, owner) {
  const result = {}, budget = { remaining: 800 };
  if (Object.hasOwn(patch, "items")) result["Source list"] = { Contract: contract(config?.items?.schema), Mapping: mapping(config?.items?.value, owner, budget) };
  if (Object.hasOwn(patch, "maxItems")) result["Maximum items"] = config?.maxItems;
  if (Object.hasOwn(patch, "collect")) result["Collected item"] = { Contract: contract(config?.collect?.schema), Mapping: mapping(config?.collect?.value, owner, budget) };
  return result;
}

export default function CollectionPatchPreview({ proposal }) {
  const patch = proposal.command.patch;
  return <>
    <p className="mt-2 text-[10px] text-gray-500">Only the listed fields change. The collection ID and all actions inside it are preserved.</p>
    <details className="mt-3 text-[10px]"><summary className="cursor-pointer">Before</summary><div className="mt-2 max-h-56 overflow-auto"><ReadableValue value={summary(proposal.before, patch, proposal.nodeId)} /></div></details>
    <p className="mt-3 text-[10px] text-gray-500">After</p><div className="mt-1 max-h-64 overflow-auto"><ReadableValue value={summary(proposal.after, patch, proposal.nodeId)} /></div>
  </>;
}
