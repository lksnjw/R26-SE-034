import { useCallback, useEffect, useRef, useState } from "react";
import { runAdmissionService, RUN_ADMISSION_CHANGED } from "../services/run-admission.service";
import { normalizeExecution } from "../services/execution.service";

const empty = { checking: false, pending: false, run: null, error: "", denied: false };
/** Recover only the exact locally saved command. Every network call is GET;
 * origin/account/workflow isolation and epoch checks hide late responses. */
export function useRunAdmissionRecovery(workflowId, actorId) {
  const scope = `${actorId || ""}:${workflowId || ""}`;
  const [frame, setFrame] = useState({ scope, ...empty });
  const epoch = useRef(0);
  const invalidate = useCallback(() => { epoch.current++; }, []);
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    const save = value => { if (epoch.current === current) setFrame({ scope, ...value }); };
    if (!workflowId || !actorId) { save(empty); return null; }
    save({ ...empty, checking: true });
    try {
      if (!runAdmissionService.pending(workflowId, actorId)) { save(empty); return null; }
      save({ ...empty, checking: true, pending: true });
      const value = await runAdmissionService.recover(workflowId, actorId);
      const run = value ? normalizeExecution(value) : null;
      save({ ...empty, pending: Boolean(run), run }); return run;
    } catch (cause) { save({ ...empty, pending: true, denied: [401, 403, 404].includes(cause?.response?.status), error: cause?.message || "Original run recovery is unavailable. Nothing was repeated." }); return null; }
  }, [workflowId, actorId, scope]);
  useEffect(() => {
    void refresh();
    const changed = event => {
      try { const name = runAdmissionService.storageKey(workflowId, actorId); if ((event.type === "storage" ? event.key : event.detail) === name) void refresh(); }
      catch { /* Account transitions are handled by the keyed refresh. */ }
    };
    window.addEventListener("storage", changed); window.addEventListener(RUN_ADMISSION_CHANGED, changed);
    return () => { invalidate(); window.removeEventListener("storage", changed); window.removeEventListener(RUN_ADMISSION_CHANGED, changed); };
  }, [refresh, workflowId, actorId, invalidate]);
  const release = async snapshot => {
    try {
      if (!await runAdmissionService.release(workflowId, snapshot, actorId)) throw new Error("A matching server-confirmed Done, Failed or Cancelled receipt is required before a new run.");
      await refresh(); return true;
    } catch (cause) { setFrame(previous => previous.scope === scope ? { ...previous, error: cause?.message || "Run review could not be confirmed." } : previous); return false; }
  };
  return { ...(frame.scope === scope ? frame : { ...empty, checking: Boolean(workflowId && actorId) }), refresh, release };
}
