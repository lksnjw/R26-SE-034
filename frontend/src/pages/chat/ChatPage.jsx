import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import ChatHistory from "../../components/chat/ChatHistory";
import ChatWindow from "../../components/chat/ChatWindow";
import WorkflowWorkspaceCanvas from "../../components/chat/WorkflowWorkspaceCanvas";
import { useAuthContext } from "../../context/AuthContext";
import { workspaceKey, writeWorkspaceValue } from "../../utils/workspaceSession";
import { useChat } from "../../hooks/useChat";
import { useChatSessions } from "../../hooks/useChatSessions";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { peekWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";
import { workflowService } from "../../services/workflow.service";

/*******************************************************************************
 * Function: ChatPage
 *
 * Performs the Chat Page operation on page for the ChatPage module.
 ******************************************************************************/
function ChatPage() {
  const { sessionId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sessions = useChatSessions(sessionId);
  const chat = useChat(sessions.selectedSessionId);
  const { user } = useAuthContext();
  const queryClient = useQueryClient();
  const draftKey = workspaceKey(user, `draft.${sessions.selectedSessionId || "new"}`);
  const [pendingDraftKey, setPendingDraftKey] = useState(null);
  const composerKey = pendingDraftKey || draftKey;
  const [nodeContext, setNodeContext] = useState(null);
  const chatPaneRef = useRef(null);
  const focusChat = useCallback(() => {
    chatPaneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    chatPaneRef.current?.querySelector('textarea[aria-label="Message to workflow assistant"]')?.focus({ preventScroll: true });
  }, []);
  const activeNodeContext = nodeContext?.sessionId === sessions.selectedSessionId ? nodeContext : null;
  const onNodeContext = useCallback((value) => setNodeContext(value), []);
  const onChatChanged = useCallback(async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["chat-session", sessions.selectedSessionId] }), queryClient.invalidateQueries({ queryKey: ["chat-sessions"] })]);
  }, [queryClient, sessions.selectedSessionId]);

  // Auto-create a new session when redirected from "Edit in Chat"
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    const editCtx = peekWorkflowForChatEdit();
    const title = editCtx ? `Edit: ${editCtx.workflowName || "Workflow"}` : "New conversation";
    sessions.createSession(title).then((session) => {
      navigate(`/chat/${encodeURIComponent(session.id)}`, { replace: true });
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateSession = async () => {
    const session = await sessions.createSession("Workflow conversation");
    navigate(`/chat/${encodeURIComponent(session.id)}`);
  };

  const handleSelectSession = (selId) => {
    sessions.setSelectedSessionId(selId);
    navigate(`/chat/${encodeURIComponent(selId)}`);
  };

  const handleDeleteSession = async (delId) => {
    await sessions.deleteSession(delId);
    if (delId === sessionId) navigate("/chat");
  };

  const handleSend = async (text, options = {}) => {
    let sid = sessions.selectedSessionId;
    const creating = !sid;
    if (creating) setPendingDraftKey(draftKey);
    try {
      if (activeNodeContext && sid) {
        const proposal = await workflowService.proposeNode(activeNodeContext.workflowId, activeNodeContext, activeNodeContext.nodeId, text, sid);
        activeNodeContext.onProposal(proposal);
        await onChatChanged();
        writeWorkspaceValue(workspaceKey(user, `draft.${sid}`), "");
        return proposal;
      }
      if (creating) {
        const session = await sessions.createSession(text.slice(0, 64) || "Workflow conversation");
        sid = session.id;
        writeWorkspaceValue(workspaceKey(user, `draft.${sid}`), text);
        navigate(`/chat/${encodeURIComponent(sid)}`);
      }
      const editCtx = peekWorkflowForChatEdit();
      const sendOptions = editCtx?.yaml
        ? { ...options, workflowContext: { yaml: editCtx.yaml, name: editCtx.workflowName || "Workflow" } }
        : options;
      const result = await chat.send(text, sid, sendOptions);
      if (result) writeWorkspaceValue(workspaceKey(user, `draft.${sid}`), "");
      return result;
    } finally {
      if (creating) setPendingDraftKey(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:flex-row">
      <div ref={chatPaneRef} className="flex h-[65svh] min-h-[420px] min-w-0 shrink-0 flex-col border-b border-gray-200 dark:border-gray-700 lg:h-full lg:min-h-0 lg:w-[45%] lg:border-b-0 lg:border-r" data-testid="workspace-chat-pane">
      <details className="shrink-0 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
        <summary className="cursor-pointer text-gray-500">Chats · {sessions.sessions.length}</summary>
        <ChatHistory
          sessions={sessions.sessions}
          activeSessionId={sessions.selectedSessionId}
          onSelect={handleSelectSession}
          onCreate={handleCreateSession}
          onDelete={handleDeleteSession}
          onRename={sessions.renameSession}
          loading={sessions.loading}
          error={sessions.error}
          onRetry={sessions.reload}
        />
      </details>
        <ChatWindow
          key={composerKey || sessions.selectedSessionId || "new"}
          draftStorageKey={composerKey}
          messages={chat.messages}
          onSend={handleSend}
          loading={chat.loading}
          error={chat.error}
          hasMoreMessages={chat.hasMoreMessages}
          loadingMore={chat.loadingMore}
          onLoadMore={chat.loadMore}
          nodeContext={activeNodeContext}
          onClearNodeContext={() => activeNodeContext?.clear()}
        />
      </div>
      <div className="h-[75svh] min-h-[520px] min-w-0 shrink-0 lg:h-full lg:min-h-0 lg:flex-1" data-testid="workspace-canvas-pane">
        <WorkflowWorkspaceCanvas key={draftKey || sessions.selectedSessionId || "new"} messages={chat.messages} sessionId={sessions.selectedSessionId} canEdit={user?.permissions?.includes("workflow:write")} canControl={user?.permissions?.some((key) => ["workflow:run", "workflow:run_own"].includes(key))} onChatChanged={onChatChanged} onNodeContext={onNodeContext} onFocusChat={focusChat} selectionStorageKey={workspaceKey(user, `canvas.${sessions.selectedSessionId || "new"}`)} />
      </div>
    </div>
  );
}

export default ChatPage;
