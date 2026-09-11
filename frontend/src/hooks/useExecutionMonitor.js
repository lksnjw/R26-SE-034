import { useCallback, useEffect, useState } from "react";
import { executionService } from "../services/execution.service";
import { isActiveExecution, reconcileExecutionEvents } from "../utils/executionEvents";

// One non-overlapping poll per known execution. Re-mount/refresh replays from
// sequence zero; cleanup aborts only HTTP reads, never an ERP execution.
export function useExecutionMonitor(executionId, { enabled = true, interval = 2000, waitMs = 25000 } = {}) {
  const [frame, setFrame] = useState(null), [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    if (!executionId || !enabled) return undefined;
    const controller = new AbortController();
    let disposed = false, timer, cursor = 0, events = [], current = null, steps = [], failures = 0, inFlight = false, stopped = false;
    const poll = async () => {
      if (disposed || inFlight || stopped) return;
      inFlight = true;
      let again = true, more = false, advanced = false, pageWaited = false;
      try {
        if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("Browser is offline. Run updates will reconnect automatically.");
        const page = await executionService.getEvents(executionId, cursor, { signal: controller.signal, waitMs });
        pageWaited = page.waited === true;
        if (disposed) return;
        const replay = reconcileExecutionEvents(events, cursor, page, executionId);
        if (!current || replay.cursor !== cursor || current.status !== page.status || page.profile === "legacy-no-journal") {
          const [snapshot, timeline] = await Promise.all([
            executionService.get(executionId, { signal: controller.signal }), executionService.getTimeline(executionId, { signal: controller.signal }),
          ]);
          if (disposed) return;
          if (snapshot?.id !== executionId || !Array.isArray(timeline) ||
              (page.profile === "read-progress-v1" && (snapshot.readProgress?.profile !== "read-progress-v1" || !Number.isSafeInteger(snapshot.readProgress.lastSequence) || snapshot.readProgress.lastSequence < replay.cursor))) throw new Error("Run snapshot is behind saved events. Refresh again.");
          current = snapshot; steps = timeline;
        }
        advanced = replay.cursor > cursor;
        cursor = replay.cursor; events = replay.events; failures = 0;
        // Snapshot can advance while its journal page is in flight. Drain the
        // missing events even if the newer snapshot is already terminal.
        more = page.hasMore || (current.readProgress?.lastSequence ?? cursor) > cursor;
        again = more || isActiveExecution(current.status);
        if (!disposed) setFrame({ executionId, execution: current, timeline: steps, events, cursor, error: "", denied: false, reconnecting: false, checkedAt: new Date().toISOString() });
      } catch (cause) {
        if (disposed) return;
        failures += 1;
        const denied = [401, 403, 404].includes(cause?.response?.status);
        // Authorization loss hides old evidence. Transport failure retains it
        // explicitly stale, never labels the run failed, never retries Run.
        if (denied) { current = null; steps = []; events = []; }
        setFrame({ executionId, execution: current, timeline: steps, events, cursor,
          denied, reconnecting: !denied, error: denied ? "This run is no longer available to this account." : cause?.response?.data?.message || cause?.message || "Run updates are unavailable. Saved evidence has not been changed.", checkedAt: null });
        // A gap requires authoritative replay, not skipping missing events.
        if (!denied && /sequence gap/i.test(cause?.message || "")) { cursor = 0; events = []; }
        again = !denied;
      }
      inFlight = false;
      stopped = !again;
      const retryDelay = failures ? Math.min(30000, interval * 2 ** Math.min(5, failures - 1) * (0.85 + Math.random() * 0.3)) : interval;
      if (!disposed && again) timer = setTimeout(poll, (more && advanced) || (!failures && pageWaited) ? 0 : retryDelay);
    };
    const reconnect = () => { if (disposed || stopped || inFlight) return; clearTimeout(timer); void poll(); };
    const visible = () => { if (document.visibilityState === "visible") reconnect(); };
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", visible);
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", reconnect); document.removeEventListener("visibilitychange", visible); };
  }, [executionId, enabled, interval, waitMs, generation]);
  const active = frame?.executionId === executionId ? frame : null;
  return { execution: active?.execution ?? null, timeline: active?.timeline ?? [], events: active?.events ?? [], cursor: active?.cursor ?? 0,
    error: active?.error ?? "", denied: active?.denied ?? false, reconnecting: active?.reconnecting ?? false, checkedAt: active?.checkedAt ?? null, refresh };
}
