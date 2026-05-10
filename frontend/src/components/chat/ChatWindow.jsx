import { useState } from "react";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ChatToolbar from "./ChatToolbar";
import ChatWelcome from "./ChatWelcome";
import SuggestedPrompts from "./SuggestedPrompts";

function ChatWindow({ messages, onSend, loading, error }) {
  const [draft, setDraft] = useState("");

  const handleSend = async () => {
    if (!draft.trim()) return;
    await onSend?.(draft.trim());
    setDraft("");
  };

  return (
    <section className="flex min-h-[680px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-darkBackground">
      <ChatToolbar />
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <ChatWelcome />
        {messages.map((message, index) => (
          <ChatMessage key={message.id ?? `${message.role}-${index}`} message={message} />
        ))}
        {error ? <p className="rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
      </div>
      <div className="space-y-3 border-t border-gray-200 p-4 dark:border-gray-800">
        <SuggestedPrompts onSelect={setDraft} />
        <ChatInput value={draft} onChange={setDraft} onSend={handleSend} disabled={loading} />
      </div>
    </section>
  );
}

export default ChatWindow;
