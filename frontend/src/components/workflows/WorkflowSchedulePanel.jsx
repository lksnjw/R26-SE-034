import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";
import SchemaFields from "../chat/SchemaFields";
import { workflowService } from "../../services/workflow.service";
import { workflowScheduleService } from "../../services/workflow-schedule.service";

const control = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white";
const defaultZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const periodByCadence = { daily: "previous-calendar-day", weekly: "previous-calendar-week", monthly: "previous-calendar-month" };
const cadenceLabel = cadence => cadence === "weekly" ? "weekly" : cadence === "monthly" ? "monthly" : "daily";
const emptyWindowBinding = () => ({ profile: "workflow-report-window-input-binding/v1", startAtInput: "", endAtInput: "" });
const defaultForm = actorId => ({ enabled: false, timezone: defaultZone(), localTime: "09:00", cadence: "daily", dayOfWeek: 1, dayOfMonth: 1,
  reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 900, servicePrincipalId: actorId, input: {}, reportWindowBinding: emptyWindowBinding() });
const savedForm = (saved, actorId) => saved ? { enabled: saved.state === "ACTIVE", timezone: saved.timezone, localTime: saved.localTime,
  cadence: saved.cadence || "daily", dayOfWeek: saved.dayOfWeek || 1, dayOfMonth: saved.dayOfMonth || 1, reportingPeriod: saved.reportingPeriod,
  misfirePolicy: saved.misfirePolicy, misfireGraceSeconds: saved.misfireGraceSeconds, servicePrincipalId: saved.servicePrincipalId, input: saved.input,
  reportWindowBinding: saved.reportWindowBinding || emptyWindowBinding() } : defaultForm(actorId);
const format = value => value ? new Date(value).toLocaleString() : "Not scheduled";

export default function WorkflowSchedulePanel({ workflow, actorId }) {
  const [status, setStatus] = useState(null), [readiness, setReadiness] = useState(null), [form, setForm] = useState(() => defaultForm(actorId));
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false);
  const load = async () => {
    setLoading(true); setError("");
    const [nextStatus, nextReadiness] = await Promise.all([workflowScheduleService.status(workflow.id), workflowService.readiness(workflow.id)]);
    setStatus(nextStatus); setReadiness(nextReadiness);
    const saved = nextStatus.schedule;
    setForm(savedForm(saved, actorId));
    setUncertain(false); setLoading(false); return nextStatus;
  };
  useEffect(() => { let active = true; Promise.all([workflowScheduleService.status(workflow.id), workflowService.readiness(workflow.id)]).then(([nextStatus, nextReadiness]) => {
    if (!active) return; setStatus(nextStatus); setReadiness(nextReadiness); const saved = nextStatus.schedule;
    setForm(savedForm(saved, actorId)); setLoading(false);
  }).catch(cause => { if (active) { setError(cause?.response?.data?.message || cause.message || "Schedule status unavailable"); setLoading(false); } }); return () => { active = false; }; }, [workflow.id, actorId]);
  const update = patch => { setForm(value => ({ ...value, ...patch })); setNotice(""); };
  const updateCadence = cadence => update({ cadence, reportingPeriod: periodByCadence[cadence] });
  const updateWindowBinding = (key, name) => { setForm(value => {
    const reportWindowBinding = { ...value.reportWindowBinding, [key]: name }, reserved = new Set([reportWindowBinding.startAtInput, reportWindowBinding.endAtInput].filter(Boolean));
    return { ...value, reportWindowBinding, input: Object.fromEntries(Object.entries(value.input).filter(([field]) => !reserved.has(field))) };
  }); setNotice(""); };
  const supported = readiness?.published && readiness?.compilation?.state === "CURRENT" && readiness?.executionProfile === "sequential-operation-v1";
  const inputSchema = readiness?.authoring?.inputSchema || { type: "object", properties: {}, additionalProperties: false };
  const windowFields = Object.entries(inputSchema.properties || {}).filter(([, schema]) => schema?.type === "string" && !schema.writeOnly).map(([name]) => name);
  const boundFields = new Set([form.reportWindowBinding.startAtInput, form.reportWindowBinding.endAtInput].filter(Boolean));
  const occurrenceInputSchema = { ...inputSchema, properties: Object.fromEntries(Object.entries(inputSchema.properties || {}).filter(([name]) => !boundFields.has(name))),
    required: (inputSchema.required || []).filter(name => !boundFields.has(name)) };
  const bindingReady = windowFields.includes(form.reportWindowBinding.startAtInput) && windowFields.includes(form.reportWindowBinding.endAtInput) &&
    form.reportWindowBinding.startAtInput !== form.reportWindowBinding.endAtInput;
  const calendarReady = form.cadence === "weekly" ? Number.isInteger(Number(form.dayOfWeek)) && Number(form.dayOfWeek) >= 1 && Number(form.dayOfWeek) <= 7 :
    form.cadence === "monthly" ? Number.isInteger(Number(form.dayOfMonth)) && Number(form.dayOfMonth) >= 1 && Number(form.dayOfMonth) <= 28 : true;
  const save = async enabled => {
    if (!readiness || saving || uncertain) return;
    setSaving(true); setNotice(""); setError("");
    try {
      await workflowScheduleService.save(workflow.id, { profile: "workflow-calendar-schedule-command/v2", baseRevision: status?.schedule?.revision || 0,
        workflowVersion: readiness.publishedVersion, workflowHash: readiness.contentHash, enabled, timezone: form.timezone.trim(), localTime: form.localTime,
        cadence: form.cadence, ...(form.cadence === "weekly" ? { dayOfWeek: Number(form.dayOfWeek) } : {}),
        ...(form.cadence === "monthly" ? { dayOfMonth: Number(form.dayOfMonth) } : {}),
        reportingPeriod: form.reportingPeriod.trim(), misfirePolicy: form.misfirePolicy, misfireGraceSeconds: Number(form.misfireGraceSeconds),
        servicePrincipalId: form.servicePrincipalId.trim(), input: form.input, reportWindowBinding: bindingReady ? form.reportWindowBinding : null });
      await load(); setNotice(enabled ? `${cadenceLabel(form.cadence)[0].toUpperCase()}${cadenceLabel(form.cadence).slice(1)} schedule active. Each effect still waits for fresh independent approval.` : "Schedule paused. No new occurrences will be admitted.");
    } catch (cause) {
      setUncertain(true); setError(cause?.response?.data?.message || "Schedule save outcome is unconfirmed. Reload authoritative status before another change.");
    } finally { setSaving(false); }
  };
  return <Card>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><Icon icon="mdi:calendar-clock" className="h-5 w-5 text-primary" /><h2 className="section-title">Calendar automation</h2></div>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-gray-500 dark:text-gray-400">Durable timezone-aware occurrences run the pinned published version as the named service principal. Decisions run only their selected path. Every effect requires complete report evidence earlier in its own scope; a sibling branch cannot supply it. A scheduled effect is never pre-approved and an uncertain send is never replayed automatically.</p></div>
      {status?.schedule && <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.schedule.state === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : status.schedule.state === "BLOCKED" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-700"}`}>{status.schedule.state}</span>}</div>
    {loading ? <p role="status" className="mt-4 text-sm text-gray-500">Loading authoritative schedule…</p> : <div className="mt-5 space-y-5">
      {!supported && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{["protected-operation-v1", "protected-draft-runtime-pending"].includes(readiness?.executionProfile) ? "Protected workflow calendar activation is not qualified yet. Manual run eligibility does not establish scheduled report coverage, pagination or recovery. Existing schedules can still be paused." : "Publish a current reviewed operation before activating calendar automation. Sequential and supported decision operations must pass server-side report coverage checks. Legacy trigger text is not an active schedule."}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Cadence</span><select aria-label="Schedule cadence" className={control} value={form.cadence} onChange={event => updateCadence(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        {form.cadence === "weekly" && <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Local weekday</span><select aria-label="Weekly local weekday" className={control} value={form.dayOfWeek} onChange={event => update({ dayOfWeek: Number(event.target.value) })}><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="7">Sunday</option></select></label>}
        {form.cadence === "monthly" && <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Local day of month</span><input aria-label="Monthly local day" type="number" min="1" max="28" className={control} value={form.dayOfMonth} onChange={event => update({ dayOfMonth: Number(event.target.value) })} /></label>}
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Local time</span><input aria-label="Schedule local time" type="time" className={control} value={form.localTime} onChange={event => update({ localTime: event.target.value })} /></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">IANA timezone</span><input aria-label="Schedule timezone" className={control} value={form.timezone} onChange={event => update({ timezone: event.target.value })} placeholder="Asia/Colombo" /></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Reporting period</span><select aria-label="Reporting period" className={control} value={form.reportingPeriod} disabled><option value="previous-calendar-day">Previous local calendar day</option><option value="previous-calendar-week">Previous local calendar week</option><option value="previous-calendar-month">Previous local calendar month</option></select></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Service principal ID</span><input aria-label="Service principal ID" className={control} value={form.servicePrincipalId} onChange={event => update({ servicePrincipalId: event.target.value })} /></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Missed occurrence</span><select aria-label="Misfire policy" className={control} value={form.misfirePolicy} onChange={event => update({ misfirePolicy: event.target.value })}><option value="SKIP">Skip after grace window</option><option value="FIRE_ONCE">Admit one occurrence</option></select></label>
        <label className="text-xs"><span className="font-bold uppercase tracking-wide text-gray-500">Grace seconds</span><input aria-label="Misfire grace seconds" type="number" min="60" max="86400" className={control} value={form.misfireGraceSeconds} onChange={event => update({ misfireGraceSeconds: Number(event.target.value) })} /></label>
      </div>
      <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700"><h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Server-derived report window</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500">Choose two declared string inputs used by reviewed ERP read steps. The server fills them from the occurrence timezone; saved static values cannot override them.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs"><span className="font-semibold">Start boundary input</span><select aria-label="Report start boundary input" className={control} value={form.reportWindowBinding.startAtInput} onChange={event => updateWindowBinding("startAtInput", event.target.value)}><option value="">Select a workflow input</option>{windowFields.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
          <label className="text-xs"><span className="font-semibold">End boundary input</span><select aria-label="Report end boundary input" className={control} value={form.reportWindowBinding.endAtInput} onChange={event => updateWindowBinding("endAtInput", event.target.value)}><option value="">Select a workflow input</option>{windowFields.map(name => <option key={name} value={name}>{name}</option>)}</select></label></div>
        {!bindingReady && <p className="mt-2 text-xs text-amber-700">Select two different declared string inputs. The backend also verifies that both feed reviewed ERP read steps.</p>}</div>
      <div><SchemaFields label="Occurrence inputs" schema={occurrenceInputSchema} value={form.input} onChange={input => update({ input })} allowReferences={false} />
        <p className="mt-2 text-[10px] text-gray-500">Window-bound fields are supplied only by the scheduler. Credentials and secret fields are rejected; connection credentials stay in protected MCP configuration.</p></div>
      <div className="rounded-xl border border-gray-200 p-4 text-xs leading-5 dark:border-gray-700"><p><span className="font-semibold">Cadence:</span> {cadenceLabel(status?.schedule?.cadence || "daily")}</p><p><span className="font-semibold">Next occurrence:</span> {format(status?.schedule?.nextRunAt)}</p><p><span className="font-semibold">Pinned version:</span> {status?.schedule?.workflowVersion || "Not active"}</p>{status?.schedule?.reportWindowBinding && <p><span className="font-semibold">Window inputs:</span> {status.schedule.reportWindowBinding.startAtInput} → start, {status.schedule.reportWindowBinding.endAtInput} → end</p>}<p className="text-gray-500 dark:text-gray-400">{status?.explanation}</p>{status?.schedule?.lastError && <p className="mt-2 text-red-700">Blocked: {status.schedule.lastError}</p>}</div>
      <div className="flex flex-wrap gap-3"><Button variant="secondary" disabled={!supported || !bindingReady || !calendarReady || saving || uncertain || !form.timezone.trim() || !form.servicePrincipalId.trim()} onClick={() => save(true)}>{saving ? "Saving…" : `Activate ${cadenceLabel(form.cadence)} schedule`}</Button>
        {status?.schedule?.state === "ACTIVE" && <Button variant="secondary" disabled={saving || uncertain} onClick={() => save(false)}>Pause schedule</Button>}
        {(uncertain || error) && <Button variant="secondary" disabled={saving || loading} onClick={() => { setNotice(""); load().then(() => setNotice("Authoritative schedule reloaded. Review it before saving again.")).catch(cause => setError(cause.message)); }}>Reload status</Button>}</div>
      {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}{error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {status?.occurrences?.length > 0 && <div><h3 className="text-sm font-semibold text-gray-900 dark:text-white">Recent occurrences</h3><div className="mt-2 divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-700 dark:border-gray-700">{status.occurrences.map(item => <div key={item.id} className="flex flex-col gap-1 p-3 text-xs sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{item.localDate} · {item.state}</p><p className="text-gray-500">Scheduled {format(item.scheduledFor)}</p>{item.reportWindow ? <p className="text-gray-500">Report period {item.reportWindow.localDate}{item.reportWindow.localEndDate ? ` to ${item.reportWindow.localEndDate}` : ""} · {format(item.reportWindow.startAt)} to {format(item.reportWindow.endAt)}</p> : <p className="text-amber-700">Legacy occurrence · exact report window unavailable</p>}{item.reason && <p className="text-red-700">{item.reason}</p>}</div>{item.executionId && <a className="font-semibold text-primary" href={`/executions/${encodeURIComponent(item.executionId)}`}>Open execution</a>}</div>)}</div></div>}
    </div>}
  </Card>;
}
