import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { mcpConnectionService } from "../../services/mcp-connection.service";
import { apiErrorMessage } from "../../services/api";
import Button from "../shared/ui/Button";

const readable = (value) => String(value ?? "Unknown").replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
const keyFor = (actorId, connectionId) => `workflow.mcp-operation.${encodeURIComponent(actorId)}.${encodeURIComponent(connectionId)}`;
const streamHelp = {
  STARTING: "Notification readiness is not yet confirmed.",
  ACTIVE: "Stream connected. This is not a live ERP health or delivery receipt.",
  RECOVERING: "Recovering the same notification session; discovery was invalidated. Business calls are not replayed.",
  UNSUPPORTED: "This server does not support notification GET. Discovery refreshes on requests/cache expiry, not continuous updates.",
  FAILED: "The agent session is unavailable. Review the reason and reconnect explicitly; reconnect does not retry ERP work.",
  CLOSED: "The notification stream is closed. No notification readiness is assumed.",
};
const streamReason = {
  STREAM_GAP: "Notification gap", STREAM_UNAUTHORIZED: "Notification access denied", SESSION_EXPIRED: "Remote session expired",
  STREAM_PROTOCOL: "Unsupported or malformed stream", STREAM_BUDGET: "Notification safety limit reached", RECOVERY_EXHAUSTED: "Notification recovery limit reached",
};
function restore(actorId, connectionId) {
  try {
    const text = sessionStorage.getItem(keyFor(actorId, connectionId)); if (!text) return null;
    if (text.length > 2048) throw new Error();
    const value = JSON.parse(text);
    if (!["connect", "disconnect", "test"].includes(value.action) || value.id !== connectionId ||
        !Number.isSafeInteger(value.body?.baseRevision) || value.body.baseRevision < 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(value.body?.requestId)) throw new Error();
    return value;
  } catch { return { invalid: true }; }
}
export default function McpConnectionPanel() {
  const { actorId, role, has } = usePermissions();
  if (!has("settings:manage")) return null;
  return <ConnectionWorkspace key={actorId} actorId={actorId} canManage={Boolean(actorId && role === "Platform Admin")} />;
}
function ConnectionWorkspace({ actorId, canManage }) {
  const client = useQueryClient();
  const [pendingByConnection, setPendingByConnection] = useState({});
  const [selectedId, setSelectedId] = useState("");
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const query = useQuery({ queryKey: ["mcp-connections", actorId], queryFn: mcpConnectionService.status, retry: false,
    refetchInterval: (state) => {
      if (state.state.error) return false;
      if (state.state.data?.connections.some(item => item.state === "CONNECTED" || item.operationInProgress) || state.state.data?.recentOperations.some(item => item.state === "RUNNING")) return 5000;
      return false;
    } });
  const connection = query.data?.connections.find(item => item.id === selectedId) ?? query.data?.connections.find(item => item.primary) ?? query.data?.connections[0];
  const pending = connection ? Object.hasOwn(pendingByConnection, connection.id) ? pendingByConnection[connection.id] : restore(actorId, connection.id) : null;
  const setPending = (value) => connection && setPendingByConnection(current => ({ ...current, [connection.id]: value }));
  const current = Boolean(connection) && !query.error && !query.isFetching;
  async function run(task) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await task(); } catch (failure) { setError(apiErrorMessage(failure, "MCP operation could not be confirmed. Reload saved status or retry the exact request; no readiness is assumed.")); }
    finally { lock.current = false; setBusy(false); }
  }
  async function send(value) {
    const result = await mcpConnectionService.command(value.action, value.id, value.body);
    if (result?.operation?.action !== value.action || !["RUNNING", "DONE", "FAILED", "INTERRUPTED"].includes(result?.operation?.state) ||
        typeof result?.operation?.id !== "string" || result?.operation?.requestId !== value.body.requestId || result?.operation?.actorId !== actorId ||
        result?.operation?.revision !== value.body.baseRevision + (value.action === "test" ? 0 : 1) || result?.connection?.id !== value.id) throw new Error("Invalid MCP operation acknowledgement");
    if (result.operation.state === "RUNNING") {
      setMessage("This request is saved and still awaiting completion or recovery. No initialization is repeated by an acknowledgement retry.");
      await query.refetch(); return;
    }
    sessionStorage.removeItem(keyFor(actorId, value.id)); setPending(null); setAction(null);
    setMessage(`Saved ${value.action} operation: ${readable(result.operation.state)}. Inspect the current connection state below; this is not an ERP delivery receipt.`);
    await query.refetch(); await client.invalidateQueries({ queryKey: ["capability-review"] });
  }
  function confirm() {
    if (!canManage || !current || busy || pending || !connection.supports[action]) return;
    run(async () => {
      const value = { action, id: connection.id, body: { baseRevision: connection.revision, requestId: `mcp_${crypto.randomUUID()}` } };
      sessionStorage.setItem(keyFor(actorId, connection.id), JSON.stringify(value)); setPending(value); setAction(null);
      await send(value);
    });
  }
  return <section aria-label="Backend MCP connection" className="border-y border-gray-200 py-5 dark:border-gray-800">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="section-title">ERPBridge MCP connection</h2><p className="mt-2 text-sm text-gray-500">Controls the actual backend session used by chat and workflows. Tool review is separate.</p></div>
      <Button variant="secondary" disabled={busy} onClick={() => query.refetch()}>Reload MCP status</Button></div>
    {query.isLoading ? <p className="mt-4" role="status">Loading backend connection…</p> : null}
    {busy ? <p className="mt-3 text-sm" role="status">Waiting for the backend MCP operation. Initialization/discovery has a bounded wait; no business tool is being run by this control.</p> : null}
    {query.error ? <p className="mt-4 text-sm text-red-700" role="alert">MCP lifecycle status unavailable. No new command can be submitted.</p> : null}
    {query.data?.connections.length > 1 ? <label className="mt-4 block max-w-md text-sm font-medium">Managed connection<select aria-label="Managed MCP connection" value={connection?.id ?? ""} disabled={busy} onChange={(event) => { setSelectedId(event.target.value); setAction(null); setError(""); setMessage(""); }} className="mt-2 w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700">{query.data.connections.map(item => <option key={item.id} value={item.id}>{item.id}{item.primary ? " · primary" : ""}</option>)}</select></label> : null}
    {connection ? <>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-4"><div><dt className="text-xs text-gray-500">Actual local state</dt><dd className="mt-1 font-semibold">{readable(connection.state)}</dd></div><div><dt className="text-xs text-gray-500">Connection revision</dt><dd className="mt-1">{connection.revision}</dd></div><div><dt className="text-xs text-gray-500">Storage</dt><dd className="mt-1">{readable(connection.persistence)}</dd></div><div><dt className="text-xs text-gray-500">Workflow dispatch</dt><dd className="mt-1">{connection.dispatchSupported ? "Primary connection" : "Not yet bound to workflow nodes"}</dd></div></dl>
      <p className="mt-3 text-sm text-gray-500">{connection.initialized ? "MCP initialized and discovery completed. ERP tool permissions, contracts, and each dispatch still need verification." : "No initialized agent session is confirmed."}</p>
      {connection.notificationStream ? <div className="mt-3 text-sm" role="status" aria-label="MCP notification stream"><p className="font-medium">Last confirmed notification stream: {readable(connection.notificationStream.state)} · {connection.notificationStream.recoveryAttempts} recovery attempts in this cycle</p><p className="mt-1 text-gray-500">{streamHelp[connection.notificationStream.state]}{connection.notificationStream.reason ? ` ${streamReason[connection.notificationStream.reason]}.` : ""}</p></div> : null}
      <p className="mt-2 text-xs text-gray-500">Endpoint and token are backend-owned environment configuration, not browser fields. Secret reference: {connection.secretReference || "backend configuration"}. Rotation requires backend configuration and restart. {connection.persistence === "memory-only" ? "Connection intent and operations do not survive a server restart in memory-only mode." : "Distributed lifecycle/revocation is not qualified."}</p>
      {!connection.dispatchSupported ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">This secondary connection can be initialized and reviewed, but current workflow publications cannot dispatch through it until explicit node connection binding is delivered.</p> : null}
      {canManage ? <div className="mt-4 flex flex-wrap gap-2">{["connect", "test", "disconnect"].map((value) => <Button key={value} variant={value === "disconnect" ? "secondary" : value === "connect" ? "primary" : "ghost"} disabled={!current || busy || Boolean(pending) || !connection.supports[value]} onClick={() => setAction(value)}>{value === "connect" && connection.initialized ? "Reconnect MCP" : value === "connect" ? "Connect MCP" : value === "test" ? "Test MCP initialization" : "Disconnect MCP"}</Button>)}</div> : <p className="mt-3 text-sm text-gray-500">Read only. Platform Admin authority is required for lifecycle changes.</p>}
    </> : null}
    {action ? <div className="mt-4 border-l-2 border-primary pl-4" role="group" aria-label="Confirm MCP operation"><h3 className="text-sm font-semibold">Confirm {action}</h3><p className="mt-2 text-sm text-gray-500">{action === "test" ? "Initialize and discover using a disposable session. No business tool runs and the agent's session is not replaced." : action === "connect" ? "Create a new connection revision. Old clients are fenced; capabilities need a fresh exact review. This does not run a business tool." : "Block new calls and close the session. In-flight remote outcomes may be unknown; disconnect does not undo already-sent ERP work."}</p><div className="mt-3 flex gap-2"><Button disabled={!current || busy || Boolean(pending)} onClick={confirm}>Confirm {action}</Button><Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button></div></div> : null}
    {pending ? <div className="mt-4 border-l-2 border-amber-500 pl-4" role="status"><p className="text-sm font-semibold">{pending.invalid ? "Local MCP request record needs recovery" : `Unconfirmed MCP ${pending.action} request`}</p><div className="mt-3 flex flex-wrap gap-2">{!pending.invalid && canManage ? <Button disabled={busy} onClick={() => run(() => send(pending))}>Retry exact MCP request</Button> : null}<Button variant="secondary" disabled={busy} onClick={() => run(async () => { const result = await query.refetch(); if (result.error || !result.data) throw new Error("No authoritative status"); sessionStorage.removeItem(keyFor(actorId, connection.id)); setPending(null); setAction(null); setMessage("Local retries ended after status reload. This does not undo a saved connect/disconnect operation. Inspect current state before making a new decision."); })}>Reload status and end MCP retries</Button></div></div> : null}
    {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
    {message ? <p className="mt-3 text-sm text-gray-600 dark:text-gray-300" role="status">{message}</p> : null}
    <details className="mt-5"><summary className="cursor-pointer text-sm font-semibold">Recent saved MCP operations</summary><ul className="mt-3 divide-y divide-gray-200 text-sm dark:divide-gray-800">{(query.data?.recentOperations ?? []).filter(operation => operation.connectionId === connection?.id).map((operation) => <li key={operation.id} className="py-3"><p>{readable(operation.action)} · {readable(operation.state)} · revision {operation.revision}</p><p className="mt-1 text-xs text-gray-500">{operation.id} · {operation.startedAt}{operation.reason ? ` · ${readable(operation.reason)}` : ""}</p></li>)}</ul>{query.data && !query.data.recentOperations.some(operation => operation.connectionId === connection?.id) ? <p className="mt-3 text-sm text-gray-500">No saved operations for this connection.</p> : null}</details>
  </section>;
}
