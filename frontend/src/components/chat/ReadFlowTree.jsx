function predicateLabel(predicate) {
  if (predicate.kind === "literal") return predicate.value ? "Yes" : "No";
  const path = predicate.source === "nodeOutput" ? predicate.path.filter((part, index) => index !== 0 || part !== "structuredContent") : predicate.path;
  return [predicate.source === "workflowInput" ? "Workflow input" : `Node ${predicate.nodeId}`, ...path].join(" → ");
}

// Saved compiled structural view, not edge-based execution inference. The
// backend remains the authority for scopes, selection, publication and runs.
export default function ReadFlowTree({ flow, steps, renderAction, decisions = {} }) {
  const definitions = new Map(steps.map((step, index) => [step.id, { step, index }]));
  if (!flow) return <ol className="workspace-flow space-y-4">{steps.map(renderAction)}</ol>;
  let count = 0;
  const seen = new Set();
  const valid = (block, depth = 0) => {
    if (depth > 8 || block?.kind !== "sequence" || !Array.isArray(block.nodes)) return false;
    return block.nodes.every(node => {
      if (++count > 300) return false;
      if (!node || typeof node !== "object") return false;
      const id = node.kind === "action" ? node.nodeId : node.id;
      if (typeof id !== "string" || seen.has(id)) return false;
      seen.add(id);
      if (node.kind === "action") return definitions.has(node.nodeId);
      return node.kind === "if" && !definitions.has(id) && node.predicate && ["literal", "ref"].includes(node.predicate.kind) && (node.predicate.kind === "literal" ? typeof node.predicate.value === "boolean" : ["workflowInput", "nodeOutput"].includes(node.predicate.source) && (node.predicate.source !== "nodeOutput" || typeof node.predicate.nodeId === "string") && Array.isArray(node.predicate.path) && node.predicate.path.every(part => typeof part === "string")) && valid(node.then, depth + 1) && valid(node.else, depth + 1);
    });
  };
  if (!valid(flow) || steps.some(step => !seen.has(step.id))) return <><p role="alert" className="mb-3 text-xs text-amber-700">Saved structural view could not be confirmed. These are source declarations, not an executable branch layout.</p><ol className="space-y-4">{steps.map(renderAction)}</ol></>;
  const show = block => <ol className="workspace-flow space-y-4">{block.nodes.map(node => {
    if (node.kind === "action") { const { step, index } = definitions.get(node.nodeId); return renderAction(step, index); }
    const receipt = decisions[node.id], selected = receipt?.status === "DONE" && ["then", "else"].includes(receipt.selected) ? receipt.selected : null;
    return <li key={node.id} className="relative"><section aria-label={`Condition ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery">
      <h4 className="text-xs font-semibold">If · {node.id}</h4><p className="mt-1 break-words text-[10px] text-gray-500">{predicateLabel(node.predicate)} must be Yes or No.</p>
      <p className="mt-2 text-[10px] text-gray-500">{selected ? `Recorded decision: ${selected === "then" ? "If yes" : "If no"} · no tool call` : receipt?.status === "FAILED" ? "Condition failed · no branch selected" : "No decision recorded for this snapshot"}</p>
      {["then", "else"].map(branch => <section key={branch} aria-label={`${node.id} ${branch === "then" ? "If yes" : "If no"}`} className={`mt-4 border-l pl-3 ${selected === branch ? "border-primary" : "border-gray-200 dark:border-gray-700"}`}><h5 className="mb-3 text-[10px] font-medium">{branch === "then" ? "If yes" : "If no"}{selected ? selected === branch ? " · Selected" : " · Not selected" : ""}</h5>{node[branch].nodes.length ? show(node[branch]) : <p className="text-[10px] text-gray-500">No actions in this path</p>}</section>)}
    </section></li>;
  })}</ol>;
  return show(flow);
}
