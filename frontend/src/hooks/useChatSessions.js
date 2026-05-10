import { useCallback, useEffect, useState } from "react";
import { chatService } from "../services/chat.service";

export function useChatSessions() {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await chatService.listSessions();
      setSessions(items);
      if (!selectedSessionId && items.length > 0) {
        setSelectedSessionId(items[0].id);
      }
    } catch (err) {
      setError(err?.response?.data?.message ?? "Could not load chat sessions");
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  const createSession = useCallback(async (title) => {
    const session = await chatService.createSession(title);
    setSessions((items) => [session, ...items]);
    setSelectedSessionId(session.id);
    return session;
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  return {
    sessions,
    selectedSessionId,
    setSelectedSessionId,
    createSession,
    reload: loadSessions,
    loading,
    error,
  };
}

export default useChatSessions;
