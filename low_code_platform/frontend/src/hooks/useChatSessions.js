import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../services/chat.service";
import { useAuthContext } from "../context/AuthContext";
import { authorityScope, captureAuthority, isAuthorityCurrent, staleAuthorityError } from "../utils/authAuthority";
import { chatQueryKeys } from "../utils/chatQueryKeys";

const deniedStatus = error => [401, 403, 404].includes(error?.response?.status);

export function useChatSessions(initialSessionId = "") {
  const queryClient = useQueryClient();
  const { user } = useAuthContext();
  const scope = authorityScope(user);
  const [selection, setSelection] = useState({ scope: "", id: "" });
  // Scope changes only when actor, role, permissions, or epoch changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const capture = useMemo(() => captureAuthority(user), [scope]);
  const query = useQuery({
    queryKey: chatQueryKeys.sessions(scope),
    enabled: Boolean(user && scope),
    queryFn: async ({ signal }) => {
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      const sessions = await chatService.listSessions({ signal });
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      return sessions;
    },
  });
  const sessions = deniedStatus(query.error) ? [] : query.data || [];
  const selectedSessionId = initialSessionId || (selection.scope === scope ? selection.id : "") || sessions[0]?.id || "";

  const setSelectedSessionId = useCallback(id => {
    if (!isAuthorityCurrent(capture)) return;
    setSelection({ scope, id: id || "" });
  }, [capture, scope]);

  const createSession = useCallback(async (title, options) => {
    const request = capture;
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const created = await chatService.createSession(title, options);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const key = chatQueryKeys.sessions(scope);
    await queryClient.cancelQueries({ queryKey: key });
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    queryClient.setQueryData(key, (items = []) => [created, ...items.filter(item => item.id !== created.id)]);
    setSelection({ scope, id: created.id });
    return created;
  }, [capture, queryClient, scope]);

  const deleteSession = useCallback(async sessionId => {
    const request = capture;
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    await chatService.deleteSession(sessionId);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const key = chatQueryKeys.sessions(scope);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: key }),
      queryClient.cancelQueries({ queryKey: chatQueryKeys.session(scope, sessionId) }),
      queryClient.cancelQueries({ queryKey: chatQueryKeys.operations(scope, sessionId) }),
    ]);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    queryClient.setQueryData(key, (items = []) => items.filter(item => item.id !== sessionId));
    queryClient.removeQueries({ queryKey: chatQueryKeys.session(scope, sessionId), exact: true });
    queryClient.removeQueries({ queryKey: chatQueryKeys.operations(scope, sessionId), exact: true });
    if (selection.scope === scope && selection.id === sessionId) setSelection({ scope, id: "" });
  }, [capture, queryClient, scope, selection]);

  const renameSession = useCallback(async (sessionId, title) => {
    const request = capture;
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const updated = await chatService.updateSession(sessionId, title);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const key = chatQueryKeys.sessions(scope);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: key }),
      queryClient.cancelQueries({ queryKey: chatQueryKeys.session(scope, sessionId) }),
    ]);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    queryClient.setQueryData(key, (items = []) => items.map(item => item.id === sessionId ? { ...item, ...updated } : item));
    queryClient.setQueryData(chatQueryKeys.session(scope, sessionId), (current = {}) => ({ ...current, ...updated }));
    return updated;
  }, [capture, queryClient, scope]);

  const refetchSessions = query.refetch;
  const reload = useCallback(async () => {
    if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
    const result = await refetchSessions();
    if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
    return result;
  }, [capture, refetchSessions]);

  return {
    sessions,
    selectedSessionId,
    setSelectedSessionId,
    createSession,
    deleteSession,
    renameSession,
    reload,
    loading: query.isLoading,
    error: query.error,
  };
}

export default useChatSessions;
