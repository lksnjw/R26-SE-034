import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import type { Repository, RepositoryState, ScheduleOccurrence, WorkflowSchedule } from "../repository/store.js";
import { workflowContentHash } from "../parser/workflow.js";
import { isSecretField, withoutSecretFields } from "../redact/secrets.js";
import { prepareOperationExecution } from "../workflows/operation-compilation-lifecycle.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { operationJobQueue, supportsOperationJobs } from "./operation-jobs.js";
import { canViewWorkflow } from "../workflows/commands.js";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const dailyScheduleCommandSchema = z.object({
  profile: z.literal("workflow-daily-schedule-command/v1"),
  baseRevision: z.number().int().min(0),
  workflowVersion: z.number().int().positive(),
  workflowHash: hash,
  enabled: z.boolean(),
  timezone: z.string().trim().min(1).max(128),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  reportingPeriod: z.string().trim().min(1).max(128),
  misfirePolicy: z.enum(["SKIP", "FIRE_ONCE"]),
  misfireGraceSeconds: z.number().int().min(60).max(86_400),
  servicePrincipalId: z.string().min(1).max(256),
  input: z.record(z.string(), z.unknown()),
}).strict();
export type DailyScheduleCommand = z.infer<typeof dailyScheduleCommandSchema>;

const formatter = (timezone: string) => {
  try { return new Intl.DateTimeFormat("en-CA-u-nu-latn", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { throw new HandlerFailure(422, "Timezone must be a supported IANA timezone", { code: "SCHEDULE_TIMEZONE_INVALID" }); }
};
function localParts(timezone: string, instant: number, dateFormatter = formatter(timezone)) {
  const values = Object.fromEntries(dateFormatter.formatToParts(new Date(instant)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
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
function publicSchedule(schedule: WorkflowSchedule | null) { return schedule ? withoutSecretFields(schedule) : null; }
function publicOccurrence(value: ScheduleOccurrence) {
  const { idempotencyKey: _idempotencyKey, ...visible } = value;
  return withoutSecretFields(visible);
}
function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => isSecretField(key) || containsSecretField(child));
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
    if (compiled.plan.ir.inputSchema && validateToolInput(compiled.plan.ir.inputSchema, command.input).length)
      throw new HandlerFailure(422, "Schedule input does not match the published workflow input schema");
    const scheduleHash = digest({ profile: command.profile, workflowId, workflowVersion: command.workflowVersion, workflowHash: command.workflowHash,
      timezone: command.timezone, localTime: command.localTime, reportingPeriod: command.reportingPeriod, misfirePolicy: command.misfirePolicy,
      misfireGraceSeconds: command.misfireGraceSeconds, servicePrincipalId: command.servicePrincipalId, input: command.input });
    const unchanged = previous?.scheduleHash === scheduleHash && previous.state === "ACTIVE" && previous.nextRunAt && Date.parse(previous.nextRunAt) > Date.now();
    const schedule: WorkflowSchedule = { profile: "workflow-daily-schedule/v1", id: scheduleId, workflowId, workflowVersion: command.workflowVersion,
      workflowHash: command.workflowHash, state: command.enabled ? "ACTIVE" : "PAUSED", revision: (previous?.revision ?? 0) + 1,
      timezone: command.timezone, localTime: command.localTime, reportingPeriod: command.reportingPeriod, misfirePolicy: command.misfirePolicy,
      misfireGraceSeconds: command.misfireGraceSeconds, servicePrincipalId: command.servicePrincipalId, input: structuredClone(command.input),
      nextRunAt: command.enabled ? unchanged ? previous.nextRunAt : nextDailyOccurrence(command.timezone, command.localTime, Date.now()) : null,
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
      if (!workflow || workflow.archived || workflow.publishedVersion !== schedule.workflowVersion || workflowContentHash(workflow.yaml) !== schedule.workflowHash || publication?.yaml !== workflow.yaml) {
        const reason = "Pinned workflow publication changed or is unavailable";
        const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id,
          scheduleRevision: schedule.revision, workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash,
          scheduledFor, localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone,
          servicePrincipalId: schedule.servicePrincipalId, state: "BLOCKED", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
          reason, createdAt: new Date(nowMs).toISOString() };
        state.scheduleOccurrences[occurrenceId] = occurrence;
        schedule.state = "BLOCKED"; schedule.lastError = reason; schedule.nextRunAt = null; schedule.updatedAt = new Date(nowMs).toISOString();
        return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
      }
      const lateMs = nowMs - Date.parse(scheduledFor), skipped = schedule.misfirePolicy === "SKIP" && lateMs > schedule.misfireGraceSeconds * 1000;
      const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id, scheduleRevision: schedule.revision,
        workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash, scheduledFor,
        localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone, servicePrincipalId: schedule.servicePrincipalId,
        state: skipped ? "SKIPPED" : "ADMITTING", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
        createdAt: new Date(nowMs).toISOString(), ...(skipped ? { reason: "Occurrence exceeded the configured misfire grace window; no execution was admitted" } : {}) };
      state.scheduleOccurrences[occurrenceId] = occurrence;
      if (skipped) { schedule.lastOccurrenceAt = scheduledFor; schedule.nextRunAt = nextDailyOccurrence(schedule.timezone, schedule.localTime, nowMs); schedule.updatedAt = new Date(nowMs).toISOString(); }
      return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
    });
  }
  private async admit(claim: Claim, nowMs: number): Promise<"ADMITTED" | "BLOCKED" | null> {
    const principal = await this.services.repository.effectiveUser(claim.schedule.servicePrincipalId);
    if (!principal) return this.block(claim, "Named service principal is unavailable");
    const workflow = await this.services.repository.readAuthoritative(state => structuredClone(state.workflows[claim.schedule.workflowId]));
    if (!workflow) return this.block(claim, "Pinned workflow is unavailable");
    try {
      const source = { profile: "workflow-schedule-source/v1" as const, scheduleId: claim.schedule.id, scheduleRevision: claim.schedule.revision,
        occurrenceId: claim.occurrence.id, scheduledFor: claim.occurrence.scheduledFor };
      const result = await operationJobQueue(this.services).admit(workflow, claim.schedule.input, principal, claim.occurrence.idempotencyKey,
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
      if (schedule?.revision === claim.schedule.revision) { schedule.state = "BLOCKED"; schedule.nextRunAt = null; schedule.lastError = reason; schedule.updatedAt = new Date().toISOString(); }
    });
    return "BLOCKED";
  }
  async stop() { this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#unobserve(); }
}
