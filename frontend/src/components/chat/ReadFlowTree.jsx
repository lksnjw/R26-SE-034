import { Fragment } from "react";
import ReadableValue from "./ReadableValue";
import IterationNodeEvidence from "../executions/IterationNodeEvidence";

function predicateLabel(predicate) {
  if (predicate.kind === "literal") return predicate.value ? "Yes" : "No";
  const path = predicate.source === "nodeOutput" ? predicate.path.filter((part, index) => index !== 0 || part !== "structuredContent") : predicate.path;
  return [predicate.source === "workflowInput" ? "Workflow input" : `Node ${predicate.nodeId}`, ...path].join(" → ");
}

// Saved compiled structural view, not edge-based execution inference. The
// backend remains the authority for scopes, selection, publication and runs.
export default function ReadFlowTree({ flow, steps, renderAction, decisions = {}, values = {}, valueOutputs = {}, timeline = [], iterations, onSelectCondition, selectedId, renderPlacement, renderMoveHandle }) {
  const definitions = new Map(steps.map((step, index) => [step.id, { step, index }]));
  if (!flow) return <ol className="workspace-flow space-y-4">{steps.map((step, index) => <Fragment key={step.id}>{renderPlacement?.("root", step.id)}{renderAction(step, index)}</Fragment>)}{renderPlacement?.("root", null)}</ol>;
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
      if (node.kind === "protect") return !definitions.has(id) && node.onError?.code === "ERP_RESOURCE_NOT_FOUND" && node.output?.schema && node.output.success && node.output.handled && node.body?.nodes?.length > 0 && valid(node.body, depth + 1) && valid(node.handler, depth + 1);
      return node.kind === "if" && !definitions.has(id) && node.predicate && ["literal", "ref"].includes(node.predicate.kind) && (node.predicate.kind === "literal" ? typeof node.predicate.value === "boolean" : ["workflowInput", "nodeOutput"].includes(node.predicate.source) && (node.predicate.source !== "nodeOutput" || typeof node.predicate.nodeId === "string") && Array.isArray(node.predicate.path) && node.predicate.path.every(part => typeof part === "string")) && valid(node.then, depth + 1) && valid(node.else, depth + 1);
    });
  };
  if (!valid(flow) || steps.some(step => !seen.has(step.id))) return <><p role="alert" className="mb-3 text-xs text-amber-700">Saved structural view could not be confirmed. These are source declarations, not an executable branch layout.</p><ol className="space-y-4">{steps.map(renderAction)}</ol></>;
  const showNode = node => {
    if (node.kind === "action") { const { step, index } = definitions.get(node.nodeId); return renderAction(step, index); }
    const valueReceipt = values[node.id], output = valueOutputs[node.id];
    if (node.kind === "protect") {
      const completion = !iterations && timeline.find(entry => entry.nodeId === node.id && entry.id === `protected_${node.id}` && entry.sideEffect === false && Number.isFinite(Date.parse(entry.completedAt)) &&
        (entry.status === "DONE" && ["SUCCEEDED", "HANDLED_ERROR", "RETURNED"].includes(entry.outcome) || entry.status === "FAILED" && entry.outcome === "FAILED"));
      const saved = completion && ["SUCCEEDED", "HANDLED_ERROR"].includes(completion.outcome) && valueReceipt?.kind === "protect" && valueReceipt.status === "DONE" && valueReceipt.completedAt === completion.completedAt && output && Object.hasOwn(output, "value");
      const outcome = completion ? ({ SUCCEEDED: "Body completed · handler skipped", HANDLED_ERROR: "Handler completed · original read remains failed", RETURNED: "Workflow returned inside this group · no group value", FAILED: "Protected group failed · no replacement answer" })[completion.outcome]
        : valueReceipt?.kind === "protect" && valueReceipt.status === "FAILED" ? "Protected output failed · no replacement answer" : "No protected completion recorded for this snapshot";
      return <li key={node.id}><section aria-label={`Protected group ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery">
        <h4 className="text-xs font-semibold">{onSelectCondition ? <button type="button" aria-label={`Select protected group ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => onSelectCondition(node.id)} className={`workspace-node w-full rounded-md py-2 text-left hover:text-primary focus-visible:outline-primary ${selectedId === node.id ? "text-primary" : ""}`}>Protected group · {node.id}</button> : <>Protected group · {node.id}</>}</h4>
        {renderMoveHandle?.(node.id)}<p className="mt-1 text-[10px] text-gray-500">Body first · handle only reviewed ERP resource-not-found. Unknown calls and safeguard denials are not caught.</p>
        <p className="mt-2 text-[10px] text-gray-500">{outcome}</p>
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">{["body", "handler"].map(scope => <section key={scope} aria-label={`${node.id} protected ${scope}`} className="mt-4 min-w-0 border-l border-gray-200 pl-3 dark:border-gray-700"><h5 className="mb-3 text-[10px] font-medium">{scope === "body" ? "Body" : "Error handler"}</h5>{node[scope].nodes.length || renderPlacement ? show(node[scope], `${node.id}:${scope}`) : <p className="text-[10px] text-gray-500">No handler actions</p>}</section>)}</div>
        {saved && <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700"><p className="mb-1 text-[10px] text-gray-500">Saved protected path value · not an ERP absence proof</p><ReadableValue value={output.value} /></div>}
      </section></li>;
    }
    if (node.kind === "foreach") return <li key={node.id}><section aria-label={`Collection ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery"><h4 className="text-xs font-semibold">{onSelectCondition ? <button type="button" aria-label={`Select collection ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => onSelectCondition(node.id)} className="workspace-node w-full rounded-md py-2 text-left transition-colors hover:text-primary focus-visible:outline-primary">For each · {node.id}</button> : <>For each · {node.id}</>}</h4>
      {renderMoveHandle?.(node.id)}<p className="mt-1 text-[10px] text-gray-500">Maximum {node.maxItems} items · collect {node.collect.schema.type} values. {iterations?.valid ? "Saved per-item evidence belongs to this run snapshot." : "No matching saved item evidence. Check readiness before running."}</p><IterationNodeEvidence key={`${iterations?.executionId}:${node.id}`} model={iterations} nodeId={node.id} /><section aria-label={`${node.id} collection body`} className="mt-3 border-l border-gray-200 pl-3 dark:border-gray-700">{node.body.nodes.length || renderPlacement ? show(node.body, `${node.id}:body`) : <p className="text-[10px] text-gray-500">No body actions</p>}</section></section></li>;
    const savedValue = valueReceipt?.status === "DONE" && valueReceipt.kind === (node.kind === "return" ? "return" : "merge") && output && Object.hasOwn(output, "value");
    if (node.kind === "return") return <li key={node.id}><section aria-label={`Return ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery">
      <h4 className="text-xs font-semibold">{onSelectCondition ? <button type="button" aria-label={`Select return ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => onSelectCondition(node.id)} className={`workspace-node w-full rounded-md py-2 text-left hover:text-primary focus-visible:outline-primary ${selectedId === node.id ? "text-primary" : ""}`}>Return · {node.id}</button> : <>Return · {node.id}</>}</h4>
      {renderMoveHandle?.(node.id)}<p className="mt-1 text-[10px] text-gray-500">Explicit {node.output.schema.type} output · stops later actions on the selected path.</p>
      <IterationNodeEvidence key={`${iterations?.executionId}:${node.id}`} model={iterations} nodeId={node.id} />
      {!iterations && (savedValue ? <div className="mt-2"><p className="mb-1 text-[10px] text-gray-500">Saved workflow return · no tool call</p><ReadableValue value={output.value} /></div> : <p className="mt-2 text-[10px] text-gray-500">{valueReceipt?.status === "FAILED" ? "Return value failed · no result substituted" : "No return recorded for this snapshot"}</p>)}
    </section></li>;
    const receipt = decisions[node.id], selected = receipt?.status === "DONE" && ["then", "else"].includes(receipt.selected) ? receipt.selected : null;
    return <li key={node.id} className="relative"><section aria-label={`Condition ${node.id}`} className="workspace-reveal relative z-10 bg-gray-50 py-2 dark:bg-darkBackgroundVery">
      <h4 className="flex items-center gap-2 text-xs font-semibold"><span aria-hidden="true" data-testid="decision-node-icon" className="h-3 w-3 shrink-0 rotate-45 border border-current text-primary" />{onSelectCondition ? <button type="button" aria-label={`Select condition ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => onSelectCondition(node.id)} className={`workspace-node w-full rounded-md py-2 text-left transition-colors hover:text-primary focus-visible:outline-primary ${selectedId === node.id ? "text-primary" : ""}`}>Decision · {node.id}</button> : <>Decision · {node.id}</>}</h4><p className="mt-1 break-words text-[10px] text-gray-500">{node.predicate.kind === "literal" ? `Literal condition · always chooses ${predicateLabel(node.predicate)}.` : `${predicateLabel(node.predicate)} must be Yes or No.`}</p>
      {renderMoveHandle?.(node.id)}<IterationNodeEvidence key={`${iterations?.executionId}:${node.id}`} model={iterations} nodeId={node.id} />
      <p className="mt-2 text-[10px] text-gray-500">{iterations ? "Branch selection belongs to each saved item; neither path is selected for every item." : selected ? `Recorded decision: ${selected === "then" ? "If yes" : "If no"} · no tool call` : receipt?.status === "FAILED" ? "Condition failed · no branch selected" : "No decision recorded for this snapshot"}</p>
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">{["then", "else"].map(branch => <section key={branch} aria-label={`${node.id} ${branch === "then" ? "If yes" : "If no"}`} className={`mt-4 min-w-0 border-l pl-3 ${selected === branch ? "border-primary" : "border-gray-200 dark:border-gray-700"}`}><h5 className="mb-3 text-[10px] font-medium">{branch === "then" ? "If yes" : "If no"}{selected ? selected === branch ? " · Selected" : " · Not selected" : ""}</h5>{node[branch].nodes.length || renderPlacement ? show(node[branch], `${node.id}:${branch}`) : <p className="text-[10px] text-gray-500">No actions in this path</p>}</section>)}</div>
      {node.merge && !iterations && <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700"><p className="mb-1 text-[10px] text-gray-500">{savedValue ? "Saved selected-branch value · no tool call" : valueReceipt?.status === "FAILED" ? "Branch value failed · no result substituted" : "Explicit branch value · not yet recorded"}</p>{savedValue && <ReadableValue value={output.value} />}</div>}
    </section></li>;
  };
  const show = (block, scopeKey = "root") => <ol className="workspace-flow space-y-4">{block.nodes.map(node => <Fragment key={node.kind === "action" ? node.nodeId : node.id}>{renderPlacement?.(scopeKey, node.kind === "action" ? node.nodeId : node.id)}{showNode(node)}</Fragment>)}{renderPlacement?.(scopeKey, null)}</ol>;
  return show(flow);
}
