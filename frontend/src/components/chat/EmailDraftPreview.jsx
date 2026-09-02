import { useId, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { chatService } from "../../services/chat.service";

const reportLabels = { NOT_PREPARED: "Report not prepared", PARTIAL: "Report incomplete", PREPARED_FOR_REVIEW: "Report draft · review required", USER_EDITED: "Edited draft · review required" };
const reasonLabels = { ERPBRIDGE_NOT_CONNECTED: "ERPBridge is not connected. No report was retrieved.", PROVIDER_NOT_CONFIGURED: "The analysis provider is not configured.", NO_ADMITTED_READ_TOOLS: "No permitted, verified read tools are available.", REPORT_PREPARATION_FAILED: "Report preparation failed. No complete report was saved.", NO_CONFIRMED_READ: "No confirmed ERP data was retrieved." };

// This is a draft editor, not a send/approval control. Server revisions and
// ownership remain authoritative; uncertain saves require a conversation reload.
export default function EmailDraftPreview({ draft: initialDraft, reportReason, superseded = false, onSaved }) {
  const { user } = useAuth();
  const id = useId();
  const savingRef = useRef(false);
  const [draft, setDraft] = useState(initialDraft);
  const [fields, setFields] = useState({ to: initialDraft.to, subject: initialDraft.subject, body: initialDraft.body });
  const [status, setStatus] = useState("idle");
  const [notice, setNotice] = useState("");
  const shownDraft = superseded ? initialDraft : draft;
  const shownFields = superseded ? initialDraft : fields;
  const canEdit = !superseded && user?.id === draft.ownerId && draft.profile === "email-draft-v1" && draft.state === "DRAFT_NOT_SENT";
  const locked = !canEdit || status === "saving" || status === "uncertain" || status === "conflict";
  const save = async (event) => {
    event.preventDefault();
    if (locked || savingRef.current) return;
    savingRef.current = true; setStatus("saving"); setNotice("");
    try {
      const result = await chatService.sendMessage(draft.sessionId, "Save email draft changes", { emailDraftCommand: {
        draftId: draft.id, baseVersion: draft.version, baseHash: draft.contentHash, commandId: crypto.randomUUID(), patch: fields,
      } });
      const saved = result?.assistantMessage?.artifacts?.emailDraft;
      if (!saved || saved.id !== draft.id || saved.sessionId !== draft.sessionId || saved.version !== draft.version + 1 || saved.state !== "DRAFT_NOT_SENT") {
        setStatus("uncertain"); setNotice("Save confirmation is uncertain. Reload this conversation to check the saved draft before editing again."); return;
      }
      setDraft(saved); setFields({ to: saved.to, subject: saved.subject, body: saved.body }); setStatus("saved"); setNotice("Draft changes saved. Nothing sent or approved.");
      try { await onSaved?.(); } catch { setNotice("Draft changes saved. Nothing sent or approved. Conversation refresh failed; reload to see the saved revision."); }
    } catch (error) {
      if (error?.response?.status === 409) { setStatus("conflict"); setNotice("This draft changed elsewhere. Reload the conversation before editing again."); }
      else if (!error?.response || error.response.status >= 500) { setStatus("uncertain"); setNotice("Save confirmation is uncertain. Reload this conversation to check the saved draft before editing again."); }
      else { setStatus("error"); setNotice("Changes were not accepted. Check your recipient and access, then try saving again."); }
    } finally { savingRef.current = false; }
  };
  return <section aria-label="Email draft" className="mt-4 min-w-0 border-t border-gray-200 pt-3 dark:border-gray-700">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Email draft</h3>
      <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">Not sent · revision {shownDraft.version}</span>
    </div>
    <p className="mt-1 text-xs text-gray-500">{reportLabels[shownDraft.reportStatus] ?? "Review required"}{shownDraft.recurring ? " · no schedule active" : ""}</p>
    {shownDraft.reportStatus === "NOT_PREPARED" && reasonLabels[reportReason] && <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{reasonLabels[reportReason]}</p>}
    <form onSubmit={save} className="mt-3 space-y-3">
      <div><label htmlFor={`${id}-to`} className="text-xs font-medium text-gray-600 dark:text-gray-300">Recipient email</label>
        <input id={`${id}-to`} type="email" maxLength={254} value={shownFields.to} disabled={locked} placeholder="Confirm one exact address"
          onChange={(e) => setFields({ ...fields, to: e.target.value })} className="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm dark:border-gray-700" /></div>
      <div><label htmlFor={`${id}-subject`} className="text-xs font-medium text-gray-600 dark:text-gray-300">Subject</label>
        <input id={`${id}-subject`} maxLength={300} value={shownFields.subject} disabled={locked}
          onChange={(e) => setFields({ ...fields, subject: e.target.value })} className="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm dark:border-gray-700" /></div>
      <div><label htmlFor={`${id}-body`} className="text-xs font-medium text-gray-600 dark:text-gray-300">Message draft</label>
        <textarea id={`${id}-body`} rows={7} maxLength={32000} value={shownFields.body} disabled={locked} placeholder="No complete report yet. Add a message or resolve the missing report details."
          onChange={(e) => setFields({ ...fields, body: e.target.value })} className="mt-1 w-full resize-y rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm leading-6 dark:border-gray-700" />
        <span className="text-xs text-gray-400">{shownFields.body.length.toLocaleString()} / 32,000 characters</span></div>
      {canEdit && <button type="submit" disabled={locked} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50">{status === "saving" ? "Saving draft…" : "Save draft changes"}</button>}
      {!canEdit && <p className="text-xs text-gray-500">{superseded ? "Historical draft. Edit the newest version below, or reload the conversation." : "Only this conversation’s owner can edit the draft."}</p>}
      {notice && <p role={status === "saved" ? "status" : "alert"} className="text-xs text-gray-600 dark:text-gray-300">{notice}</p>}
    </form>
    <details className="mt-3 text-xs text-gray-600 dark:text-gray-300">
      <summary className="cursor-pointer py-1">Before sending · {shownDraft.sourceEvidence?.length ?? 0} confirmed reads</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">{shownDraft.requirements?.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul>
      <p className="mt-2">Confirmed reads show retrieval succeeded, not that the analysis is complete or every sentence is verified. Review facts, reporting period and sharing permission. Editing never creates approval or a delivery receipt.</p>
    </details>
  </section>;
}
