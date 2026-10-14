import { useCallback, useEffect, useState } from "react";
import { operationReadbackService } from "../services/operation-readback.service";

// Read-only, non-overlapping updates. A read/reconnect never submits a query,
// cancels an ERP action, reconciles its outcome or replays a mutation.
export function useOperationStatusQueries(executionId, { intentId, nodeId, interval = 2000 } = {}) {
  const [frame, setFrame] = useState(null), [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  const scope = `${executionId}:${intentId || ""}:${nodeId || ""}`;
  useEffect(() => {
    const controller = new AbortController(); let disposed = false, timer, inFlight = false, stopped = false, failures = 0;
    const poll = async () => {
      if (disposed || inFlight || stopped) return;
      inFlight = true; let again = false;
      try {
        if (navigator.onLine === false) throw new Error("Browser is offline. Status history will reconnect; no query is submitted.");
        const history = await operationReadbackService.history(executionId, { intentId, nodeId }, controller.signal);
        if (disposed) return;
        failures = 0; again = history.jobs.some(job => ["QUEUED", "RUNNING"].includes(job.state));
        setFrame({ scope, generation, history, error: "", loading: false, denied: false });
      } catch (cause) {
        if (disposed) return;
        const denied = [401, 403, 404].includes(cause?.response?.status); failures++;
        setFrame({ scope, generation, history: null, loading: false, denied,
          error: denied ? "Status history is no longer available to this account." : cause?.response?.data?.message || cause?.message || "Status history is unavailable. No outcome is assumed." });
        again = !denied && cause?.code !== "STATUS_QUERY_EVIDENCE_UNAVAILABLE";
      }
      inFlight = false; stopped = !again;
      if (!disposed && again) timer = setTimeout(poll, failures ? Math.min(30000, interval * 2 ** Math.min(failures, 4)) : interval);
    };
    const reconnect = () => { if (!disposed && !inFlight) { clearTimeout(timer); stopped = false; void poll(); } };
    const visible = () => { if (document.visibilityState === "visible") reconnect(); };
    window.addEventListener("online", reconnect); document.addEventListener("visibilitychange", visible); void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", reconnect); document.removeEventListener("visibilitychange", visible); };
  }, [executionId, intentId, nodeId, scope, generation, interval]);
  const active = frame?.scope === scope && frame.generation === generation ? frame : null;
  return { history: active?.history ?? null, loading: !active || active.loading, error: active?.error || "", denied: active?.denied || false, refresh };
}
