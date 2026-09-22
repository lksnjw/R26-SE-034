import ReadableValue from "./ReadableValue";
import { contract, mapping } from "./readBindingPreview";

function summary(output, owner) {
  const budget = { remaining: 800 };
  return { Contract: contract(output?.schema), "Body succeeds": mapping(output?.success, owner, budget),
    "Error handled": mapping(output?.handled, owner, budget) };
}

export default function ProtectedPatchPreview({ proposal }) {
  // Manual previews contain the output directly; saved chat previews contain the owner.
  const before = proposal.before?.output ?? proposal.before;
  const after = proposal.command.patch.output;
  return <>
    <p className="mt-2 text-[10px] text-gray-500">Only the output contract and mappings change. Group ID, position, error policy, body and handler stay unchanged.</p>
    <details className="mt-3 text-[10px]"><summary className="cursor-pointer">Before</summary><div className="mt-2 max-h-56 overflow-auto"><ReadableValue value={summary(before, proposal.nodeId)} /></div></details>
    <p className="mt-3 text-[10px] text-gray-500">After</p><div className="mt-1 max-h-64 overflow-auto"><ReadableValue value={summary(after, proposal.nodeId)} /></div>
    <p className="mt-2 text-[10px] text-gray-500">These are mappings, not run answers. A handled lookup stays failed and does not prove absence. Return bypasses this output; effects still require independent approval.</p>
  </>;
}
