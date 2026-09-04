import ReadableValue from "./ReadableValue";

function predicateLabel(predicate) {
  if (predicate.kind === "literal") return predicate.value ? "Yes" : "No";
  const path = predicate.source === "nodeOutput" ? predicate.path.filter((part, index) => index !== 0 || part !== "structuredContent") : predicate.path;
  return [predicate.source === "workflowInput" ? "Workflow input" : `Node ${predicate.nodeId}`, ...path].join(" → ");
}

// Saved compiled structural view, not edge-based execution inference. The
// backend remains the authority for scopes, selection, publication and runs.
export default function ReadFlowTree({ flow, steps, renderAction, decisions = {}, values = {}, valueOutputs = {}, onSelectCondition, selectedId }) {
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
      if (node.kind === "return") return !definitions.has(id) && node.output?.schema && typeof node.output.schema === "object" && node.output.value && typeof node.output.value.kind === "string";
      if (node.kind === "foreach") return !definitions.has(id) && node.items?.schema?.type === "array" && node.items.value && node.collect?.schema && node.collect.value && Number.isInteger(node.maxItems) && node.maxItems >= 1 && node.maxItems <= 100 && valid(node.body, depth + 1);
      return node.kind === "if" && !definitions.has(id) && node.predicate && ["literal", "ref"].includes(node.predicate.kind) && (node.predicate.kind === "literal" ? typeof node.predicate.value === "boolean" : ["workflowInput", "nodeOutput"].includes(node.predicate.source) && (node.predicate.source !== "nodeOutput" || typeof node.predicate.nodeId === "string") && Array.isArray(node.predicate.path) && node.predicate.path.every(part => typeof part === "string")) && valid(node.then, depth + 1) && valid(node.else, depth + 1);
    });
  };
  if (!valid(flow) || steps.some(step => !seen.has(step.id))) return <><p role="alert" className="mb-3 text-xs text-amber-700">Saved structural view could not be confirmed. These are source declarations, not an executable branch layout.</p><ol className="space-y-4">{steps.map(renderAction)}</ol></>;
  const show = block => <ol className="workspace-flow space-y-4">{block.nodes.map(node => {
    if (node.kind === "action") { const { step, index } = definitions.get(node.nodeId); return renderAction(step, index); }
    const valueReceipt = values[node.id], output = valueOutputs[node.id];
    if (node.kind === "foreach") return <li key={node.id}><section aria-label={`Collection ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery"><h4 className="text-xs font-semibold">{onSelectCondition ? <button type="button" aria-label={`Select collection ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => onSelectCondition(node.id)} className="workspace-node w-full rounded-md py-2 text-left transition-colors hover:text-primary focus-visible:outline-primary">For each · {node.id}</button> : <>For each · {node.id}</>}</h4>
      <p className="mt-1 text-[10px] text-gray-500">Maximum {node.maxItems} items · collect {node.collect.schema.type} values. Draft simulation only; no real iteration receipts.</p><section aria-label={`${node.id} collection body`} className="mt-3 border-l border-gray-200 pl-3 dark:border-gray-700">{node.body.nodes.length ? show(node.body) : <p className="text-[10px] text-gray-500">No body actions</p>}</section></section></li>;
    const savedValue = valueReceipt?.status === "DONE" && valueReceipt.kind === (node.kind === "return" ? "return" : "merge") && output && Object.hasOwn(output, "value");
    if (node.kind === "return") return <li key={node.id}><section aria-label={`Return ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery">
      <h4 className="text-xs font-semibold">{onSelectCondition ? <button type="button" aria-label={`Select return ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => onSelectCondition(node.id)} className={`workspace-node w-full rounded-md py-2 text-left hover:text-primary focus-visible:outline-primary ${selectedId === node.id ? "text-primary" : ""}`}>Return · {node.id}</button> : <>Return · {node.id}</>}</h4>
      <p className="mt-1 text-[10px] text-gray-500">Explicit {node.output.schema.type} output · stops later actions on the selected path.</p>
      {savedValue ? <div className="mt-2"><p className="mb-1 text-[10px] text-gray-500">Saved workflow return · no tool call</p><ReadableValue value={output.value} /></div> : <p className="mt-2 text-[10px] text-gray-500">{valueReceipt?.status === "FAILED" ? "Return value failed · no result substituted" : "No return recorded for this snapshot"}</p>}
    </section></li>;
    const receipt = decisions[node.id], selected = receipt?.status === "DONE" && ["then", "else"].includes(receipt.selected) ? receipt.selected : null;
    return <li key={node.id} className="relative"><section aria-label={`Condition ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery">
      <h4 className="text-xs font-semibold">{onSelectCondition ? <button type="button" aria-label={`Select condition ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => onSelectCondition(node.id)} className={`workspace-node w-full rounded-md py-2 text-left transition-colors hover:text-primary focus-visible:outline-primary ${selectedId === node.id ? "text-primary" : ""}`}>If · {node.id}</button> : <>If · {node.id}</>}</h4><p className="mt-1 break-words text-[10px] text-gray-500">{predicateLabel(node.predicate)} must be Yes or No.</p>
      <p className="mt-2 text-[10px] text-gray-500">{selected ? `Recorded decision: ${selected === "then" ? "If yes" : "If no"} · no tool call` : receipt?.status === "FAILED" ? "Condition failed · no branch selected" : "No decision recorded for this snapshot"}</p>
      {["then", "else"].map(branch => <section key={branch} aria-label={`${node.id} ${branch === "then" ? "If yes" : "If no"}`} className={`mt-4 border-l pl-3 ${selected === branch ? "border-primary" : "border-gray-200 dark:border-gray-700"}`}><h5 className="mb-3 text-[10px] font-medium">{branch === "then" ? "If yes" : "If no"}{selected ? selected === branch ? " · Selected" : " · Not selected" : ""}</h5>{node[branch].nodes.length ? show(node[branch]) : <p className="text-[10px] text-gray-500">No actions in this path</p>}</section>)}
      {node.merge && <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700"><p className="mb-1 text-[10px] text-gray-500">{savedValue ? "Saved selected-branch value · no tool call" : valueReceipt?.status === "FAILED" ? "Branch value failed · no result substituted" : "Explicit branch value · not yet recorded"}</p>{savedValue && <ReadableValue value={output.value} />}</div>}
    </section></li>;
  })}</ol>;
  return show(flow);
}
