import ChatHistory from "../../components/chat/ChatHistory";
import ChatWindow from "../../components/chat/ChatWindow";
import FlowPreviewCard from "../../components/chat/FlowPreviewCard";
import YamlPreviewCard from "../../components/chat/YamlPreviewCard";

function ChatPage() {
  return (
    <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_360px]">
      <ChatHistory />
      <ChatWindow />
      <div className="space-y-4">
        <YamlPreviewCard />
        <FlowPreviewCard />
      </div>
    </div>
  );
}

export default ChatPage;
