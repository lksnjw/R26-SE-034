import { useState } from "react";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";

export default function ChatRequestRevision({ message, busy, onRevise, draftStorageKey }) {
  const key = draftStorageKey ? `${draftStorageKey}.revision.${message.id}` : undefined;
  const [text, setText] = useState(() => readWorkspaceValue(key));
  const [editing, setEditing] = useState(() => Boolean(readWorkspaceValue(key)));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const source = message.revisionSource;
  if (!onRevise || source?.messageId !== message.id || !/^sha256:[a-f0-9]{64}$/.test(source?.sourceHash ?? "")) return null;
  const disabled = busy || submitting;
  const change = value => { setText(value); writeWorkspaceValue(key, value); };
  const send = async event => {
    event.preventDefault();
    if (disabled || !text.trim()) return;
    setSubmitting(true); setError("");
    try {
      const result = await onRevise(message, text.trim());
      if (result) { change(""); setEditing(false); }
      else setError("Revision was not acknowledged. Your text is kept; retry the same revision or refresh saved progress.");
    } catch (cause) {
      setError(`${cause?.response?.data?.message || "Could not acknowledge this revision."} Your text is kept.`);
    } finally { setSubmitting(false); }
  };
  if (!editing) return <button type="button" onClick={() => { change(message.text || ""); setEditing(true); }} disabled={disabled}
    className="px-1 py-1 text-xs text-gray-500 transition hover:text-primary disabled:opacity-50">Revise request</button>;
  return <form onSubmit={send} aria-label="Revise saved request" className="workspace-reveal w-full max-w-lg border-t border-gray-200 py-3 text-left dark:border-gray-700">
    <label className="block text-xs font-semibold text-gray-700 dark:text-gray-200" htmlFor={`revision-${message.id}`}>Revise request</label>
    <p className="my-2 text-xs leading-5 text-gray-500">Original request and answers stay saved. Sending starts a new governed operation using the context before this request, not its later answers.</p>
    {source.nodeContext && <p className="mb-2 text-xs text-gray-500">Original node · {source.nodeContext.nodeId} · draft v{source.nodeContext.baseVersion}. A changed revision must be reselected in the canvas.</p>}
    <textarea id={`revision-${message.id}`} value={text} onChange={event => change(event.target.value)} disabled={disabled} maxLength={source.nodeContext ? 4000 : 100000}
      rows={4} autoFocus className="w-full resize-y rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-600 dark:text-gray-100" />
    {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    <div className="mt-2 flex items-center gap-3"><button type="submit" disabled={disabled || !text.trim()} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{submitting ? "Saving revision…" : "Send revision"}</button>
      <button type="button" disabled={disabled} onClick={() => { change(""); setEditing(false); setError(""); }} className="px-2 py-2 text-xs text-gray-500">Cancel revision</button></div>
  </form>;
}
