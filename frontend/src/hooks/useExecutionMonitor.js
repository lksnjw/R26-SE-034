import { useCallback, useEffect, useState } from "react";
import { executionService } from "../services/execution.service";
import { isActiveExecution, reconcileExecutionEvents } from "../utils/executionEvents";

// One non-overlapping poll per known execution. Re-mount/refresh replays from
// sequence zero; cleanup aborts only HTTP reads, never an ERP execution.
export function useExecutionMonitor(executionId, { enabled = true, interval = 2000 } = {}) {
  const [frame, setFrame] = useState(null), [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    if (!executionId || !enabled) return undefined;
    const controller = new AbortController();
    let disposed = false, timer, cursor = 0, events = [], current = null, steps = [], failures = 0;
    const poll = async () => {
      let again = true, more = false;
      try {
        const page = await executionService.getEvents(executionId, cursor, { signal: controller.signal });
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
        cursor = replay.cursor; events = replay.events; failures = 0;
        // Snapshot can advance while its journal page is in flight. Drain the
        // missing events even if the newer snapshot is already terminal.
        more = page.hasMore || (current.readProgress?.lastSequence ?? cursor) > cursor;
        again = more || isActiveExecution(current.status);
        if (!disposed) setFrame({ executionId, execution: current, timeline: steps, events, cursor, error: "", denied: false, checkedAt: new Date().toISOString() });
      } catch (cause) {
        if (disposed) return;
        failures += 1;
        const denied = [401, 403, 404].includes(cause?.response?.status);
        // Authorization loss hides old evidence. Transport failure retains it
        // explicitly stale, never labels the run failed, never retries Run.
        if (denied) { current = null; steps = []; events = []; }
        setFrame({ executionId, execution: current, timeline: steps, events, cursor,
          denied, error: denied ? "This run is no longer available to this account." : cause?.response?.data?.message || cause?.message || "Run updates are unavailable. Saved evidence has not been changed.", checkedAt: null });
        again = !denied && failures < 3;
      }
      if (!disposed && again) timer = setTimeout(poll, more ? 0 : interval * Math.min(4, Math.max(1, failures)));
    };
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [executionId, enabled, interval, generation]);
  const active = frame?.executionId === executionId ? frame : null;
  return { execution: active?.execution ?? null, timeline: active?.timeline ?? [], events: active?.events ?? [], cursor: active?.cursor ?? 0,
    error: active?.error ?? "", denied: active?.denied ?? false, checkedAt: active?.checkedAt ?? null, refresh };
}
