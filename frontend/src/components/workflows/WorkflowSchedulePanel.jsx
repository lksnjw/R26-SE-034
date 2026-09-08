import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";
import SchemaFields from "../chat/SchemaFields";
import { workflowService } from "../../services/workflow.service";
import { workflowScheduleService } from "../../services/workflow-schedule.service";

const control = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white";
const defaultZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const defaultForm = actorId => ({ enabled: false, timezone: defaultZone(), localTime: "09:00", reportingPeriod: "previous-calendar-day",
  misfirePolicy: "SKIP", misfireGraceSeconds: 900, servicePrincipalId: actorId, input: {} });
const format = value => value ? new Date(value).toLocaleString() : "Not scheduled";

export default function WorkflowSchedulePanel({ workflow, actorId }) {
  const [status, setStatus] = useState(null), [readiness, setReadiness] = useState(null), [form, setForm] = useState(() => defaultForm(actorId));
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false);
  const load = async () => {
    setLoading(true); setError("");
    const [nextStatus, nextReadiness] = await Promise.all([workflowScheduleService.status(workflow.id), workflowService.readiness(workflow.id)]);
    setStatus(nextStatus); setReadiness(nextReadiness);
    const saved = nextStatus.schedule;
    setForm(saved ? { enabled: saved.state === "ACTIVE", timezone: saved.timezone, localTime: saved.localTime, reportingPeriod: saved.reportingPeriod,
      misfirePolicy: saved.misfirePolicy, misfireGraceSeconds: saved.misfireGraceSeconds, servicePrincipalId: saved.servicePrincipalId, input: saved.input } : defaultForm(actorId));
    setUncertain(false); setLoading(false); return nextStatus;
  };
  useEffect(() => { let active = true; Promise.all([workflowScheduleService.status(workflow.id), workflowService.readiness(workflow.id)]).then(([nextStatus, nextReadiness]) => {
    if (!active) return; setStatus(nextStatus); setReadiness(nextReadiness); const saved = nextStatus.schedule;
    setForm(saved ? { enabled: saved.state === "ACTIVE", timezone: saved.timezone, localTime: saved.localTime, reportingPeriod: saved.reportingPeriod,
      misfirePolicy: saved.misfirePolicy, misfireGraceSeconds: saved.misfireGraceSeconds, servicePrincipalId: saved.servicePrincipalId, input: saved.input } : defaultForm(actorId)); setLoading(false);
  }).catch(cause => { if (active) { setError(cause?.response?.data?.message || cause.message || "Schedule status unavailable"); setLoading(false); } }); return () => { active = false; }; }, [workflow.id, actorId]);
  const update = patch => { setForm(value => ({ ...value, ...patch })); setNotice(""); };
  const supported = readiness?.published && readiness?.compilation?.state === "CURRENT" && readiness?.executionProfile === "sequential-operation-v1";
  const save = async enabled => {
    if (!readiness || saving || uncertain) return;
    setSaving(true); setNotice(""); setError("");
    try {
      await workflowScheduleService.save(workflow.id, { profile: "workflow-daily-schedule-command/v1", baseRevision: status?.schedule?.revision || 0,
        workflowVersion: readiness.publishedVersion, workflowHash: readiness.contentHash, enabled, timezone: form.timezone.trim(), localTime: form.localTime,
        reportingPeriod: form.reportingPeriod.trim(), misfirePolicy: form.misfirePolicy, misfireGraceSeconds: Number(form.misfireGraceSeconds),
        servicePrincipalId: form.servicePrincipalId.trim(), input: form.input });
      await load(); setNotice(enabled ? "Daily schedule active. Each effect still waits for fresh independent approval." : "Schedule paused. No new occurrences will be admitted.");
    } catch (cause) {
      setUncertain(true); setError(cause?.response?.data?.message || "Schedule save outcome is unconfirmed. Reload authoritative status before another change.");
    } finally { setSaving(false); }
  };
  return <Card>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><Icon icon="mdi:calendar-clock" className="h-5 w-5 text-primary" /><h2 className="section-title">Daily automation</h2></div>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-gray-500 dark:text-gray-400">Durable timezone-aware occurrences run the pinned published version as the named service principal. A scheduled effect is never pre-approved and an uncertain send is never replayed automatically.</p></div>
      {status?.schedule && <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.schedule.state === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : status.schedule.state === "BLOCKED" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-700"}`}>{status.schedule.state}</span>}</div>
    {loading ? <p role="status" className="mt-4 text-sm text-gray-500">Loading authoritative schedule…</p> : <div className="mt-5 space-y-5">
      {!supported && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">Publish a current reviewed sequential operation before activating daily automation. Legacy trigger text is not an active schedule.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Local time</span><input aria-label="Daily local time" type="time" className={control} value={form.localTime} onChange={event => update({ localTime: event.target.value })} /></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">IANA timezone</span><input aria-label="Schedule timezone" className={control} value={form.timezone} onChange={event => update({ timezone: event.target.value })} placeholder="Asia/Colombo" /></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Reporting period</span><select aria-label="Reporting period" className={control} value={form.reportingPeriod} onChange={event => update({ reportingPeriod: event.target.value })}><option value="previous-calendar-day">Previous local calendar day</option></select></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Service principal ID</span><input aria-label="Service principal ID" className={control} value={form.servicePrincipalId} onChange={event => update({ servicePrincipalId: event.target.value })} /></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Missed occurrence</span><select aria-label="Misfire policy" className={control} value={form.misfirePolicy} onChange={event => update({ misfirePolicy: event.target.value })}><option value="SKIP">Skip after grace window</option><option value="FIRE_ONCE">Admit one occurrence</option></select></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Grace seconds</span><input aria-label="Misfire grace seconds" type="number" min="60" max="86400" className={control} value={form.misfireGraceSeconds} onChange={event => update({ misfireGraceSeconds: Number(event.target.value) })} /></label>
      </div>
      <div><SchemaFields label="Occurrence inputs" schema={readiness?.authoring?.inputSchema || { type: "object", properties: {}, additionalProperties: false }} value={form.input} onChange={input => update({ input })} allowReferences={false} />
        <p className="mt-2 text-[10px] text-gray-500">Credentials and secret fields are rejected. Connection credentials stay in protected MCP configuration.</p></div>
      <div className="rounded-xl border border-gray-200 p-4 text-xs leading-5 dark:border-gray-700"><p><span className="font-semibold">Next occurrence:</span> {format(status?.schedule?.nextRunAt)}</p><p><span className="font-semibold">Pinned version:</span> {status?.schedule?.workflowVersion || "Not active"}</p><p className="text-gray-500 dark:text-gray-400">{status?.explanation}</p>{status?.schedule?.lastError && <p className="mt-2 text-red-700">Blocked: {status.schedule.lastError}</p>}</div>
      <div className="flex flex-wrap gap-3"><Button variant="secondary" disabled={!supported || saving || uncertain || !form.timezone.trim() || !form.servicePrincipalId.trim()} onClick={() => save(true)}>{saving ? "Saving…" : "Activate daily schedule"}</Button>
        {status?.schedule?.state === "ACTIVE" && <Button variant="secondary" disabled={saving || uncertain} onClick={() => save(false)}>Pause schedule</Button>}
        {(uncertain || error) && <Button variant="secondary" disabled={saving || loading} onClick={() => { setNotice(""); load().then(() => setNotice("Authoritative schedule reloaded. Review it before saving again.")).catch(cause => setError(cause.message)); }}>Reload status</Button>}</div>
      {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}{error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {status?.occurrences?.length > 0 && <div><h3 className="text-sm font-semibold text-gray-900 dark:text-white">Recent occurrences</h3><div className="mt-2 divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-700 dark:border-gray-700">{status.occurrences.map(item => <div key={item.id} className="flex flex-col gap-1 p-3 text-xs sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{item.localDate} · {item.state}</p><p className="text-gray-500">Scheduled {format(item.scheduledFor)}</p>{item.reportWindow ? <p className="text-gray-500">Report day {item.reportWindow.localDate} · {format(item.reportWindow.startAt)} to {format(item.reportWindow.endAt)}</p> : <p className="text-amber-700">Legacy occurrence · exact report window unavailable</p>}{item.reason && <p className="text-red-700">{item.reason}</p>}</div>{item.executionId && <a className="font-semibold text-primary" href={`/executions/${encodeURIComponent(item.executionId)}`}>Open execution</a>}</div>)}</div></div>}
    </div>}
  </Card>;
}
