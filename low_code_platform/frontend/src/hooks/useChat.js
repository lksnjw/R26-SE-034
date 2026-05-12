/**
 * useChat — manages messages + full artifact data per session.
 * The sendMessage API returns data shaped as:
 *  { userMessage, assistantMessage: { id, role, text, artifacts: { ... } } }
 * artifacts holds: blocking_errors, can_execute, candidates,
 *   next_action, retrieval { tools, rules, global_rules, templates, examples },
 *   selected_candidate_id, selected_workflow_yaml, validation_summary
 */
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
        const msgs = session.messages ?? [];
        setMessages(msgs);
        const latestArtifact = [...msgs]
          .reverse()
          .find((m) => m.artifacts)?.artifacts ?? null;
        setArtifact(latestArtifact);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err?.response?.data?.message ?? "Could not load session");
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const send = useCallback(
    async (text, overrideSessionId, options = {}) => {
      const target = overrideSessionId || sessionId;
      if (!target || !text.trim()) return null;

      setLoading(true);
      setError("");

      // Optimistic user bubble
      const tempId = `local-${Date.now()}`;
      const userMsg = { id: tempId, role: "user", text: text.trim(), createdAt: new Date().toISOString() };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const result = await chatService.sendMessage(target, text.trim(), options);
        // result = { userMessage, assistantMessage }
        const assistantMsg = result.assistantMessage;
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== tempId),
          result.userMessage ?? userMsg,
          assistantMsg,
        ]);
        // Expose the full artifacts object from the assistant message
        setArtifact(assistantMsg?.artifacts ?? null);
        return result;
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setError(err?.response?.data?.message ?? "Workflow generation failed");
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
