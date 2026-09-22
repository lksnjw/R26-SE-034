import { useState } from "react";
import { ReadBindingFields, SchemaContractFields } from "./ReadValueFields";
import ReadableValue from "./ReadableValue";
import NodePrompt from "./NodePrompt";
import { protectedGroupPatchVersion, protectedChatUnavailable } from "./protectedFlow";

export default function ProtectedGroupInspector({ node, canEdit, busy, onPreview, onUnwrap, sessionId, context, onProposal, sharedChat, onFocusChat, draftStorageKey, authoring }) {
  const [output, setOutput] = useState(node.output);
  const chatSupported = authoring?.patchVersion === protectedGroupPatchVersion;
  return <aside aria-label="Selected protected group details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <h4 className="text-sm font-semibold">Protected group · {node.id}</h4>
    <p className="mt-2 text-xs leading-5 text-gray-500">Run the body first. Only a reviewed ERP resource-not-found response can select this handler. Permission denials, uncertain calls and model failures do not select it. The failed read stays failed; a handler answer does not prove the resource is absent.</p>
    <p className="mt-2 text-[10px] text-gray-500">Body: {node.body.nodes.length} direct items · Handler: {node.handler.nodes.length} direct items. Select a child node to edit its configuration separately.</p>
    {canEdit ? <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); onPreview({ output }); }}>
      <SchemaContractFields schema={output.schema} onChange={schema => setOutput({ ...output, schema })} label="Protected output contract" />
      <ReadBindingFields value={output.success} onChange={success => setOutput({ ...output, success })} dataSources={authoring?.outputSources?.success} label="Body success output" />
      <ReadBindingFields value={output.handled} onChange={handled => setOutput({ ...output, handled })} dataSources={authoring?.outputSources?.handled} label="Handled error output" />
      <p className="text-[10px] text-gray-500">Only the completed path exposes {node.id} → value. Handler fault fields are limited to error → code and error → failedNodeId in that handler's scope. The backend validates every mapping; no error grants approval or lowers data sensitivity.</p>
      <button disabled={busy} className="rounded-md px-3 py-2 text-xs font-medium text-primary disabled:opacity-40">Preview protected output edit</button>
    </form> : <div className="mt-3"><ReadableValue value={node.output} /></div>}
    {canEdit && (!chatSupported ? <p className="mt-4 text-xs leading-5 text-amber-700">{protectedChatUnavailable}</p> : sharedChat ? <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800"><p className="text-xs leading-5 text-gray-500">This protected group is selected in the main chat. Change its output contract or body-success / handled-error mappings. Body, handler and error policy stay unchanged.</p>{onFocusChat && <button disabled={busy} className="mt-2 rounded-md px-3 py-2 text-xs text-primary lg:hidden" onClick={onFocusChat}>Edit this group in chat</button>}</div> : sessionId && context && <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} placeholder="Change this group's output mappings…" scopeHelp="Only this group's output contract and success / handled mappings are in scope. Review before Apply; no publication, approval or execution follows." />)}
    {canEdit && <><button disabled={busy || node.handler.nodes.length > 0} onClick={onUnwrap} className="mt-3 rounded-md px-3 py-2 text-xs text-red-600 disabled:opacity-40">Unwrap empty-handler group…</button>
      {node.handler.nodes.length > 0 && <p className="mt-1 text-[10px] text-gray-500">Move or remove handler contents before unwrapping. Neither path is silently deleted.</p>}</>}
  </aside>;
}

export function ProtectedWrapForm({ nodeId, busy, onPreview, onCancel }) {
  const [id, setId] = useState("");
  const [output, setOutput] = useState({ schema: { type: "string" }, success: { kind: "literal", value: "" }, handled: { kind: "literal", value: "" } });
  return <form aria-label="Create protected group" className="mt-4 space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700" onSubmit={event => {
    event.preventDefault(); onPreview({ type: "wrapProtected", nodeIds: [nodeId], protectedId: id, onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output }, `Selected node ${nodeId}`, { group: id, body: [nodeId], handler: "Empty · add or move handler nodes explicitly", output });
  }}>
    <h4 className="text-xs font-semibold">Protect node · {nodeId}</h4>
    <label className="block text-xs text-gray-500">Protected group ID<input aria-label="New protected group ID" className="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-xs dark:border-gray-700" value={id} onChange={event => setId(event.target.value)} required pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" /></label>
    <p className="text-[10px] text-gray-500">Only reviewed ERP resource-not-found is supported. This creates a draft, not a retry rule or permission to run. Add handler nodes separately; the failed body read never becomes successful data.</p>
    <SchemaContractFields schema={output.schema} onChange={schema => setOutput({ ...output, schema })} label="Protected output contract" />
    <ReadBindingFields value={output.success} onChange={success => setOutput({ ...output, success })} label="Body success output" />
    <ReadBindingFields value={output.handled} onChange={handled => setOutput({ ...output, handled })} label="Handled error output" />
    <div className="flex gap-2"><button disabled={busy} className="rounded-md px-3 py-2 text-xs text-primary disabled:opacity-40">Preview new protected group</button><button type="button" onClick={onCancel} className="rounded-md px-3 py-2 text-xs text-gray-500">Cancel protected group</button></div>
  </form>;
}
