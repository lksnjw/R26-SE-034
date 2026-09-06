import { useState } from "react";
import CollectionFields from "./CollectionFields";
import ReadableValue from "./ReadableValue";
import NodePrompt from "./NodePrompt";
const button = "rounded-md px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40";
export default function CollectionInspector({ node, canEdit, busy, onPreview, onRemove, sessionId, context, onProposal, sharedChat, onFocusChat, draftStorageKey, authoring }) {
  const [config, setConfig] = useState({ items: node.items, maxItems: node.maxItems, collect: node.collect });
  return <aside aria-label="Selected collection details" className="workspace-reveal mt-5 border-t pt-4"><h4 className="mb-4 text-sm font-semibold">Collection · {node.id}</h4>
    {canEdit ? <><form className="space-y-4" onSubmit={event => { event.preventDefault(); onPreview({ type: "updateCollection", nodeId: node.id, patch: config }, { items: node.items, maxItems: node.maxItems, collect: node.collect }, config); }}><CollectionFields value={config} onChange={setConfig} authoring={authoring} /><button disabled={busy} className={button}>Preview collection edit</button></form>
      {sharedChat ? <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800"><p className="text-xs leading-5 text-gray-500">This collection is selected in the main chat. Change its source list, item limit or collected result; its body and ID stay unchanged.</p>{onFocusChat && <button className={`${button} mt-2 lg:hidden`} disabled={busy} onClick={onFocusChat}>Edit this collection in chat</button>}</div> : sessionId && context && <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} />}</> : <ReadableValue value={config} />}
    <p className="mt-3 text-[10px] text-gray-500">Collection edits are reviewable proposals, not execution. Only confirmed item answers belong to a run. Publication and current ERP permission checks remain separate.</p>
    {canEdit && <><button disabled={busy || node.body.nodes.length > 0} className={`${button} mt-3 text-red-600`} onClick={onRemove}>Remove empty collection…</button>{node.body.nodes.length > 0 && <p className="text-[10px] text-gray-500">Move or remove its contents first; the body is never silently flattened.</p>}</>}
  </aside>;
}
export function CollectionWrapForm({ nodeId, busy, onPreview, onCancel }) {
  const [loopId, setLoopId] = useState("");
  const [config, setConfig] = useState({ items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [] } }, maxItems: 25, collect: { schema: { type: "string" }, value: { kind: "literal", value: "" } } });
  return <form aria-label="Wrap node in collection" className="workspace-reveal mt-5 space-y-4 border-t pt-4" onSubmit={event => { event.preventDefault(); onPreview({ type: "wrapCollection", nodeId, loopId, ...config }, "Existing action", { collection: loopId, ...config, bodyAction: nodeId }); }}>
    <h4 className="text-xs font-medium">Wrap {nodeId} in a collection</h4><input aria-label="Collection ID" value={loopId} onChange={event => setLoopId(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" maxLength={64} placeholder="Unique collection ID" required className="w-full rounded-md border bg-transparent px-3 py-2 text-xs" />
    <CollectionFields value={config} onChange={setConfig} /><p className="text-[10px] text-gray-500">The action is preserved. Explicitly edit its parameters to use the current item; wrapping does not guess mappings or fetch records.</p><button disabled={busy} className={button}>Preview collection wrapper</button><button type="button" className={button} onClick={onCancel}>Cancel wrapper</button>
  </form>;
}
