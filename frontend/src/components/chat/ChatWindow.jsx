import { useState } from "react";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ChatToolbar from "./ChatToolbar";
import ChatWelcome from "./ChatWelcome";
import SuggestedPrompts from "./SuggestedPrompts";
import { chatMessages } from "../../constants/mockData";

function ChatWindow() {
  const [messages, setMessages] = useState(chatMessages);
  const [draft, setDraft] = useState("");

  const handleSend = () => {
    if (!draft.trim()) return;
    setMessages((items) => [
      ...items,
      { role: "user", text: draft.trim() },
      {
        role: "assistant",
        text: "I created a draft workflow blueprint and updated the YAML preview for review.",
      },
    ]);
    setDraft("");
  };

  return (
    <section className="flex min-h-[680px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-darkBackground">
      <ChatToolbar />
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <ChatWelcome />
        {messages.map((message, index) => (
          <ChatMessage key={`${message.role}-${index}`} message={message} />
        ))}
      </div>
      <div className="space-y-3 border-t border-gray-200 p-4 dark:border-gray-800">
        <SuggestedPrompts onSelect={setDraft} />
        <ChatInput value={draft} onChange={setDraft} onSend={handleSend} />
      </div>
    </section>
  );
}

export default ChatWindow;
