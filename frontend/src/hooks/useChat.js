import { useCallback, useEffect, useState } from "react";
import { chatService } from "../services/chat.service";

export function useChat(sessionId) {
  const [messages, setMessages] = useState([]);
  const [artifact, setArtifact] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setArtifact(null);
      return;
    }
    let cancelled = false;
    chatService
      .getSession(sessionId)
      .then((session) => {
        if (cancelled) return;
        setMessages(session.messages ?? []);
        const latestArtifact = [...(session.messages ?? [])]
          .reverse()
          .find((message) => message.artifacts)?.artifacts;
        setArtifact(latestArtifact ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.response?.data?.message ?? "Could not load chat");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const send = useCallback(
    async (text, overrideSessionId) => {
      const targetSessionId = overrideSessionId || sessionId;
      if (!targetSessionId || !text.trim()) return null;
      setLoading(true);
      setError("");
      const userMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text: text.trim(),
        createdAt: new Date().toISOString(),
      };
      setMessages((items) => [...items, userMessage]);
      try {
        const result = await chatService.sendMessage(targetSessionId, text.trim());
        setMessages((items) => [
          ...items.filter((item) => item.id !== userMessage.id),
          result.userMessage,
          result.assistantMessage,
        ]);
        setArtifact(result.assistantMessage?.artifacts ?? result);
        return result;
      } catch (err) {
        setMessages((items) => items.filter((item) => item.id !== userMessage.id));
        setError(err?.response?.data?.message ?? "Chat workflow generation failed");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  return { messages, artifact, loading, error, send };
}

export default useChat;
