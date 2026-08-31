import { useEffect, useState } from "react";
import ChatHistory from "../../components/chat/ChatHistory";
import ChatWindow from "../../components/chat/ChatWindow";
import WorkflowWorkspaceCanvas from "../../components/chat/WorkflowWorkspaceCanvas";
import { useAuthContext } from "../../context/AuthContext";
import { workspaceKey, writeWorkspaceValue } from "../../utils/workspaceSession";
import { useChat } from "../../hooks/useChat";
import { useChatSessions } from "../../hooks/useChatSessions";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { peekWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";

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
  const draftKey = workspaceKey(user, `draft.${sessions.selectedSessionId || "new"}`);
  const [pendingDraftKey, setPendingDraftKey] = useState(null);
  const composerKey = pendingDraftKey || draftKey;

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
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Session sidebar */}
      <div className="hidden w-48 flex-shrink-0 overflow-y-auto border-r border-gray-200 dark:border-gray-700 xl:block">
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
      </div>

      {/* Chat window */}
      <div className="flex min-h-[420px] min-w-0 flex-1 flex-col lg:min-h-0">
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
        />
      </div>

      <div className="min-h-[320px] shrink-0 border-t border-gray-200 dark:border-gray-700 lg:h-full lg:w-[42%] lg:max-w-[640px] lg:border-l lg:border-t-0">
        <WorkflowWorkspaceCanvas key={draftKey || sessions.selectedSessionId || "new"} messages={chat.messages} selectionStorageKey={workspaceKey(user, `canvas.${sessions.selectedSessionId || "new"}`)} />
      </div>
    </div>
  );
}

export default ChatPage;
