import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../services/chat.service";
import { useAuthContext } from "../context/AuthContext";
import { acknowledgeChatCommand, prepareChatCommand } from "../utils/chatCommand";
import { isActiveChatOperation, useChatOperationMonitor } from "./useChatOperationMonitor";

/*******************************************************************************
 * Function: useChat
 *
 * Provides chat for the useChat module.
 ******************************************************************************/
export function useChat(sessionId) {
  const queryClient = useQueryClient();
  const { user } = useAuthContext();
  const [identityFailure, setIdentityFailure] = useState(null);
  const operations = useQuery({
    queryKey: ["chat-operations", sessionId, user?.id, user?.role, user?.permissions],
    queryFn: () => chatService.operations(sessionId),
    enabled: Boolean(sessionId && user),
    refetchInterval: 15000,
  });
  const latestOperation = operations.data?.[0];
  const monitor = useChatOperationMonitor(latestOperation?.id, { scope: JSON.stringify([user?.id, user?.role, user?.permissions]) });
  const operation = monitor.denied ? null : monitor.operation || latestOperation || null;
  const operationId = operation?.id, operationStatus = operation?.status, assistantMessageId = operation?.assistantMessageId;
  useEffect(() => {
    if (assistantMessageId || (operationId && !isActiveChatOperation(operationStatus))) {
      void queryClient.invalidateQueries({ queryKey: ["chat-session", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
    }
  }, [queryClient, sessionId, operationId, operationStatus, assistantMessageId]);
  const cancelMutation = useMutation({
    mutationFn: id => chatService.cancelOperation(id),
    onSuccess: () => { monitor.refresh(); void operations.refetch(); },
  });
/*******************************************************************************
 * Function: session
 *
 * Performs the session operation on the application for the useChat module.
 ******************************************************************************/
  const session = useQuery({
    queryKey: ["chat-session", sessionId],
    queryFn: () => chatService.getSession(sessionId),
    enabled: Boolean(sessionId),
  });
/*******************************************************************************
 * Function: sendMutation
 *
 * Performs the send Mutation operation on mutation for the useChat module.
 ******************************************************************************/
  const sendMutation = useMutation({
    mutationFn: ({ target, text, options }) => chatService.sendMessage(target, text, options),
    onSuccess: async (result, variables) => {
      // Fence pre-admission reads before installing the newer acknowledgement.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["chat-session", variables.target] }),
        queryClient.cancelQueries({ queryKey: ["chat-operations", variables.target] }),
      ]);
      queryClient.setQueryData(["chat-session", variables.target], (current = {}) => ({
        ...current,
        ...(result.session || {}),
        messages: [...new Map([...(current.messages || []), result.userMessage, result.assistantMessage].filter(Boolean).map(message => [message.id, message])).values()],
      }));
      if (variables.command) acknowledgeChatCommand(variables.command);
      if (result.operation) {
        queryClient.setQueryData(["chat-operations", variables.target, user?.id, user?.role, user?.permissions], (current = []) => [result.operation, ...current.filter(entry => entry.id !== result.operation.id)]);
      }
      void queryClient.invalidateQueries({ queryKey: ["chat-operations", variables.target] });
      queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
    },
  });

  // Reset send-error when the active session changes so stale errors don't bleed into other sessions.
  const resetSend = sendMutation.reset;
  useEffect(() => { resetSend(); }, [sessionId, resetSend]);

  const [loadingMore, setLoadingMore] = useState(false);
/*******************************************************************************
 * Function: loadMore
 *
 * Fetches the next-older page of messages and prepends them to the
 * currently loaded window, instead of ever loading a session's full
 * history in one request.
 ******************************************************************************/
  const loadMore = useCallback(async () => {
    const current = queryClient.getQueryData(["chat-session", sessionId]);
    const oldest = current?.messages?.[0];
    if (!sessionId || !oldest || !current?.hasMoreMessages || loadingMore) return;
    setLoadingMore(true);
    try {
      const older = await chatService.getSession(sessionId, { before: oldest.id });
      queryClient.setQueryData(["chat-session", sessionId], (curr = {}) => ({
        ...curr,
        messages: [...(older.messages || []), ...(curr.messages || [])],
        hasMoreMessages: Boolean(older.hasMoreMessages),
      }));
    } finally {
      setLoadingMore(false);
    }
  }, [queryClient, sessionId, loadingMore]);

/*******************************************************************************
 * Function: send
 *
 * Performs the send operation on the application for the useChat module.
 ******************************************************************************/
  const send = useCallback(async (text, overrideSessionId, options = {}) => {
    const target = overrideSessionId || sessionId;
    if (!target || !text.trim()) return null;
    setIdentityFailure(null);
    let command;
    try { command = options.emailDraftCommand ? null : await prepareChatCommand(user, target, text.trim(), options); }
    catch (error) { setIdentityFailure({ target, message: error.message }); return null; }
    try {
      // Local email-draft edits keep their revision-bound synchronous command.
      return await sendMutation.mutateAsync({ target, text: text.trim(), command, options: command ? { ...options, delivery: "async-chat", idempotencyKey: command.key } : options });
    } catch (error) {
      if (!error?.response) setIdentityFailure({ target, message: "Acknowledgement was not confirmed. Your draft is kept. Retry the same message to retrieve its saved operation; it will not be admitted twice." });
      void queryClient.invalidateQueries({ queryKey: ["chat-operations", target] });
      return null;
    }
  }, [sendMutation, sessionId, user, queryClient]);

/*******************************************************************************
 * Function: messages
 *
 * Performs the messages operation on the application for the useChat module.
 ******************************************************************************/
  const messages = useMemo(() => session.data?.messages || [], [session.data?.messages]);
/*******************************************************************************
 * Function: artifact
 *
 * Performs the artifact operation on the application for the useChat module.
 ******************************************************************************/
  const artifact = useMemo(() => [...messages].reverse().find((message) => message.artifacts)?.artifacts || null, [messages]);
  // Only surface session-load errors when no messages exist at all (total failure).
  // A background refetch error while messages are visible should not show the banner.
  const sessionError = messages.length === 0 ? session.error : null;
  const error = sendMutation.error || sessionError;
  return {
    selectedModel: session.data?.selectedModel || "",
    messages,
    artifact,
    loading: sendMutation.isPending || Boolean(operation && isActiveChatOperation(operation.status)),
    error: (identityFailure?.target === sessionId ? identityFailure.message : "") || error?.response?.data?.message || (error ? "Chat could not complete the request. Your draft is kept." : ""),
    operation,
    operationEvents: monitor.events,
    operationError: monitor.error || cancelMutation.error?.response?.data?.message || (cancelMutation.error ? "Cancellation was not acknowledged. Refresh saved progress before trying again." : ""),
    reconnecting: monitor.reconnecting,
    cancelOperation: () => operation && cancelMutation.mutate(operation.id),
    cancelling: cancelMutation.isPending,
    refreshOperation: monitor.refresh,
    send,
    hasMoreMessages: Boolean(session.data?.hasMoreMessages),
    loadingMore,
    loadMore,
  };
}

export default useChat;
