import { useEffect, useState } from "react";
import { useChat } from "../../hooks/useChat";
import ChatOperationProgress from "./ChatOperationProgress";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";

export default function NodePrompt({ sessionId, context, busy, onProposal, draftStorageKey, label = "Ask the agent about this node", placeholder = "Change this node’s parameters…", scopeHelp = "Only this node is in scope. A proposal is not a save or an execution." }) {
  const chat = useChat(sessionId);
  const [prompt, setPrompt] = useState(() => readWorkspaceValue(draftStorageKey, ""));
  useEffect(() => {
    const proposal = chat.messages.map(message => message.artifacts?.proposal).findLast(item => item?.status === "PROPOSED" &&
      item.workflowId === context.workflowId && item.nodeId === context.nodeId && item.baseVersion === context.baseVersion && item.baseHash === context.baseHash);
    if (proposal) onProposal(proposal);
  }, [chat.messages, context.workflowId, context.nodeId, context.baseVersion, context.baseHash, onProposal]);
  return <div className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-800">
    <form onSubmit={async event => { event.preventDefault(); const result = await chat.send(prompt, undefined, { nodeContext: context }); if (result) { setPrompt(""); writeWorkspaceValue(draftStorageKey, ""); } }}>
      <label className="block text-xs font-medium">{label}<textarea aria-label="Selected node prompt" value={prompt} onChange={event => { setPrompt(event.target.value); writeWorkspaceValue(draftStorageKey, event.target.value); }} className="mt-2 min-h-20 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground" placeholder={placeholder} maxLength={4000} required /></label>
      <button className="mt-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary disabled:opacity-40" disabled={busy || chat.loading || !sessionId || !prompt.trim()}>Propose change</button>
      <p className="mt-2 text-[10px] leading-4 text-gray-500">{scopeHelp}</p>
    </form>
    {chat.error && <p role="alert" className="mt-2 text-xs text-red-600">{chat.error}</p>}
    <div className="mt-3"><ChatOperationProgress operation={chat.operation} events={chat.operationEvents} error={chat.operationError} reconnecting={chat.reconnecting} onCancel={chat.cancelOperation} cancelling={chat.cancelling} onRefresh={chat.refreshOperation} /></div>
  </div>;
}
