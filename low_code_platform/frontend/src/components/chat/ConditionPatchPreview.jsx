import ReadableValue from "./ReadableValue";
import { contract, mapping } from "./readBindingPreview";

function summary(node, patch, owner) {
  const result = {}, budget = { remaining: 800 };
  if (Object.hasOwn(patch, "predicate")) result.Condition = mapping(node?.predicate, owner, budget);
  if (Object.hasOwn(patch, "merge")) result["Branch output"] = node?.merge ? {
    Contract: contract(node.merge.schema),
    "If yes": mapping(node.merge.then, owner, budget),
    "If no": mapping(node.merge.else, owner, budget),
  } : "No declared output";
  return result;
}

export default function ConditionPatchPreview({ proposal }) {
  const patch = proposal.command.patch;
  return <>
    <p className="mt-2 text-[10px] text-gray-500">Only the listed condition fields change. Node ID, position and all actions in both paths stay unchanged.</p>
    {patch.merge === null && <p className="mt-2 text-xs text-amber-700">Branch output will be removed. Dependent nodes may become invalid; they are not automatically rewired.</p>}
    <details className="mt-3 text-[10px]"><summary className="cursor-pointer">Before</summary><div className="mt-2 max-h-56 overflow-auto"><ReadableValue value={summary(proposal.before, patch, proposal.nodeId)} /></div></details>
    <p className="mt-3 text-[10px] text-gray-500">After</p><div className="mt-1 max-h-64 overflow-auto"><ReadableValue value={summary(proposal.after, patch, proposal.nodeId)} /></div>
    <p className="mt-2 text-[10px] text-gray-500">A return bypasses the selected branch output. This mapping is not a fetched answer or proof of delivery.</p>
  </>;
}
