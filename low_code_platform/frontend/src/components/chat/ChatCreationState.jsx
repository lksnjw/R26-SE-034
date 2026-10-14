import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { prepareChatCreation, acknowledgeChatCreation } from "../../utils/chatCreation";

/** Retain the original command across reloads and uncertain acknowledgements.
 * A retry creates/retrieves this conversation only; it never sends a message. */
export default function ChatCreationState({ createSession, storageKey, title, requestId = "", workflowId = "", routeBase = "/chat", historyPath = "/chat/history" }) {
  const navigate = useNavigate();
  const [request] = useState(() => prepareChatCreation(storageKey, title, requestId));
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState(false);
  const inFlight = useRef(null);
  const attempt = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const pending = Promise.resolve().then(() => createSession(request.title, { idempotencyKey: request.idempotencyKey }));
    inFlight.current = pending;
    const settled = () => { if (inFlight.current === pending) inFlight.current = null; };
    pending.then(settled, settled);
    return pending;
  }, [createSession, request]);
  useEffect(() => {
    let current = true;
    attempt().then(session => {
      if (!current) return;
      if (!session?.id) { setError(true); return; }
      // Do not erase a newer request created in the same tab.
      acknowledgeChatCreation(storageKey, request);
      navigate(`${routeBase}/${encodeURIComponent(session.id)}${workflowId ? `?workflow=${encodeURIComponent(workflowId)}` : ""}`, { replace: true });
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [attempt, navigate, request, retry, routeBase, storageKey, workflowId]);
  return <section className="flex min-h-[320px] flex-1 flex-col items-start justify-center gap-3 px-6 py-10" aria-label="New conversation">
    <h1 className="text-lg font-semibold">{error ? "Could not confirm the new conversation." : "Opening your conversation…"}</h1>
    {error ? <>
      <p role="alert" className="max-w-lg text-sm text-gray-600 dark:text-gray-400">Your workflow context is retained. Retry to recover this same conversation; no prompt or workflow has been executed.</p>
      <button type="button" className="rounded bg-primary px-4 py-2 text-sm font-semibold text-white" onClick={() => { setError(false); setRetry(value => value + 1); }}>Retry conversation creation</button>
      <button type="button" className="text-sm text-primary underline" onClick={() => navigate(historyPath)}>View saved conversations</button>
    </> : <p role="status" className="text-sm text-gray-500">Waiting for the server to confirm a saved chat.</p>}
  </section>;
}
