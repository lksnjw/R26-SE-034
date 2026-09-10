import { randomBytes } from "node:crypto";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import type { CurrentUser, HandlerServices } from "../http/handlers/common.js";
import { HandlerFailure, validateWorkflow } from "../http/handlers/common.js";
import type { Execution, ReportWindow, ReportWindowInputBinding, Repository, RepositoryState } from "../repository/store.js";
import type { Workflow } from "../models/schemas.js";
import { workflowContentHash } from "../parser/workflow.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { newReadProgress, appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import { prepareOperationExecution } from "../workflows/operation-compilation-lifecycle.js";
import { resolveReadBinding, type CompiledOperationPlan } from "../workflows/compiled-read.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { dispatchReadTool } from "../tools/read-tool-broker.js";
import { createDispatchIdentity } from "../tools/registry.js";
import { issueOperationDispatchPermit, retireOperationDispatchPermit } from "../tools/operation-dispatch-permit.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { assertConsumedRuntimeApproval, consumeRuntimeApproval, requestRuntimeApproval, runtimeApprovalPolicyHash } from "./runtime-approvals.js";
import type { OperationIntent } from "./operation-state.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { assertReportCursorProgress, assertReportPageProgress, assertScheduledReportCoverageReceipt, completeCursorPaginatedReport, completePaginatedReport,
  assertReportRelatedKeyProgress, confirmScheduledReportCoverage, confirmScheduledReportCursor, confirmScheduledReportPage, newReportCursorProgress, newReportPageProgress,
  protectedReportPageOutput, reportPagination, type ReportCoverageReceipt } from "../tools/report-coverage-contract.js";

const queues = new WeakMap<Repository, OperationJobQueue>();
const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
export function supportsOperationJobs(services: HandlerServices): boolean {
  const storage = services.repository.persistence;
  return storage === null || storage.readQueueDurability === "encrypted-single-writer" && storage.executionCheckpointDurability === "encrypted-record-transactions/v1" && !!storage.saveExecutionCheckpoint;
}
export function operationJobQueue(services: HandlerServices): OperationJobQueue {
  let queue = queues.get(services.repository);
  if (!queue || queue.closed) { queue = new OperationJobQueue(services); queues.set(services.repository, queue); }
  return queue;
}
type Active = { id: string; actorId: string; leaseId: string; controller: AbortController; valid: boolean; expiresAt: number; governanceHash?: string; timer?: NodeJS.Timeout; task?: Promise<void> };
function audit(state: RepositoryState, run: Execution, action: string) {
  state.auditLogs.push({ id: `operation-audit-${randomBytes(12).toString("hex")}`, actor: run.startedBy, source: "operation-job/v1", action,
    resource: { type: "execution", id: run.id }, after: { status: run.status }, createdAt: new Date().toISOString() });
}
function finish(state: RepositoryState, run: Execution, status: string, summary: string) {
  run.status = status; run.completedAt = new Date().toISOString(); run.durationMs = Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)); run.agentSummary = summary;
  if (run.operationSecret) { run.operationSecret.state = status === "RECOVERY_REQUIRED" || status === "RECONCILIATION_REQUIRED" ? "RECOVERY_REQUIRED" : "FINISHED"; delete run.operationSecret.lease; }
  if (status === "FAILED" || status === "CANCELLED") for (const attempt of Object.values(run.readProgress?.attempts ?? {})) {
    if (attempt.status !== "PREPARING") continue;
    attempt.status = status; attempt.completedAt = run.completedAt;
    const entry = state.timelines[run.id]?.find(item => item.attemptId === attempt.id);
    if (entry) Object.assign(entry, { status, outcome: "NOT_DISPATCHED", completedAt: run.completedAt });
    appendExecutionEvent(state, run, "node.not_dispatched", { outcome: "NOT_DISPATCHED", status }, attempt.nodeId, attempt.id);
  }
  appendExecutionEvent(state, run, `run.${status.toLowerCase()}`, { status }); audit(state, run, `execution.${status.toLowerCase()}`);
}
function recover(state: RepositoryState, run: Execution, reason: string) {
  if (run.operationSecret?.state !== "CLAIMED" || run.status !== "RUNNING") return;
  const progress = run.readProgress!, attempt = Object.values(progress.attempts).findLast(item => ["PREPARING", "DISPATCH_INTENT"].includes(item.status));
  const resumablePages = attempt?.status === "PREPARING" ? run.reportPageSecret?.[attempt.nodeId] : undefined;
  const pageInFlight = attempt && Object.values(run.operationSecret.intents).some(intent => intent.nodeId === attempt.nodeId && intent.state === "DISPATCH_INTENT");
  if (attempt && resumablePages && !pageInFlight) {
    progress.epoch++; progress.recoveryReason = reason; run.status = "PENDING"; run.agentSummary = "Confirmed report pages were saved. The next bounded page is queued; no uncertain page is replayed.";
    run.operationSecret.state = "QUEUED"; delete run.operationSecret.lease;
    appendExecutionEvent(state, run, "node.report_pages_requeued", { nextPage: resumablePages.profile === "schedule-report-pages/v1" ? resumablePages.nextPage : resumablePages.pages.length + 1,
      confirmedPages: resumablePages.pages.length, continuationProfile: resumablePages.profile, reason }, attempt.nodeId, attempt.id);
    audit(state, run, "operation.report_pages_requeued"); return;
  }
  const uncertain = attempt?.status === "DISPATCH_INTENT";
  if (attempt) {
    attempt.status = uncertain ? "UNKNOWN" : "FAILED"; attempt.completedAt = new Date().toISOString();
    const intent = Object.values(run.operationSecret.intents).findLast(value => value.nodeId === attempt.nodeId && value.state === "DISPATCH_INTENT"); if (intent) intent.state = "UNKNOWN";
    const entry = state.timelines[run.id]?.find(item => item.attemptId === attempt.id);
    if (entry) { entry.status = uncertain ? "UNKNOWN" : "FAILED"; entry.outcome = uncertain ? "UNKNOWN" : "NOT_DISPATCHED"; entry.completedAt = attempt.completedAt; }
    appendExecutionEvent(state, run, uncertain ? "node.outcome_unknown" : "node.interrupted", { outcome: uncertain ? "UNKNOWN" : "NOT_DISPATCHED", reason }, attempt.nodeId, attempt.id);
  }
  progress.epoch++; progress.recoveryReason = reason;
  run.failure = { failureCategory: uncertain ? "OPERATION_OUTCOME_UNKNOWN" : "OPERATION_INTERRUPTED", failedStepId: attempt?.nodeId ?? "checkpoint", reason };
  finish(state, run, uncertain ? "RECONCILIATION_REQUIRED" : "RECOVERY_REQUIRED", uncertain ? "An operation intent has no confirmed outcome. Saved results are retained; the action was not automatically replayed. Reconcile with the ERP before retrying." : "Execution was interrupted before a new dispatch. Saved results are retained; recovery requires fresh authorization.");
}
function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Scheduled report evidence is not an object result");
  return value as Record<string, unknown>;
}
function assertCoverageBeforeScheduledEffect(run: Execution, plan: CompiledOperationPlan, live: readonly ToolDefinition[], effectIndex: number): void {
  const source = run.scheduleSource;
  if (!source) return;
  const scheduledReads = plan.ir.root.nodes.slice(0, effectIndex).filter(node => node.effectClass === "read" &&
    live.some(tool => tool.tool_id === node.capability.toolId && tool.report_coverage_contract));
  if (!scheduledReads.length) throw new Error("Scheduled effects require prior confirmed report coverage");
  const receipts = run.reportCoverages ?? (run.reportCoverage ? { [run.reportCoverage.nodeId]: run.reportCoverage } : {});
  const requiredReceipts: ReportCoverageReceipt[] = [];
  for (const node of scheduledReads) {
    const receipt = receipts[node.id], tool = live.find(value => value.tool_id === node.capability.toolId);
    if (!receipt || !tool?.report_coverage_contract || tool.tool_id !== receipt.toolId || node.capability.contractHash !== receipt.contractHash)
      throw new Error("Scheduled report coverage no longer matches the reviewed read contract");
    const args = resolveReadBinding(node.inputs, { input: run.workflowSnapshot!.input, ...run.stepOutputs }) as Record<string, unknown>;
    assertScheduledReportCoverageReceipt(receipt, { tool, nodeId: node.id, contractHash: node.capability.contractHash, args,
      output: recordValue(run.stepOutputs?.[node.id]), startAt: source.reportWindow.startAt, endAt: source.reportWindow.endAt });
    requiredReceipts.push(receipt);
  }
  const projected = requiredReceipts.filter(receipt => receipt.relatedRecords?.mode === "PROJECTED");
  const matched = requiredReceipts.filter(receipt => receipt.relatedRecords?.mode === "REQUESTED_MATCHED");
  if (projected.length || matched.length) {
    if (projected.length !== 1 || matched.length !== 1 || projected[0]!.relatedRecords!.relationName !== matched[0]!.relatedRecords!.relationName ||
        projected[0]!.relatedRecords!.keysHash !== matched[0]!.relatedRecords!.keysHash ||
        projected[0]!.relatedRecords!.keyCount !== matched[0]!.relatedRecords!.keyCount)
      throw new Error("Scheduled related-record coverage is missing or inconsistent");
  }
}
/** Separate fair, bounded single-writer operation worker. Waits hold no worker
 * or HTTP/DB transaction; restart never automatically replays an intent. */
export class OperationJobQueue {
  readonly #workerId = `operation-worker-${randomBytes(16).toString("hex")}`;
  readonly #active = new Map<string, Active>();
  readonly #unsubscribe: () => void;
  #closed = false; #started = false; #pumping = false; #repump = false; #stalled = false; #lastActor = "";
  #waitTimer: NodeJS.Timeout | undefined;
  get closed() { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    if (!supportsOperationJobs(services)) throw new HandlerFailure(503, "Operations require qualified encrypted scoped persistence", { code: "OPERATION_STORAGE_UNSUPPORTED" });
    this.#unsubscribe = services.repository.observeCommits({ committed: state => { this.observe(state); this.scheduleWaitExpiry(state);
      if (Object.values(state.executions).some(run => run.operationSecret?.state === "QUEUED" && run.status === "PENDING")) this.kick();
    }, unavailable: () => {
      this.#stalled = true; for (const control of this.#active.values()) { control.valid = false; control.controller.abort(new Error("Operation storage authority unavailable")); }
    } });
  }
  private scheduleWaitExpiry(state: Readonly<RepositoryState>) {
    if (this.#waitTimer) clearTimeout(this.#waitTimer); this.#waitTimer = undefined;
    if (!this.#started || this.#closed || this.#stalled) return;
    const deadlines = Object.values(state.executions).filter(run => run.status === "AWAITING_APPROVAL" && run.operationSecret?.state === "WAITING")
      .map(run => Date.parse(run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId]?.expiresAt ?? "")).filter(Number.isFinite);
    if (!deadlines.length) return;
    this.#waitTimer = setTimeout(() => { void this.expireWaits().catch(() => { this.#stalled = true; }); }, Math.max(1, Math.min(...deadlines) - Date.now())); this.#waitTimer.unref();
  }
  private async expireWaits() {
    const ids = await this.services.repository.readAuthoritative(state => Object.values(state.executions).filter(run => run.status === "AWAITING_APPROVAL" && run.operationSecret?.state === "WAITING" &&
      Date.parse(run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId]?.expiresAt ?? "") <= Date.now()).map(run => run.id));
    for (const id of ids) await this.services.repository.mutateExecution(id, state => {
      const run = state.executions[id]!, record = run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId];
      if (run.status !== "AWAITING_APPROVAL" || run.operationSecret?.state !== "WAITING" || !record || Date.parse(record.expiresAt) > Date.now()) return;
      delete run.pendingApproval; run.failure = { failureCategory: "RUNTIME_APPROVAL_EXPIRED", failedStepId: record.binding.nodeId };
      finish(state, run, "FAILED", "The exact approval expired before dispatch. Previous saved results remain available; no automatic operation replay occurred.");
    });
  }
  private observe(state: Readonly<RepositoryState>) {
    for (const control of this.#active.values()) {
      try {
        const run = state.executions[control.id], job = run?.operationSecret;
        if (!run || run.status !== "RUNNING" || !job || job.state !== "CLAIMED" || job.lease?.id !== control.leaseId || job.lease.workerId !== this.#workerId || job.lease.expiresAt <= Date.now() || run.readProgress?.cancellation || state.users[job.actorId]?.roleId !== job.roleId) throw new Error("Operation claim changed");
        assertCurrentRunController(state as RepositoryState, run, job.actorId, job.admittedRole);
        if (control.governanceHash && control.governanceHash !== digest(state.governancePolicy)) throw new Error("Operation governance policy changed");
        const snapshot = run.workflowSnapshot!, publication = state.versions[run.workflowId]?.findLast(item => item.version === snapshot.version && item.artifactState === "PUBLISHED");
        if (!publication || publication.yaml !== snapshot.yaml) throw new Error("Operation publication changed");
        prepareOperationExecution(state, this.services, publication, snapshot.yaml, job.admittedRole, snapshot.operationCompilation);
        const active = run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId];
        if (active?.state === "CONSUMED" && run.readProgress?.attempts[active.binding.nodeId]?.status === "DISPATCH_INTENT") assertConsumedRuntimeApproval(state as RepositoryState, run.id, active.consumption!.intentId);
        control.valid = true; control.expiresAt = job.lease.expiresAt;
      } catch { control.valid = false; control.controller.abort(new Error("Current operation authorization changed")); }
    }
  }
  private assert(control: Active) {
    this.services.repository.assertAuthority();
    if (this.#closed || this.#stalled || !control.valid || control.controller.signal.aborted || Date.now() >= control.expiresAt) throw new Error("Operation worker is fenced");
  }
  async admit(workflow: Workflow, rawInput: Record<string, unknown>, user: CurrentUser, key: string, traceId: string,
    source?: { profile: "workflow-schedule-source/v1"; scheduleId: string; scheduleRevision: number; occurrenceId: string; scheduledFor: string;
      scheduleHash: string; reportWindow: ReportWindow; reportWindowBinding: ReportWindowInputBinding; inputHash: string }) {
    if (workflow.recoverySource) throw new HandlerFailure(409, "Linked recovery workflows can only be admitted once through their exact source artifact", { code: "RECOVERY_ARTIFACT_ADMISSION_REQUIRED" });
    if (workflow.emailDeliverySource) throw new HandlerFailure(409, "Linked email-delivery workflows can only be admitted once from their exact reviewed draft", { code: "EMAIL_DELIVERY_ADMISSION_REQUIRED" });
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HandlerFailure(422, "Operation runs require a stable 16–128 character idempotency key", { code: "OPERATION_KEY_REQUIRED" });
    const input = structuredClone(rawInput);
    if (canonicalJSONBytes(input).length > 64000) throw new HandlerFailure(422, "Operation input exceeds supported bounds");
    // Stable through credential/key rotation. The private scope is an identity,
    // not dispatch authority or an upstream idempotency promise.
    const scope = digest(["operation/v1", user.id, workflow.id, key]);
    const fingerprint = digest({ sourceHash: workflowContentHash(workflow.yaml), version: workflow.publishedVersion, input, source: source ?? null });
    const result = await this.services.repository.mutate(state => {
      const existing = Object.values(state.executions).find(run => run.operationSecret?.idempotencyScope === scope);
      if (existing) {
        if (existing.operationSecret!.requestFingerprint !== fingerprint) throw new HandlerFailure(409, "Operation key already belongs to different inputs or publication");
        assertCurrentRunController(state, existing, user.id, user.role);
        return { execution: withoutSecretFields(existing), replayed: true };
      }
      const current = state.workflows[workflow.id], publication = state.versions[workflow.id]?.findLast(item => item.version === workflow.publishedVersion && item.artifactState === "PUBLISHED");
      if (!current || current.archived || current.yaml !== workflow.yaml || current.publishedVersion !== workflow.publishedVersion || !publication || publication.yaml !== workflow.yaml || current.pendingGenerationApproval?.steps.length) throw new HandlerFailure(409, "A current accepted immutable operation publication is required");
      if (source) {
        const schedule = state.schedules[source.scheduleId], occurrence = state.scheduleOccurrences[source.occurrenceId];
        if (!schedule || schedule.state !== "ACTIVE" || schedule.revision !== source.scheduleRevision || schedule.scheduleHash !== source.scheduleHash ||
          schedule.workflowId !== workflow.id || schedule.workflowVersion !== workflow.publishedVersion || schedule.servicePrincipalId !== user.id ||
          !occurrence || occurrence.state !== "ADMITTING" || occurrence.scheduleId !== source.scheduleId || occurrence.scheduleRevision !== source.scheduleRevision ||
          occurrence.scheduledFor !== source.scheduledFor || canonicalJSONBytes(occurrence.reportWindow).compare(canonicalJSONBytes(source.reportWindow)) !== 0 ||
          canonicalJSONBytes(schedule.reportWindowBinding).compare(canonicalJSONBytes(source.reportWindowBinding)) !== 0 || digest(input) !== source.inputHash)
          throw new HandlerFailure(409, "Schedule or occurrence changed before final admission", { code: "SCHEDULE_ADMISSION_CHANGED" });
      }
      const compiled = prepareOperationExecution(state, this.services, publication, workflow.yaml, user.role);
      if (compiled.plan.ir.inputSchema && validateToolInput(compiled.plan.ir.inputSchema, input).length) throw new HandlerFailure(422, "Operation input does not match its schema");
      runtimeApprovalPolicyHash(state);
      const id = `operation-${randomBytes(16).toString("hex")}`, now = new Date().toISOString();
      const run: Execution = { id, workflowId: workflow.id, workflowName: workflow.name, status: "PENDING", startedAt: now, completedAt: null, durationMs: 0,
        startedBy: { id: user.id, name: user.name }, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, traceId,
        workflowSnapshot: { yaml: workflow.yaml, version: workflow.publishedVersion, contentHash: compiled.plan.sourceHash, registryHash: compiled.receipt.registryHash, input,
          executionProfile: "sequential-operation-v1", operationCompilation: compiled.receipt }, readProgress: newReadProgress(this.services.repository), stepOutputs: {},
        operationSecret: { profile: "operation-job/v1", actorId: user.id, roleId: state.users[user.id]!.roleId, admittedRole: user.role, state: "QUEUED", idempotencyScope: scope, requestFingerprint: fingerprint, createdAt: now, intents: {} },
        ...(source ? { scheduleSource: structuredClone(source) } : {}),
        agentSummary: "Operation queued. Each write requires an independent exact approval; nothing is confirmed by queue admission." };
      assertCurrentRunController(state, run, user.id, user.role);
      state.executions[id] = run; state.timelines[id] = []; state.executionEvents[id] = []; state.executionLogs[id] = [];
      appendExecutionEvent(state, run, "run.queued", { profile: "operation-job/v1", persistence: run.readProgress!.persistence }); audit(state, run, "execution.queued");
      return { execution: withoutSecretFields(run), replayed: false };
    });
    this.kick(); return result;
  }
  async start() {
    if (this.#started || this.#closed) return; this.#started = true;
    const jobs = await this.services.repository.read(state => Object.values(state.executions).filter(run => run.operationSecret).map(run => ({ id: run.id, state: run.operationSecret!.state })));
    for (const { id } of jobs.filter(job => job.state === "CLAIMED")) await this.services.repository.mutateExecution(id, state => recover(state, state.executions[id]!, "OPERATION_WORKER_RESTARTED"));
    if (jobs.some(job => job.state === "WAITING")) await this.services.repository.readAuthoritative(state => this.scheduleWaitExpiry(state));
    if (jobs.some(job => job.state === "QUEUED")) this.kick();
  }
  kick() {
    if (!this.#started || this.#closed || this.#stalled) return;
    if (this.#pumping) { this.#repump = true; return; }
    void this.pump().catch(() => { this.#stalled = true; });
  }
  private async pump() {
    this.#pumping = true;
    try {
      while (!this.#closed && !this.#stalled && this.#active.size < this.services.config.readWorkerConcurrency) {
        const id = await this.services.repository.readAuthoritative(state => {
          const counts = new Map<string, number>(); for (const c of this.#active.values()) counts.set(c.actorId, (counts.get(c.actorId) ?? 0) + 1);
          const pending = Object.values(state.executions).filter(run => run.status === "PENDING" && run.operationSecret?.profile === "operation-job/v1" && run.operationSecret.state === "QUEUED" && !this.#active.has(run.id) && (counts.get(run.operationSecret.actorId) ?? 0) < this.services.config.readWorkerPerActor)
            .sort((a, b) => a.operationSecret!.createdAt.localeCompare(b.operationSecret!.createdAt) || a.id.localeCompare(b.id));
          return pending.find(run => run.operationSecret!.actorId !== this.#lastActor)?.id ?? pending[0]?.id;
        });
        if (!id) break;
        const actorId = await this.services.repository.readAuthoritative(state => state.executions[id]!.operationSecret!.actorId);
        const control: Active = { id, actorId, leaseId: randomBytes(16).toString("hex"), controller: new AbortController(), valid: false, expiresAt: 0 };
        this.#active.set(id, control); this.#lastActor = actorId;
        control.task = this.process(control).catch(() => {}).finally(() => { if (control.timer) clearInterval(control.timer); this.#active.delete(id); this.kick(); });
      }
    } finally { this.#pumping = false; if (this.#repump) { this.#repump = false; this.kick(); } }
  }
  private async process(control: Active) {
    const { services } = this, repository = services.repository, id = control.id;
    let knownCoverageFailure: { nodeId: string; intentKey: string; intentId: string; output: Record<string, unknown>; message: string } | undefined;
    try {
      const initial = await repository.mutateExecution(id, state => {
        const run = state.executions[id]!, job = run.operationSecret!;
        if (run.status !== "PENDING" || job.state !== "QUEUED") throw new Error("Operation is not queued");
        assertCurrentRunController(state, run, job.actorId, job.admittedRole);
        run.status = "RUNNING"; job.state = "CLAIMED"; job.lease = { id: control.leaseId, workerId: this.#workerId, expiresAt: Date.now() + services.config.readWorkerLeaseMs };
        appendExecutionEvent(state, run, "run.started", { profile: "operation-job/v1" }); return structuredClone(run);
      });
      this.assert(control);
      control.timer = setInterval(() => { void repository.mutateExecution(id, state => {
        this.assert(control); const run = state.executions[id]!; if (run.operationSecret?.lease?.id !== control.leaseId) throw new Error("Operation lease changed");
        run.operationSecret.lease.expiresAt = Date.now() + services.config.readWorkerLeaseMs;
      }).catch(() => { control.valid = false; control.controller.abort(); }); }, Math.max(1000, Math.floor(services.config.readWorkerLeaseMs / 3))); control.timer.unref();
      const snapshot = initial.workflowSnapshot!, actor = await repository.effectiveUser(control.actorId);
      if (!actor || actor.role !== initial.operationSecret!.admittedRole) throw new Error("Operation actor changed");
      const plan = await repository.readAuthoritative(state => {
        control.governanceHash = digest(state.governancePolicy);
        const publication = state.versions[initial.workflowId]?.findLast(item => item.version === snapshot.version && item.artifactState === "PUBLISHED");
        if (!publication || publication.yaml !== snapshot.yaml) throw new Error("Operation publication changed");
        return prepareOperationExecution(state, services, publication, snapshot.yaml, actor.role, snapshot.operationCompilation).plan;
      });
      const session = services.erpbridgeSession!, generation = session.discoveryGeneration ?? 0, roleMap = canonicalJSONBytes(services.config.erpbridgeRoleMap);
      const assertContext = () => { this.assert(control); if (services.erpbridgeSession !== session || session.available === false || generation !== (session.discoveryGeneration ?? 0) || !roleMap.equals(canonicalJSONBytes(services.config.erpbridgeRoleMap)) || snapshot.registryHash !== services.registries.hash()) throw new Error("Operation connection or registry changed"); };
      const live = await discoverTools(session, services.registries); assertContext();
      const gate = await validateWorkflow(services, "OperationJobWorker", snapshot.yaml, actor, { executionId: id, workflowId: initial.workflowId, traceId: initial.traceId, signal: control.controller.signal });
      if (!gate.result.passed || !gate.token) throw new Error("Operation deterministic verification failed");
      for (let index = initial.readProgress!.nextStepIndex; index < plan.ir.root.nodes.length; index++) {
        assertContext(); const node = plan.ir.root.nodes[index]!, tool = live.find(tool => tool.tool_id === node.capability.toolId);
        if (!tool) throw new Error("Operation live tool is unavailable");
        const args = await repository.mutateExecution(id, state => {
          this.assert(control); const run = state.executions[id]!, progress = run.readProgress!;
          if (progress.nextStepIndex !== index) throw new Error("Operation pointer changed");
          if (!progress.attempts[node.id]) {
            const startedAt = new Date().toISOString(), attemptId = `${id}:${node.id}`;
            progress.attempts[node.id] = { id: attemptId, nodeId: node.id, stepIndex: index, status: "PREPARING", startedAt };
            (state.timelines[id] ??= []).push({ id: `timeline-${node.id}`, nodeId: node.id, attemptId, label: node.capability.action, status: "RUNNING", phase: "PREPARING", startedAt, sideEffect: node.effectClass !== "read" });
            appendExecutionEvent(state, run, "node.preparing", {}, node.id, attemptId);
          } else if (progress.attempts[node.id]!.status !== "PREPARING") throw new Error("An operation invocation cannot be replayed");
          return resolveReadBinding(node.inputs, { input: snapshot.input, ...run.stepOutputs }) as Record<string, unknown>;
        });
        if (validateToolInput(tool.input_schema, args).length) throw new Error("Resolved operation arguments are invalid");
        const issues = validateToolArguments(node.capability.action, args, tool);
        if (issues.missing.length || issues.invalid.length) throw new Error("Resolved operation arguments failed runtime validation");
        if (hasReservedBridgeRole(tool)) {
          const identity = createDispatchIdentity(actor, services.config.erpbridgeRoleMap);
          if (Object.hasOwn(args, "role") || !identity.erpbridgeRole || !tool.bridge_contract?.remote_roles.includes(identity.erpbridgeRole))
            throw new Error("Operation requires a current reviewed mapped ERPBridge role");
        }
        const pagination = node.effectClass === "read" && initial.scheduleSource ? reportPagination(tool) : null;
        if (pagination?.profile === "opaque-cursor/v1") {
          if (Object.hasOwn(args, pagination.cursor_parameter)) throw new Error("Workflow-authored report cursor values are not allowed");
          let cursorDone = false;
          while (!cursorDone) {
            assertContext();
            const cursorState = await repository.mutateExecution(id, state => {
              this.assert(control); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!;
              if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index || run.reportCoverages?.[node.id] || run.reportCoverage?.nodeId === node.id) throw new Error("Report cursor pointer changed");
              const existing = run.reportPageSecret?.[node.id];
              if (existing && existing.profile !== "schedule-report-cursors/v1") throw new Error("Report cursor profile changed");
              const progress = existing ?? newReportCursorProgress(tool, node.id, node.capability.contractHash,
                initial.scheduleSource!.reportWindow.startAt, initial.scheduleSource!.reportWindow.endAt);
              if (progress.nodeId !== node.id || progress.toolId !== tool.tool_id || progress.contractHash !== node.capability.contractHash ||
                  progress.startAt !== initial.scheduleSource!.reportWindow.startAt || progress.endAt !== initial.scheduleSource!.reportWindow.endAt ||
                  progress.maxPages !== pagination.max_pages)
                throw new Error("Report cursor evidence is inconsistent or exhausted");
              assertReportCursorProgress(tool, progress); (run.reportPageSecret ??= {})[node.id] = progress;
              return { ordinal: progress.pages.length + 1, cursor: progress.nextCursor, items: structuredClone(progress.items),
                pages: structuredClone(progress.pages), snapshotValue: progress.snapshotValue, totalCount: progress.totalCount };
            });
            const ordinal = cursorState.ordinal, cursorArgs = { ...structuredClone(args), [pagination.cursor_parameter]: cursorState.cursor };
            if (validateToolInput(tool.input_schema, cursorArgs).length) throw new Error("Server-derived report cursor arguments are invalid");
            const cursorIssues = validateToolArguments(node.capability.action, cursorArgs, tool);
            if (cursorIssues.missing.length || cursorIssues.invalid.length) throw new Error("Server-derived report cursor arguments failed runtime validation");
            const intentKey = `${node.id}:cursor:${ordinal}`, cursorIntentId = `intent-${randomBytes(16).toString("hex")}`;
            const persistCursorIntent = async () => { await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, progress = run.reportPageSecret?.[node.id];
              const fresh = resolveReadBinding(node.inputs, { input: run.workflowSnapshot!.input, ...run.stepOutputs });
              if (attempt.status !== "PREPARING" || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(args)) || !progress ||
                  progress.profile !== "schedule-report-cursors/v1" || progress.nextCursor !== cursorState.cursor || progress.pages.length + 1 !== ordinal ||
                  run.operationSecret!.intents[intentKey]) throw new Error("Report cursor intent facts changed or are already used");
              const now = new Date().toISOString(), intent: OperationIntent = { id: cursorIntentId, nodeId: node.id, invocationId: `${attempt.id}:cursor:${ordinal}`,
                operationKey: `${id}:${node.id}:cursor:${ordinal}`, argumentHash: digest(cursorArgs), state: "DISPATCH_INTENT", preparedAt: now };
              run.operationSecret!.intents[intentKey] = intent; attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.status = "RUNNING"; entry.phase = `CURSOR_PAGE_${ordinal}_DISPATCH_INTENT`;
              appendExecutionEvent(state, run, "node.report_page_dispatch_intent", { intentId: cursorIntentId, page: ordinal, continuationProfile: pagination.profile }, node.id, attempt.id);
              audit(state, run, "operation.report_page_dispatch_intent");
            }); };
            const cursorOutput = await dispatchReadTool(services, actor.id, node.capability.action, cursorArgs, { workflowId: initial.workflowId, executionId: id,
              signal: control.controller.signal, assertDispatch: assertContext, beforeDispatch: persistCursorIntent,
              plan: { yaml: snapshot.yaml, stepIndex: index, token: gate.token, admissionPin: node.capability.admission!, contractHash: node.capability.contractHash, toolId: node.capability.toolId } });
            let confirmed;
            try {
              confirmed = confirmScheduledReportCursor({ tool, args: cursorArgs, output: cursorOutput, startAt: initial.scheduleSource!.reportWindow.startAt,
                endAt: initial.scheduleSource!.reportWindow.endAt, cursor: cursorState.cursor, ordinal });
              const candidateItems = [...cursorState.items, ...confirmed.items];
              assertReportRelatedKeyProgress(tool, cursorArgs, candidateItems, confirmed.hasMore);
              if (cursorState.snapshotValue !== undefined && confirmed.snapshotValue !== cursorState.snapshotValue)
                throw new Error("Cursor-paginated report changed its stable snapshot between pages");
              if (cursorState.totalCount !== undefined && confirmed.totalCount !== cursorState.totalCount)
                throw new Error("Cursor-paginated report changed its total record count between pages");
              if (confirmed.hasMore && [...cursorState.pages.map(page => page.cursorHash), confirmed.evidence.cursorHash].includes(confirmed.evidence.nextCursorHash))
                throw new Error("Cursor-paginated report repeated a previously used cursor");
              if (confirmed.hasMore ? candidateItems.length >= confirmed.totalCount : candidateItems.length !== confirmed.totalCount)
                throw new Error("Cursor-paginated report exhaustion does not match its declared total record count");
              if (candidateItems.length > pagination.max_items || canonicalJSONBytes(candidateItems).length > 2_000_000 ||
                  confirmed.hasMore && cursorState.pages.length + 1 >= pagination.max_pages)
                throw new Error("Cursor-paginated report exceeded its reviewed page, item or byte bound before completeness");
            } catch (error) {
              knownCoverageFailure = { nodeId: node.id, intentKey, intentId: cursorIntentId, output: protectedReportPageOutput(tool, cursorOutput),
                message: error instanceof Error ? error.message : "Scheduled report cursor coverage is unconfirmed" }; throw error;
            }
            await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[intentKey], progress = run.reportPageSecret?.[node.id];
              if (attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== cursorIntentId || intent.state !== "DISPATCH_INTENT" || !progress ||
                  progress.profile !== "schedule-report-cursors/v1" || progress.nextCursor !== cursorState.cursor || progress.pages.length + 1 !== ordinal)
                throw new Error("Report cursor result does not own the current intent");
              if (progress.snapshotValue !== undefined && progress.snapshotValue !== confirmed.snapshotValue) throw new Error("Report snapshot changed before cursor checkpoint");
              if (progress.totalCount !== undefined && progress.totalCount !== confirmed.totalCount) throw new Error("Report total count changed before cursor checkpoint");
              const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now; progress.pages.push(confirmed.evidence);
              progress.snapshotValue ??= confirmed.snapshotValue; progress.totalCount ??= confirmed.totalCount; progress.items.push(...structuredClone(confirmed.items));
              progress.lastOutput = structuredClone(cursorOutput); progress.nextCursor = confirmed.nextCursor;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
              appendExecutionEvent(state, run, "node.report_page_completed", { intentId: cursorIntentId, page: ordinal, itemCount: confirmed.items.length,
                hasMore: confirmed.hasMore, continuationProfile: pagination.profile }, node.id, attempt.id);
              if (confirmed.hasMore) {
                attempt.status = "PREPARING"; entry.phase = `CURSOR_PAGE_${ordinal + 1}_PREPARING`; audit(state, run, "operation.report_page_acknowledged"); return;
              }
              const completed = completeCursorPaginatedReport(tool, progress);
              const receipt = confirmScheduledReportCoverage({ tool, nodeId: node.id, contractHash: node.capability.contractHash, args,
                output: completed.output, startAt: initial.scheduleSource!.reportWindow.startAt, endAt: initial.scheduleSource!.reportWindow.endAt,
                pagination: completed.receiptPagination, confirmedAt: now });
              attempt.status = "DONE"; attempt.completedAt = now; run.stepOutputs![node.id] = completed.output;
              (run.reportCoverages ??= {})[node.id] = structuredClone(receipt); run.reportCoverage ??= structuredClone(receipt); run.readProgress!.nextStepIndex++;
              delete run.reportPageSecret![node.id]; if (!Object.keys(run.reportPageSecret!).length) delete run.reportPageSecret;
              Object.assign(entry, { status: "DONE", phase: "COMPLETE", outcome: "REPORT_COVERAGE_CONFIRMED", completedAt: now,
                durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: withoutSecretFields(completed.output) });
              appendExecutionEvent(state, run, "node.completed", { intentId: cursorIntentId, outcome: "REPORT_COVERAGE_CONFIRMED",
                pageCount: receipt.pagination!.pageCount, continuationProfile: pagination.profile }, node.id, attempt.id);
              audit(state, run, "operation.report_pages_completed"); cursorDone = true;
            });
          }
          continue;
        }
        if (pagination) {
          if (Object.hasOwn(args, pagination.page_parameter)) throw new Error("Workflow-authored report page values are not allowed");
          let pageDone = false;
          while (!pageDone) {
            assertContext();
            const pageState = await repository.mutateExecution(id, state => {
              this.assert(control); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!;
              if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index || run.reportCoverages?.[node.id] || run.reportCoverage?.nodeId === node.id) throw new Error("Report pagination pointer changed");
              const existing = run.reportPageSecret?.[node.id];
              if (existing && existing.profile !== "schedule-report-pages/v1") throw new Error("Report pagination profile changed");
              const progress = existing ?? newReportPageProgress(tool, node.id, node.capability.contractHash,
                initial.scheduleSource!.reportWindow.startAt, initial.scheduleSource!.reportWindow.endAt);
              if (progress.nodeId !== node.id || progress.toolId !== tool.tool_id || progress.contractHash !== node.capability.contractHash ||
                  progress.startAt !== initial.scheduleSource!.reportWindow.startAt || progress.endAt !== initial.scheduleSource!.reportWindow.endAt ||
                  progress.maxPages !== pagination.max_pages)
                throw new Error("Report pagination evidence is inconsistent or exhausted");
              assertReportPageProgress(tool, progress);
              (run.reportPageSecret ??= {})[node.id] = progress;
              return { page: progress.nextPage, items: structuredClone(progress.items), pages: structuredClone(progress.pages), snapshotValue: progress.snapshotValue, totalCount: progress.totalCount };
            });
            const page = pageState.page, pageArgs = { ...structuredClone(args), [pagination.page_parameter]: page };
            if (validateToolInput(tool.input_schema, pageArgs).length) throw new Error("Server-derived report page arguments are invalid");
            const pageIssues = validateToolArguments(node.capability.action, pageArgs, tool);
            if (pageIssues.missing.length || pageIssues.invalid.length) throw new Error("Server-derived report page arguments failed runtime validation");
            const intentKey = `${node.id}:page:${page}`, pageIntentId = `intent-${randomBytes(16).toString("hex")}`;
            const persistPageIntent = async () => { await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, progress = run.reportPageSecret?.[node.id];
              const fresh = resolveReadBinding(node.inputs, { input: run.workflowSnapshot!.input, ...run.stepOutputs });
              if (attempt.status !== "PREPARING" || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(args)) || !progress ||
                  progress.profile !== "schedule-report-pages/v1" || progress.nextPage !== page ||
                  run.operationSecret!.intents[intentKey]) throw new Error("Report page intent facts changed or are already used");
              const now = new Date().toISOString(), intent: OperationIntent = { id: pageIntentId, nodeId: node.id, invocationId: `${attempt.id}:page:${page}`,
                operationKey: `${id}:${node.id}:page:${page}`, argumentHash: digest(pageArgs), state: "DISPATCH_INTENT", preparedAt: now };
              run.operationSecret!.intents[intentKey] = intent; attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.status = "RUNNING"; entry.phase = `PAGE_${page}_DISPATCH_INTENT`;
              appendExecutionEvent(state, run, "node.report_page_dispatch_intent", { intentId: pageIntentId, page }, node.id, attempt.id); audit(state, run, "operation.report_page_dispatch_intent");
            }); };
            const pageOutput = await dispatchReadTool(services, actor.id, node.capability.action, pageArgs, { workflowId: initial.workflowId, executionId: id,
              signal: control.controller.signal, assertDispatch: assertContext, beforeDispatch: persistPageIntent,
              plan: { yaml: snapshot.yaml, stepIndex: index, token: gate.token, admissionPin: node.capability.admission!, contractHash: node.capability.contractHash, toolId: node.capability.toolId } });
            let confirmed;
            try {
              confirmed = confirmScheduledReportPage({ tool, args: pageArgs, output: pageOutput, startAt: initial.scheduleSource!.reportWindow.startAt,
                endAt: initial.scheduleSource!.reportWindow.endAt, page });
              const candidateItems = [...pageState.items, ...confirmed.items];
              assertReportRelatedKeyProgress(tool, pageArgs, candidateItems, confirmed.hasMore);
              if (pageState.snapshotValue !== undefined && confirmed.snapshotValue !== pageState.snapshotValue)
                throw new Error("Paginated report changed its stable snapshot between pages");
              if (pageState.totalCount !== undefined && confirmed.totalCount !== pageState.totalCount)
                throw new Error("Paginated report changed its total record count between pages");
              if (confirmed.hasMore ? candidateItems.length >= confirmed.totalCount : candidateItems.length !== confirmed.totalCount)
                throw new Error("Paginated report exhaustion does not match its declared total record count");
              if (candidateItems.length > pagination.max_items || canonicalJSONBytes(candidateItems).length > 2_000_000 || confirmed.hasMore && pageState.pages.length + 1 >= pagination.max_pages)
                throw new Error("Paginated report exceeded its reviewed page, item or byte bound before completeness");
            } catch (error) {
              knownCoverageFailure = { nodeId: node.id, intentKey, intentId: pageIntentId, output: protectedReportPageOutput(tool, pageOutput),
                message: error instanceof Error ? error.message : "Scheduled report page coverage is unconfirmed" }; throw error;
            }
            await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[intentKey], progress = run.reportPageSecret?.[node.id];
              if (attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== pageIntentId || intent.state !== "DISPATCH_INTENT" || !progress ||
                  progress.profile !== "schedule-report-pages/v1" || progress.nextPage !== page)
                throw new Error("Report page result does not own the current intent");
              if (progress.snapshotValue !== undefined && progress.snapshotValue !== confirmed.snapshotValue) throw new Error("Report snapshot changed before checkpoint");
              if (progress.totalCount !== undefined && progress.totalCount !== confirmed.totalCount) throw new Error("Report total count changed before checkpoint");
              const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now; progress.pages.push(confirmed.evidence);
              progress.snapshotValue ??= confirmed.snapshotValue; progress.totalCount ??= confirmed.totalCount;
              progress.items.push(...structuredClone(confirmed.items)); progress.lastOutput = structuredClone(pageOutput); progress.nextPage++;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
              appendExecutionEvent(state, run, "node.report_page_completed", { intentId: pageIntentId, page, itemCount: confirmed.items.length, hasMore: confirmed.hasMore }, node.id, attempt.id);
              if (confirmed.hasMore) {
                attempt.status = "PREPARING"; entry.phase = `PAGE_${progress.nextPage}_PREPARING`; audit(state, run, "operation.report_page_acknowledged"); return;
              }
              const completed = completePaginatedReport(tool, progress);
              const receipt = confirmScheduledReportCoverage({ tool, nodeId: node.id, contractHash: node.capability.contractHash, args,
                output: completed.output, startAt: initial.scheduleSource!.reportWindow.startAt, endAt: initial.scheduleSource!.reportWindow.endAt,
                pagination: completed.receiptPagination, confirmedAt: now });
              attempt.status = "DONE"; attempt.completedAt = now; run.stepOutputs![node.id] = completed.output;
              (run.reportCoverages ??= {})[node.id] = structuredClone(receipt); run.reportCoverage ??= structuredClone(receipt); run.readProgress!.nextStepIndex++;
              delete run.reportPageSecret![node.id]; if (!Object.keys(run.reportPageSecret!).length) delete run.reportPageSecret;
              Object.assign(entry, { status: "DONE", phase: "COMPLETE", outcome: "REPORT_COVERAGE_CONFIRMED", completedAt: now,
                durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: withoutSecretFields(completed.output) });
              appendExecutionEvent(state, run, "node.completed", { intentId: pageIntentId, outcome: "REPORT_COVERAGE_CONFIRMED", pageCount: receipt.pagination!.pageCount }, node.id, attempt.id);
              audit(state, run, "operation.report_pages_completed"); pageDone = true;
            });
          }
          continue;
        }
        const pending = await repository.readAuthoritative(state => state.executions[id]!.runtimeApprovalSecret);
        if (node.effectClass !== "read" && initial.scheduleSource)
          await repository.readAuthoritative(state => assertCoverageBeforeScheduledEffect(state.executions[id]!, plan, live, index));
        if (node.effectClass !== "read" && (!pending || pending.records[pending.activeId]?.binding.nodeId !== node.id)) {
          const binding = await repository.readAuthoritative(state => {
            const run = state.executions[id]!, pin = node.capability.admission!;
            return { executionId: id, workflowId: run.workflowId, nodeId: node.id, invocationId: run.readProgress!.attempts[node.id]!.id, operationKey: `${id}:${node.id}`,
              sourceHash: plan.sourceHash, semanticHash: plan.semanticHash, connectionId: pin.connectionId, connectionBinding: session.admissionBinding!, capabilityId: pin.capabilityId,
              capabilityRevision: pin.revisionId, admissionVersion: pin.admissionVersion, contractHash: pin.contractHash, argumentHash: digest(args), requesterId: actor.id,
              requesterRoleId: run.operationSecret!.roleId, workerEpoch: run.readProgress!.epoch, policyHash: runtimeApprovalPolicyHash(state) };
          });
          await requestRuntimeApproval(repository, id, binding, args, `Review exact ${node.effectClass} action ${node.capability.action}. Automatic retry is disabled.`); return;
        }
        let output: Record<string, unknown>;
        const intentId = `intent-${randomBytes(16).toString("hex")}`;
        const persistIntent = async () => { await repository.mutateExecution(id, state => {
          assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!;
          const fresh = resolveReadBinding(node.inputs, { input: run.workflowSnapshot!.input, ...run.stepOutputs });
          if (attempt.status !== "PREPARING" || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(args)) || run.operationSecret!.intents[node.id]) throw new Error("Operation intent facts changed or are already used");
          if (node.effectClass !== "read") assertCoverageBeforeScheduledEffect(run, plan, live, index);
          const record = run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId];
          if (node.effectClass !== "read") {
            if (!record || record.binding.nodeId !== node.id) throw new Error("Exact operation approval is required");
            consumeRuntimeApproval(state, id, record.binding, args, intentId);
          }
          const now = new Date().toISOString();
          const intent: OperationIntent = { id: intentId, nodeId: node.id, invocationId: attempt.id, operationKey: `${id}:${node.id}`, argumentHash: digest(args), state: "DISPATCH_INTENT", preparedAt: now,
            ...(node.effectClass === "read" ? {} : { approvalId: record!.id }) };
          run.operationSecret!.intents[node.id] = intent; attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
          const entry = state.timelines[id]!.find(entry => entry.attemptId === attempt.id)!; entry.status = "RUNNING"; entry.phase = "DISPATCH_INTENT";
          appendExecutionEvent(state, run, "node.dispatch_intent", { intentId, sideEffect: node.effectClass !== "read" }, node.id, attempt.id); audit(state, run, "operation.dispatch_intent");
        }); };
        if (node.effectClass === "read") output = await dispatchReadTool(services, actor.id, node.capability.action, args, { workflowId: initial.workflowId, executionId: id, signal: control.controller.signal, assertDispatch: assertContext,
          beforeDispatch: persistIntent, plan: { yaml: snapshot.yaml, stepIndex: index, token: gate.token, admissionPin: node.capability.admission!, contractHash: node.capability.contractHash, toolId: node.capability.toolId } });
        else {
          const identity = createDispatchIdentity(actor, services.config.erpbridgeRoleMap), resolved = await services.validator.evaluateResolvedStep(id, snapshot.yaml, index, args, gate.token, identity);
          if (!resolved.capability || resolved.violation) throw new Error("Exact operation dispatch capability was denied");
          await persistIntent();
          const permit = await issueOperationDispatchPermit(repository, id, intentId, tool, args, identity, assertContext);
          try {
            output = await session.clientFor(tool, node.capability.admission).execute(node.capability.action, resolved.capability, args, identity, control.controller.signal,
              async () => { assertContext(); await repository.readAuthoritative(state => assertConsumedRuntimeApproval(state as RepositoryState, id, intentId)); assertContext(); }, assertContext, permit);
          } finally { retireOperationDispatchPermit(permit); }
          if (!confirmedOperationResult(tool, output)) throw new Error("Operation tool returned no contract confirmation");
        }
        let coverageReceipt: ReportCoverageReceipt | undefined;
        if (node.effectClass === "read" && initial.scheduleSource && tool.report_coverage_contract) {
          try {
            coverageReceipt = confirmScheduledReportCoverage({ tool, nodeId: node.id, contractHash: node.capability.contractHash, args, output,
              startAt: initial.scheduleSource.reportWindow.startAt, endAt: initial.scheduleSource.reportWindow.endAt });
          } catch (error) {
            knownCoverageFailure = { nodeId: node.id, intentKey: node.id, intentId, output: structuredClone(output), message: error instanceof Error ? error.message : "Scheduled report coverage is unconfirmed" };
            throw error;
          }
        }
        await repository.mutateExecution(id, state => {
          assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[node.id]!;
          if (attempt.status !== "DISPATCH_INTENT" || intent.id !== intentId || intent.state !== "DISPATCH_INTENT") throw new Error("Operation result does not own the current intent");
          const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now;
          if (tool.operation_contract) intent.evidenceMeaning = tool.operation_contract.confirmation.meaning;
          attempt.status = "DONE"; attempt.completedAt = now; run.stepOutputs![node.id] = structuredClone(output); run.readProgress!.nextStepIndex++;
          if (coverageReceipt) {
            if (!run.scheduleSource || run.reportCoverages?.[node.id] || run.reportCoverage?.nodeId === node.id) throw new Error("Scheduled report coverage evidence is duplicated or detached");
            (run.reportCoverages ??= {})[node.id] = structuredClone(coverageReceipt); run.reportCoverage ??= structuredClone(coverageReceipt);
          }
          const entry = state.timelines[id]!.find(entry => entry.attemptId === attempt.id)!; Object.assign(entry, { status: "DONE", outcome: node.effectClass === "read" ? "READ_CONFIRMED" : intent.evidenceMeaning, completedAt: now, durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: withoutSecretFields(output) });
          appendExecutionEvent(state, run, "node.completed", { intentId, outcome: entry.outcome }, node.id, attempt.id); audit(state, run, "operation.result_acknowledged");
        });
      }
      await repository.mutateExecution(id, state => { assertContext(); const run = state.executions[id]!;
        if (run.readProgress!.nextStepIndex !== plan.ir.root.nodes.length || Object.values(run.readProgress!.attempts).some(attempt => attempt.status !== "DONE")) throw new Error("Operation is incomplete");
        run.finalOutput = run.stepOutputs![plan.ir.root.nodes.at(-1)!.id];
        finish(state, run, "DONE", "All steps have acknowledged tool results. Operation evidence follows each reviewed result contract; this is not independent recipient-delivery verification.");
      });
    } catch {
      try { await repository.mutateExecution(id, state => {
        const run = state.executions[id];
        if (!run || run.operationSecret?.lease?.id !== control.leaseId || run.status !== "RUNNING") return;
        if (knownCoverageFailure) {
          const failure = knownCoverageFailure, attempt = run.readProgress!.attempts[failure.nodeId], intent = run.operationSecret.intents[failure.intentKey];
          if (!attempt || attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== failure.intentId || intent.state !== "DISPATCH_INTENT")
            throw new Error("Known report coverage failure no longer owns the current intent");
          const completedAt = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = completedAt;
          attempt.status = "FAILED"; attempt.completedAt = completedAt; run.stepOutputs![failure.nodeId] = structuredClone(failure.output);
          const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
          Object.assign(entry, { status: "FAILED", outcome: "REPORT_COVERAGE_UNCONFIRMED", completedAt,
            durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt)), output: withoutSecretFields(failure.output) });
          appendExecutionEvent(state, run, "node.report_coverage_unconfirmed", { intentId: intent.id, outcome: "REPORT_COVERAGE_UNCONFIRMED" }, failure.nodeId, attempt.id);
          run.failure = { failureCategory: "REPORT_COVERAGE_UNCONFIRMED", failedStepId: failure.nodeId, reason: failure.message };
          finish(state, run, "FAILED", "The ERP read returned, but it did not prove complete coverage of the exact scheduled report window. No approval was requested and no effect was dispatched.");
          return;
        }
        const attempt = Object.values(run.readProgress!.attempts).findLast(item => ["PREPARING", "DISPATCH_INTENT"].includes(item.status));
        if (attempt?.status === "DISPATCH_INTENT") recover(state, run, "OPERATION_DISPATCH_OR_RESULT_UNCONFIRMED");
        else if (run.readProgress!.cancellation) finish(state, run, "CANCELLED", "Cancelled before a new dispatch. Previous acknowledged results remain saved.");
        else { run.failure = { failureCategory: "OPERATION_BLOCKED_BEFORE_DISPATCH", failedStepId: attempt?.nodeId ?? "preflight" }; finish(state, run, "FAILED", "Current operation verification or authority failed before a new dispatch. Previous acknowledged results remain saved."); }
      }); } catch { this.#stalled = true; }
    }
  }
  async stop() {
    if (this.#closed) return; this.#closed = true; if (this.#waitTimer) clearTimeout(this.#waitTimer);
    const active = [...this.#active.values()]; for (const control of active) { control.valid = false; control.controller.abort(); if (control.timer) clearInterval(control.timer); }
    await Promise.allSettled(active.map(control => this.services.repository.mutateExecution(control.id, state => recover(state, state.executions[control.id]!, "OPERATION_WORKER_SHUTDOWN"))));
    await Promise.allSettled(active.flatMap(control => control.task ? [control.task] : [])); this.#unsubscribe();
  }
}
export function confirmedOperationResult(tool: ToolDefinition, output: Record<string, unknown>): boolean {
  const contract = tool.operation_contract; if (!contract || output.isError === true) return false;
  let value: unknown = output.structuredContent;
  for (const key of contract.confirmation.path) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value === contract.confirmation.expected;
}
