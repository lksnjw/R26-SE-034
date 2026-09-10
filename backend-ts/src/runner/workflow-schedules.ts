import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import type { ReportWindow, ReportWindowInputBinding, Repository, RepositoryState, ScheduleOccurrence, WorkflowSchedule } from "../repository/store.js";
import { workflowContentHash } from "../parser/workflow.js";
import { isSecretField, withoutSecretFields } from "../redact/secrets.js";
import { prepareOperationExecution } from "../workflows/operation-compilation-lifecycle.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { operationJobQueue, supportsOperationJobs } from "./operation-jobs.js";
import { canViewWorkflow } from "../workflows/commands.js";
import { isOperationToolNode, type CompiledOperationPlan, type ReadBinding } from "../workflows/compiled-read.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { reportCoverageParameters } from "../tools/report-coverage-contract.js";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const inputName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const reportWindowInputBindingSchema = z.object({
  profile: z.literal("workflow-report-window-input-binding/v1"),
  startAtInput: inputName,
  endAtInput: inputName,
}).strict();
export const dailyScheduleCommandSchema = z.object({
  profile: z.literal("workflow-daily-schedule-command/v1"),
  baseRevision: z.number().int().min(0),
  workflowVersion: z.number().int().positive(),
  workflowHash: hash,
  enabled: z.boolean(),
  timezone: z.string().trim().min(1).max(128),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  reportingPeriod: z.literal("previous-calendar-day"),
  misfirePolicy: z.enum(["SKIP", "FIRE_ONCE"]),
  misfireGraceSeconds: z.number().int().min(60).max(86_400),
  servicePrincipalId: z.string().min(1).max(256),
  input: z.record(z.string(), z.unknown()),
  reportWindowBinding: reportWindowInputBindingSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.enabled && !value.reportWindowBinding) context.addIssue({ code: "custom", path: ["reportWindowBinding"], message: "Active schedules require an exact report-window input binding" });
  if (value.reportWindowBinding?.startAtInput === value.reportWindowBinding?.endAtInput)
    context.addIssue({ code: "custom", path: ["reportWindowBinding"], message: "Report-window inputs must be distinct" });
});
export type DailyScheduleCommand = z.infer<typeof dailyScheduleCommandSchema>;

const formatter = (timezone: string) => {
  try { return new Intl.DateTimeFormat("en-CA-u-nu-latn", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { throw new HandlerFailure(422, "Timezone must be a supported IANA timezone", { code: "SCHEDULE_TIMEZONE_INVALID" }); }
};
function localParts(timezone: string, instant: number, dateFormatter = formatter(timezone)) {
  const values = Object.fromEntries(dateFormatter.formatToParts(new Date(instant)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}
function startOfLocalDate(timezone: string, date: string): string {
  const [year, month, day] = date.split("-").map(Number), center = Date.UTC(year!, month! - 1, day!);
  let low = center - 48 * 60 * 60_000, high = center + 48 * 60 * 60_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 120_000) * 60_000;
    if (localParts(timezone, middle).date < date) low = middle + 60_000; else high = middle;
  }
  if (localParts(timezone, low).date !== date) throw new HandlerFailure(422, "The requested local report day does not exist in this timezone", { code: "SCHEDULE_REPORT_WINDOW_UNRESOLVED" });
  return new Date(low).toISOString();
}
export function reportWindowFor(timezone: string, scheduledFor: string, reportingPeriod: "previous-calendar-day"): ReportWindow {
  if (reportingPeriod !== "previous-calendar-day") throw new HandlerFailure(422, "Reporting period is unsupported", { code: "SCHEDULE_REPORT_WINDOW_UNRESOLVED" });
  formatter(timezone);
  const instant = Date.parse(scheduledFor);
  if (!Number.isFinite(instant)) throw new HandlerFailure(422, "Scheduled occurrence time is invalid", { code: "SCHEDULE_REPORT_WINDOW_UNRESOLVED" });
  const occurrenceDate = localParts(timezone, instant).date, localDate = shiftDate(occurrenceDate, -1);
  return { profile: "workflow-report-window/v1", reportingPeriod, timezone, localDate,
    startAt: startOfLocalDate(timezone, localDate), endAt: startOfLocalDate(timezone, occurrenceDate) };
}
/** Finds the first real UTC minute that represents the requested local wall
 * time. A nonexistent DST wall time is skipped; an ambiguous time chooses the
 * first occurrence after the supplied instant. */
export function nextDailyOccurrence(timezone: string, localTime: string, afterExclusive: number): string {
  const dateFormatter = formatter(timezone);
  let candidate = Math.floor(afterExclusive / 60_000) * 60_000 + 60_000;
  const limit = candidate + 9 * 24 * 60 * 60_000;
  for (; candidate <= limit; candidate += 60_000) if (localParts(timezone, candidate, dateFormatter).time === localTime) return new Date(candidate).toISOString();
  throw new HandlerFailure(422, "No valid daily occurrence was found for this timezone and local time", { code: "SCHEDULE_TIME_UNRESOLVED" });
}
function canRun(state: Readonly<RepositoryState>, workflowId: string, actor: CurrentUser) {
  const workflow = state.workflows[workflowId];
  return !!workflow && actor.permissions.some(permission => ["workflow:run", "workflow:run_own"].includes(permission)) &&
    (actor.permissions.includes("workflow:run") || workflow.owner.id === actor.id || (workflow.assignedUserIds ?? []).includes(actor.id));
}
function effectiveStateUser(state: Readonly<RepositoryState>, userId: string): CurrentUser | null {
  const user = state.users[userId], role = user ? state.roles[user.roleId] : undefined;
  if (!user || !role || user.status.toLowerCase() !== "active") return null;
  return { ...structuredClone(user), role: role.name, permissions: [...new Set([...role.permissions, ...user.permissionOverrides].filter(Boolean))] };
}
function publicSchedule(schedule: WorkflowSchedule | null) {
  return schedule ? withoutSecretFields({ ...schedule, reportWindowBinding: schedule.reportWindowBinding ?? null }) : null;
}
function publicOccurrence(value: ScheduleOccurrence) {
  const { idempotencyKey: _idempotencyKey, ...visible } = value;
  return withoutSecretFields({ ...visible, reportWindow: value.reportWindow ?? null });
}
function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => isSecretField(key) || containsSecretField(child));
}
function referencesWorkflowInput(binding: ReadBinding, name: string): boolean {
  if (binding.kind === "ref") return binding.source === "workflowInput" && binding.path[0] === name;
  if (binding.kind === "template") return binding.parts.some(part => typeof part !== "string" && referencesWorkflowInput(part, name));
  if (binding.kind === "object") return Object.values(binding.fields).some(child => referencesWorkflowInput(child, name));
  if (binding.kind === "array") return binding.items.some(child => referencesWorkflowInput(child, name));
  return false;
}
function directlyBindsParameter(binding: ReadBinding, parameter: string, workflowInput: string): boolean {
  if (binding.kind !== "object") return false;
  const value = binding.fields[parameter];
  return value?.kind === "ref" && value.source === "workflowInput" && value.path.length === 1 && value.path[0] === workflowInput;
}
function directlyBindsNodeOutput(binding: ReadBinding, parameter: string, nodeId: string, path: readonly string[]): boolean {
  if (binding.kind !== "object") return false;
  const value = binding.fields[parameter];
  return value?.kind === "ref" && value.source === "nodeOutput" && value.nodeId === nodeId &&
    value.path.length === path.length && value.path.every((part, index) => part === path[index]);
}
function bindReportWindowInput(plan: CompiledOperationPlan, staticInput: Record<string, unknown>, binding: ReportWindowInputBinding, window: ReportWindow,
  tools: readonly ToolDefinition[]) {
  if (!reportWindowInputBindingSchema.safeParse(binding).success)
    throw new HandlerFailure(422, "Report-window input binding is malformed", { code: "SCHEDULE_REPORT_WINDOW_BINDING_INVALID" });
  const names = [binding.startAtInput, binding.endAtInput];
  if (new Set(names).size !== names.length) throw new HandlerFailure(422, "Report-window inputs must be distinct", { code: "SCHEDULE_REPORT_WINDOW_BINDING_INVALID" });
  if (names.some(name => Object.hasOwn(staticInput, name)))
    throw new HandlerFailure(422, "Server-derived report-window inputs cannot be supplied as static schedule values", { code: "SCHEDULE_REPORT_WINDOW_OVERRIDE_DENIED" });
  const schema = plan.ir.inputSchema, properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  const values: Record<string, string> = { [binding.startAtInput]: window.startAt, [binding.endAtInput]: window.endAt };
  for (const name of names) {
    if (!properties?.[name] || properties[name]!.writeOnly || validateToolInput(properties[name], values[name]).length)
      throw new HandlerFailure(422, `Report-window input ${name} must be a declared non-sensitive string field`, { code: "SCHEDULE_REPORT_WINDOW_BINDING_INVALID" });
    if (!plan.ir.root.nodes.some(node => isOperationToolNode(node) && node.effectClass === "read" && referencesWorkflowInput(node.inputs, name)))
      throw new HandlerFailure(422, `Report-window input ${name} must be referenced by a reviewed ERP read step`, { code: "SCHEDULE_REPORT_WINDOW_BINDING_UNUSED" });
  }
  const firstEffect = plan.ir.root.nodes.findIndex(node => isOperationToolNode(node) && node.effectClass !== "read");
  const coverage = plan.ir.root.nodes.flatMap((node, index) => {
    if (firstEffect < 0 || index >= firstEffect) return [];
    if (!isOperationToolNode(node) || node.effectClass !== "read") return [];
    const tool = tools.find(value => value.tool_id === node.capability.toolId && node.capability.contractHash === digest(value));
    if (!tool?.report_coverage_contract) return [];
    try {
      const parameters = reportCoverageParameters(tool)!;
      const pagination = tool.report_coverage_contract.pagination;
      const pageParameter = pagination?.profile === "page-number/v1" ? pagination.page_parameter : pagination?.cursor_parameter;
      return directlyBindsParameter(node.inputs, parameters.start, binding.startAtInput) && directlyBindsParameter(node.inputs, parameters.end, binding.endAtInput) &&
        (!pageParameter || node.inputs.kind === "object" && !Object.hasOwn(node.inputs.fields, pageParameter)) ? [{ node, tool }] : [];
    } catch { return []; }
  });
  const supportedSingle = coverage.length === 1 && !coverage[0]!.tool.report_coverage_contract!.key_projection &&
    !coverage[0]!.tool.report_coverage_contract!.requested_key_coverage;
  let supportedRelation = false;
  if (coverage.length === 2) {
    const [primary, related] = coverage, primaryContract = primary!.tool.report_coverage_contract!, relatedContract = related!.tool.report_coverage_contract!;
    supportedRelation = !!primaryContract.key_projection && !!relatedContract.requested_key_coverage &&
      !primaryContract.requested_key_coverage && !relatedContract.key_projection &&
      primaryContract.key_projection.relation_name === relatedContract.requested_key_coverage.relation_name &&
      directlyBindsNodeOutput(related!.node.inputs, relatedContract.requested_key_coverage.keys_parameter, primary!.node.id,
        ["structuredContent", ...primaryContract.key_projection.keys_path]);
  }
  if (!supportedSingle && !supportedRelation) throw new HandlerFailure(422,
    "An active schedule requires either one reviewed complete report or one reviewed primary report followed by an exact related-key coverage report before the first effect",
    { code: "SCHEDULE_REPORT_COVERAGE_REQUIRED" });
  const effective = { ...structuredClone(staticInput), ...values };
  if (!schema || validateToolInput(schema, effective).length)
    throw new HandlerFailure(422, "Schedule values plus the server-derived report window do not match the published workflow input schema", { code: "SCHEDULE_INPUT_INVALID" });
  return effective;
}

export function workflowScheduleView(state: Readonly<RepositoryState>, workflowId: string, actor: CurrentUser) {
  const workflow = state.workflows[workflowId];
  if (!workflow || !canViewWorkflow(workflow, actor))
    throw new HandlerFailure(404, "Workflow not found");
  const schedule = state.schedules[`schedule-${workflowId}`] ?? null;
  const occurrences = schedule ? Object.values(state.scheduleOccurrences).filter(item => item.scheduleId === schedule.id)
    .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor) || b.id.localeCompare(a.id)).slice(0, 20).map(publicOccurrence) : [];
  return { profile: "workflow-schedule-view/v1", workflowId, schedule: publicSchedule(schedule), occurrences,
    canManage: actor.permissions.includes("workflow:write"), explanation: schedule?.state === "ACTIVE" ?
      "The next occurrence is durable. Each occurrence uses the named service principal and the pinned publication; effects still require fresh independent runtime approval." :
      schedule?.state === "BLOCKED" ? "The schedule is blocked. Review the recorded reason and explicitly save a new revision; no automatic dispatch is allowed." :
      "No active schedule is confirmed. Saving workflow trigger text alone does not activate recurring execution." };
}

export async function saveWorkflowSchedule(services: HandlerServices, workflowId: string, actor: CurrentUser, raw: unknown) {
  if (!supportsOperationJobs(services)) throw new HandlerFailure(503, "Schedules require qualified encrypted operation persistence", { code: "SCHEDULE_STORAGE_UNSUPPORTED" });
  const parsed = dailyScheduleCommandSchema.safeParse(raw);
  if (!parsed.success) throw new HandlerFailure(422, "Invalid daily schedule command", { code: "SCHEDULE_COMMAND_INVALID" });
  const command = parsed.data;
  formatter(command.timezone);
  if (canonicalJSONBytes(command.input).length > 64_000) throw new HandlerFailure(422, "Schedule input exceeds supported bounds");
  if (containsSecretField(command.input)) throw new HandlerFailure(422, "Schedule inputs cannot contain credentials or secret fields; use the admitted connection configuration");
  const scheduleId = `schedule-${workflowId}`, now = new Date().toISOString();
  const saved = await services.repository.mutate(state => {
    const workflow = state.workflows[workflowId], previous = state.schedules[scheduleId];
    if (!workflow || workflow.archived) throw new HandlerFailure(404, "Workflow not found");
    if (workflow.emailDeliverySource || workflow.recoverySource) throw new HandlerFailure(409, "One-time linked operation publications cannot be scheduled", { code: "LINKED_OPERATION_SCHEDULE_DENIED" });
    const currentActor = effectiveStateUser(state, actor.id);
    if (!currentActor?.permissions.includes("workflow:write")) throw new HandlerFailure(403, "Current workflow write authority is required");
    if ((previous?.revision ?? 0) !== command.baseRevision) throw new HandlerFailure(409, "Schedule changed; reload before saving", { code: "SCHEDULE_REVISION_CONFLICT" });
    if (!command.enabled) {
      if (!previous) throw new HandlerFailure(409, "There is no saved schedule to pause", { code: "SCHEDULE_NOT_FOUND" });
      const schedule: WorkflowSchedule = { ...structuredClone(previous), state: "PAUSED", revision: previous.revision + 1, nextRunAt: null, updatedAt: now };
      delete schedule.lastError; state.schedules[scheduleId] = schedule;
      state.auditLogs.push({ id: `schedule-audit-${digest([scheduleId, schedule.revision, now]).slice(7, 31)}`, actor: { id: currentActor.id, name: currentActor.name },
        action: "workflow.schedule_paused", resource: { type: "workflow-schedule", id: scheduleId },
        after: { workflowId, revision: schedule.revision, state: schedule.state, workflowVersion: schedule.workflowVersion, timezone: schedule.timezone,
          localTime: schedule.localTime, servicePrincipalId: schedule.servicePrincipalId, nextRunAt: schedule.nextRunAt }, createdAt: now });
      return structuredClone(schedule);
    }
    const principal = effectiveStateUser(state, command.servicePrincipalId);
    if (!principal) throw new HandlerFailure(422, "The named service principal is not active");
    if (workflow.publishedVersion !== command.workflowVersion || workflowContentHash(workflow.yaml) !== command.workflowHash)
      throw new HandlerFailure(409, "Schedule must bind the exact current published workflow", { code: "SCHEDULE_PUBLICATION_CHANGED" });
    if (!canRun(state, workflowId, principal)) throw new HandlerFailure(403, "The named service principal cannot run this workflow");
    const publication = (state.versions[workflowId] ?? []).findLast(value => value.artifactState === "PUBLISHED" && value.version === command.workflowVersion && value.yaml === workflow.yaml);
    if (!publication?.compiledOperation) throw new HandlerFailure(422, "Daily scheduling currently requires a reviewed sequential operation publication");
    const compiled = prepareOperationExecution(state, services, publication, workflow.yaml, principal.role);
    const reportWindowBinding = command.reportWindowBinding!;
    const scheduleHash = digest({ profile: command.profile, workflowId, workflowVersion: command.workflowVersion, workflowHash: command.workflowHash,
      timezone: command.timezone, localTime: command.localTime, reportingPeriod: command.reportingPeriod, misfirePolicy: command.misfirePolicy,
      misfireGraceSeconds: command.misfireGraceSeconds, servicePrincipalId: command.servicePrincipalId, input: command.input, reportWindowBinding });
    const unchanged = previous?.scheduleHash === scheduleHash && previous.state === "ACTIVE" && previous.nextRunAt && Date.parse(previous.nextRunAt) > Date.now();
    const nextRunAt = unchanged ? previous.nextRunAt! : nextDailyOccurrence(command.timezone, command.localTime, Date.now());
    const nextReportWindow = reportWindowFor(command.timezone, nextRunAt, command.reportingPeriod);
    bindReportWindowInput(compiled.plan, command.input, reportWindowBinding, nextReportWindow, services.registries.snapshot().tools);
    const schedule: WorkflowSchedule = { profile: "workflow-daily-schedule/v1", id: scheduleId, workflowId, workflowVersion: command.workflowVersion,
      workflowHash: command.workflowHash, state: command.enabled ? "ACTIVE" : "PAUSED", revision: (previous?.revision ?? 0) + 1,
      timezone: command.timezone, localTime: command.localTime, reportingPeriod: command.reportingPeriod, misfirePolicy: command.misfirePolicy,
      misfireGraceSeconds: command.misfireGraceSeconds, servicePrincipalId: command.servicePrincipalId, input: structuredClone(command.input),
      reportWindowBinding: structuredClone(reportWindowBinding),
      nextRunAt: command.enabled ? nextRunAt : null,
      ...(previous?.lastOccurrenceAt ? { lastOccurrenceAt: previous.lastOccurrenceAt } : {}), createdBy: previous?.createdBy ?? { id: currentActor.id, name: currentActor.name },
      createdAt: previous?.createdAt ?? now, updatedAt: now, scheduleHash };
    state.schedules[scheduleId] = schedule;
    state.auditLogs.push({ id: `schedule-audit-${digest([scheduleId, schedule.revision, now]).slice(7, 31)}`, actor: { id: currentActor.id, name: currentActor.name },
      action: "workflow.schedule_saved", resource: { type: "workflow-schedule", id: scheduleId },
      after: { workflowId, revision: schedule.revision, state: schedule.state, workflowVersion: schedule.workflowVersion, timezone: schedule.timezone,
        localTime: schedule.localTime, servicePrincipalId: schedule.servicePrincipalId, nextRunAt: schedule.nextRunAt }, createdAt: now });
    return structuredClone(schedule);
  });
  workflowScheduleRunner(services).kick();
  return publicSchedule(saved);
}

const runners = new WeakMap<Repository, WorkflowScheduleRunner>();
export function workflowScheduleRunner(services: HandlerServices) {
  let runner = runners.get(services.repository);
  if (!runner || runner.closed) { runner = new WorkflowScheduleRunner(services); runners.set(services.repository, runner); }
  return runner;
}
type Claim = { schedule: WorkflowSchedule; occurrence: ScheduleOccurrence };
export class WorkflowScheduleRunner {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #started = false;
  #closed = false;
  readonly #unobserve: () => void;
  get closed() { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    if (!supportsOperationJobs(services)) throw new HandlerFailure(503, "Schedules require qualified encrypted operation persistence");
    this.#unobserve = services.repository.observeCommits({ committed: () => { void this.plan(); }, unavailable: () => { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }, });
  }
  async start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    const due = await this.services.repository.read(state => {
      this.services.repository.assertAuthority();
      return Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING") ||
        Object.values(state.schedules).some(value => value.state === "ACTIVE" && value.nextRunAt && Date.parse(value.nextRunAt) <= Date.now());
    });
    if (due) await this.runDue(); else await this.plan();
  }
  kick() { if (!this.#started || this.#closed) return; void this.runDue(); }
  private async plan() {
    if (!this.#started || this.#closed || this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      const next = await this.services.repository.read(state => {
        this.services.repository.assertAuthority();
        if (Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING")) return Date.now();
        return Math.min(...Object.values(state.schedules).filter(value => value.state === "ACTIVE" && value.nextRunAt).map(value => Date.parse(value.nextRunAt!)));
      });
      if (!Number.isFinite(next) || this.#closed || this.#running) return;
      this.#timer = setTimeout(() => { this.#timer = undefined; void this.runDue(); }, Math.max(1, Math.min(2_147_000_000, next - Date.now())));
      this.#timer.unref();
    } catch {}
  }
  async runDue(nowMs = Date.now()) {
    if (this.#running || this.#closed) return { admitted: 0, skipped: 0, blocked: 0 };
    this.#running = true;
    const count = { admitted: 0, skipped: 0, blocked: 0 };
    try {
      for (let index = 0; index < 100; index++) {
        const claim = await this.claim(nowMs);
        if (!claim) break;
        if (claim.occurrence.state === "SKIPPED") { count.skipped++; continue; }
        if (claim.occurrence.state === "BLOCKED") { count.blocked++; continue; }
        const completed = await this.admit(claim, nowMs);
        if (!completed) break;
        completed === "ADMITTED" ? count.admitted++ : count.blocked++;
      }
      return count;
    } finally { this.#running = false; await this.plan(); }
  }
  private async claim(nowMs: number): Promise<Claim | null> {
    const available = await this.services.repository.readAuthoritative(state =>
      Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING") ||
      Object.values(state.schedules).some(value => value.state === "ACTIVE" && value.nextRunAt && Date.parse(value.nextRunAt) <= nowMs));
    if (!available) return null;
    return this.services.repository.mutate(state => {
      const pending = Object.values(state.scheduleOccurrences).filter(value => value.state === "ADMITTING")
        .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];
      if (pending) { const schedule = state.schedules[pending.scheduleId]; return schedule ? { schedule: structuredClone(schedule), occurrence: structuredClone(pending) } : null; }
      const schedule = Object.values(state.schedules).filter(value => value.state === "ACTIVE" && value.nextRunAt && Date.parse(value.nextRunAt) <= nowMs)
        .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
      if (!schedule?.nextRunAt) return null;
      const workflow = state.workflows[schedule.workflowId], publication = (state.versions[schedule.workflowId] ?? []).findLast(value => value.artifactState === "PUBLISHED" && value.version === schedule.workflowVersion);
      const scheduledFor = schedule.nextRunAt, occurrenceId = `occurrence-${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 39)}`;
      const existing = state.scheduleOccurrences[occurrenceId]; if (existing) return { schedule: structuredClone(schedule), occurrence: structuredClone(existing) };
      let reportWindow: ReportWindow;
      try { reportWindow = reportWindowFor(schedule.timezone, scheduledFor, schedule.reportingPeriod); }
      catch {
        const reason = "Reporting-period semantics are unsupported or the local report day cannot be resolved; save a new schedule revision";
        const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id,
          scheduleRevision: schedule.revision, workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash,
          scheduledFor, localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone,
          servicePrincipalId: schedule.servicePrincipalId, state: "BLOCKED", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
          reason, createdAt: new Date(nowMs).toISOString() };
        state.scheduleOccurrences[occurrenceId] = occurrence; schedule.state = "BLOCKED"; schedule.lastError = reason; schedule.nextRunAt = null; schedule.updatedAt = new Date(nowMs).toISOString();
        return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
      }
      if (!workflow || workflow.archived || workflow.publishedVersion !== schedule.workflowVersion || workflowContentHash(workflow.yaml) !== schedule.workflowHash || publication?.yaml !== workflow.yaml) {
        const reason = "Pinned workflow publication changed or is unavailable";
        const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id,
          scheduleRevision: schedule.revision, workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash,
          scheduledFor, localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone, reportWindow,
          servicePrincipalId: schedule.servicePrincipalId, state: "BLOCKED", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
          reason, createdAt: new Date(nowMs).toISOString() };
        state.scheduleOccurrences[occurrenceId] = occurrence;
        schedule.state = "BLOCKED"; schedule.lastError = reason; schedule.nextRunAt = null; schedule.updatedAt = new Date(nowMs).toISOString();
        return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
      }
      const lateMs = nowMs - Date.parse(scheduledFor), skipped = schedule.misfirePolicy === "SKIP" && lateMs > schedule.misfireGraceSeconds * 1000;
      const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id, scheduleRevision: schedule.revision,
        workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash, scheduledFor,
        localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone, reportWindow, servicePrincipalId: schedule.servicePrincipalId,
        state: skipped ? "SKIPPED" : "ADMITTING", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
        createdAt: new Date(nowMs).toISOString(), ...(skipped ? { reason: "Occurrence exceeded the configured misfire grace window; no execution was admitted" } : {}) };
      state.scheduleOccurrences[occurrenceId] = occurrence;
      if (skipped) { schedule.lastOccurrenceAt = scheduledFor; schedule.nextRunAt = nextDailyOccurrence(schedule.timezone, schedule.localTime, nowMs); schedule.updatedAt = new Date(nowMs).toISOString(); }
      return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
    });
  }
  private async admit(claim: Claim, nowMs: number): Promise<"ADMITTED" | "BLOCKED" | null> {
    if (!claim.occurrence.reportWindow) return this.block(claim, "Occurrence has no immutable report window; save a new schedule revision");
    if (claim.occurrence.scheduleRevision !== claim.schedule.revision)
      return this.block(claim, "Occurrence belongs to an older schedule revision and cannot use newer inputs");
    if (!claim.schedule.reportWindowBinding)
      return this.block(claim, "Schedule has no reviewed report-window input binding; save a new schedule revision");
    const principal = await this.services.repository.effectiveUser(claim.schedule.servicePrincipalId);
    if (!principal) return this.block(claim, "Named service principal is unavailable");
    try {
      const prepared = await this.services.repository.readAuthoritative(state => {
        const workflow = state.workflows[claim.schedule.workflowId], publication = (state.versions[claim.schedule.workflowId] ?? [])
          .findLast(value => value.artifactState === "PUBLISHED" && value.version === claim.schedule.workflowVersion && value.yaml === workflow?.yaml);
        if (!workflow || !publication) throw new HandlerFailure(409, "Pinned workflow publication is unavailable");
        const compiled = prepareOperationExecution(state, this.services, publication, workflow.yaml, principal.role);
        const input = bindReportWindowInput(compiled.plan, claim.schedule.input, claim.schedule.reportWindowBinding!, claim.occurrence.reportWindow!, this.services.registries.snapshot().tools);
        return { workflow: structuredClone(workflow), input };
      });
      const source = { profile: "workflow-schedule-source/v1" as const, scheduleId: claim.schedule.id, scheduleRevision: claim.schedule.revision,
        occurrenceId: claim.occurrence.id, scheduledFor: claim.occurrence.scheduledFor, scheduleHash: claim.schedule.scheduleHash,
        reportWindow: structuredClone(claim.occurrence.reportWindow),
        reportWindowBinding: structuredClone(claim.schedule.reportWindowBinding), inputHash: digest(prepared.input) };
      const result = await operationJobQueue(this.services).admit(prepared.workflow, prepared.input, principal, claim.occurrence.idempotencyKey,
        `schedule:${claim.schedule.id}:${claim.occurrence.id}`, source);
      await this.services.repository.mutate(state => {
        const occurrence = state.scheduleOccurrences[claim.occurrence.id], schedule = state.schedules[claim.schedule.id];
        if (!occurrence || occurrence.state !== "ADMITTING") return;
        occurrence.state = "ADMITTED"; occurrence.executionId = String((result.execution as { id?: unknown }).id); occurrence.admittedAt = new Date(nowMs).toISOString();
        if (schedule?.revision === claim.schedule.revision) {
          schedule.lastOccurrenceAt = occurrence.scheduledFor; schedule.nextRunAt = nextDailyOccurrence(schedule.timezone, schedule.localTime, nowMs);
          schedule.updatedAt = new Date(nowMs).toISOString(); delete schedule.lastError;
        }
      });
      return "ADMITTED";
    } catch (error) {
      if (error instanceof HandlerFailure && error.status < 500) return this.block(claim, error.message);
      return null;
    }
  }
  private async block(claim: Claim, reason: string): Promise<"BLOCKED"> {
    await this.services.repository.mutate(state => {
      const occurrence = state.scheduleOccurrences[claim.occurrence.id], schedule = state.schedules[claim.schedule.id];
      if (occurrence?.state === "ADMITTING") { occurrence.state = "BLOCKED"; occurrence.reason = reason; }
      if (schedule?.revision === claim.schedule.revision && claim.occurrence.scheduleRevision === claim.schedule.revision) {
        schedule.state = "BLOCKED"; schedule.nextRunAt = null; schedule.lastError = reason; schedule.updatedAt = new Date().toISOString();
      }
    });
    return "BLOCKED";
  }
  async stop() { this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#unobserve(); }
}
