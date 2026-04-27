import { useState } from "react";
import { chatMessages } from "../constants/mockData";

export function useChat() {
  const [messages, setMessages] = useState(chatMessages);

  const send = (text) =>
    setMessages((items) => [
      ...items,
      { role: "user", text },
      { role: "assistant", text: "Workflow draft updated." },
    ]);

  return { messages, send };
}

export default useChat;
