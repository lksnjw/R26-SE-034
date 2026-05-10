import ChatHistory from "../../components/chat/ChatHistory";
import ChatWindow from "../../components/chat/ChatWindow";
import FlowPreviewCard from "../../components/chat/FlowPreviewCard";
import YamlPreviewCard from "../../components/chat/YamlPreviewCard";
import { useChat } from "../../hooks/useChat";
import { useChatSessions } from "../../hooks/useChatSessions";

function ChatPage() {
  const sessions = useChatSessions();
  const chat = useChat(sessions.selectedSessionId);

  const handleCreateSession = async () => {
    await sessions.createSession("Workflow conversation");
  };

  const handleSend = async (text) => {
    let sessionId = sessions.selectedSessionId;
    if (!sessionId) {
      const session = await sessions.createSession(text.slice(0, 64) || "Workflow conversation");
      sessionId = session.id;
    }
    return chat.send(text, sessionId);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_360px]">
      <ChatHistory
        sessions={sessions.sessions}
        activeSessionId={sessions.selectedSessionId}
        onSelect={sessions.setSelectedSessionId}
        onCreate={handleCreateSession}
        loading={sessions.loading}
        error={sessions.error}
      />
      <ChatWindow
        messages={chat.messages}
        onSend={handleSend}
        loading={chat.loading}
        error={chat.error}
      />
      <div className="space-y-4">
        <YamlPreviewCard yaml={chat.artifact?.selected_workflow_yaml} />
        <FlowPreviewCard artifact={chat.artifact} />
      </div>
    </div>
  );
}

export default ChatPage;
