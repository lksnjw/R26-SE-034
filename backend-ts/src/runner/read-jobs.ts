import { createHmac, randomBytes } from "node:crypto";
import type { Execution, Repository, RepositoryState } from "../repository/store.js";
import type { Workflow } from "../models/schemas.js";
import { AESGCMCodec, decodeEncryptionKey } from "../storage/aes-gcm.js";
import { HandlerFailure, validateWorkflow, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { completeCheckpointedRead } from "./checkpointed-read.js";
import { appendExecutionEvent, assertCurrentRunController, reconcileInterruptedExecutions, reconcileReadExecution } from "./read-checkpoints.js";
import { assertReadWorkerLease, issueReadWorkerLease, renewReadWorkerLease, nextFairReadJob, ReadWorkerLeaseFailure, type ReadWorkerLease, type ReadWorkerContext } from "./read-worker-lease.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { inspectReadWorkflow } from "./read-workflow.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { prepareCompiledExecution } from "../workflows/read-compilation-lifecycle.js";
import { supportsCollectionReads, readIterationBindingKey } from "./read-collection-admission.js";
import { completeCheckpointedCollectionRead } from "./checkpointed-collection-read.js";
import { boundMcpConnection, selectedMcpConnectionId } from "../tools/mcp-dispatch-context.js";

type Admission = { input: Record<string, unknown>; actorId: string; admittedRole: string; scope: string; fingerprint: string; connectionFingerprint: string };
const queues = new WeakMap<Repository, ReadJobQueue>();
const memoryKeys = new WeakMap<Repository, string>();
type ActiveRead = { id: string; actorId: string; controller: AbortController; lease?: ReadWorkerLease; failure?: ReadWorkerLeaseFailure;
  controllerAllowed: boolean; timer?: NodeJS.Timeout; task?: Promise<void> };
export function supportsReadJobs(services: HandlerServices): boolean {
  return services.repository.persistence === null || services.repository.persistence.readQueueDurability === "encrypted-single-writer";
}
export function readJobQueue(services: HandlerServices): ReadJobQueue {
  let queue = queues.get(services.repository);
  if (!queue || queue.closed) { queue = new ReadJobQueue(services); queues.set(services.repository, queue); }
  return queue;
}

/** Fair bounded workers inside the exclusively owned repository. Authenticated
 * renewable leases fence SDK entry, not distributed failover or replay.
 * Claimed/interrupted work is never automatically claimed by another worker. */
export class ReadJobQueue {
  readonly #codec: AESGCMCodec;
  readonly #fingerprintKey: string;
  readonly #workerId = `read-worker-${randomBytes(8).toString("hex")}`;
  #scheduled = false;
  #pumping = false;
  readonly #leaseKey: string;
  readonly #active = new Map<string, ActiveRead>();
  readonly #concurrency: number;
  readonly #perActor: number;
  readonly #leaseMs: number;
  readonly #unobserve: () => void;
  #actorRing: string[] = [];
  #repump = false;
  #stalled = false;
  #closed = false;
  #started = false;
  get closed(): boolean { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    if (!supportsReadJobs(services)) throw new HandlerFailure(503, "This storage backend has no verified encrypted single-writer read queue", { code: "READ_QUEUE_STORAGE_UNSUPPORTED" });
    let key = services.config.storageEncryptionKey;
    if (services.repository.persistence === null) { key = memoryKeys.get(services.repository) ?? randomBytes(32).toString("base64"); memoryKeys.set(services.repository, key); }
    this.#codec = new AESGCMCodec(key);
    this.#fingerprintKey = createHmac("sha256", decodeEncryptionKey(key)).update("read-job-fingerprint-v1").digest("hex");
    this.#leaseKey = createHmac("sha256", decodeEncryptionKey(key)).update("read-worker-leases/v1").digest("hex");
    this.#concurrency = services.config.readWorkerConcurrency; this.#perActor = services.config.readWorkerPerActor; this.#leaseMs = services.config.readWorkerLeaseMs;
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 8 || !Number.isSafeInteger(this.#perActor) || this.#perActor < 1 || this.#perActor > this.#concurrency || !Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 5000 || this.#leaseMs > 300_000) throw new Error("Invalid read worker limits");
    this.#unobserve = services.repository.observeCommits({ committed: state => this.observe(state), unavailable: () => {
      this.#stalled = true; for (const control of this.#active.values()) {
        control.failure ??= new ReadWorkerLeaseFailure("READ_WORKER_STORAGE_UNAVAILABLE"); control.controller.abort(control.failure);
      }
    } });
  }
  prepare(workflow: Workflow, input: Record<string, unknown>, user: CurrentUser, key: string): Admission {
    if (this.#closed) throw new HandlerFailure(503, "Read queue is shutting down", { code: "READ_QUEUE_UNAVAILABLE" });
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HandlerFailure(400, "Async read admission requires a 16–128 character idempotency key", { code: "READ_JOB_KEY_REQUIRED" });
    const canonical = canonicalInput(input);
    if (Buffer.byteLength(canonical) > 64_000) throw new HandlerFailure(413, "Read job input exceeds 64 KB", { code: "READ_JOB_INPUT_LIMIT" });
    const scope = this.digest(JSON.stringify([user.id, workflow.id, key]));
    const fingerprint = this.digest(JSON.stringify([workflow.publishedVersion, workflowContentHash(workflow.yaml), canonical]));
    // An existing idempotent admission remains queryable while its connection
    // is degraded or fenced. A new admission still fails in store() because an
    // empty fingerprint cannot match a current connected context.
    let connectionFingerprint = "";
    try { connectionFingerprint = this.connectionFingerprint(workflow.yaml); } catch { /* resolved after existing-key lookup */ }
    return { input: structuredClone(input), actorId: user.id, admittedRole: user.role, scope, fingerprint, connectionFingerprint };
  }
  private digest(value: string): string { return createHmac("sha256", this.#fingerprintKey).update(value).digest("hex"); }
  private connectionFingerprint(yaml: string): string {
    const source = parseWorkflowYAMLStrict(yaml), ids = [...new Set(source.steps.map(step => selectedMcpConnectionId(this.services, step.connection_id)))].sort();
    return this.digest(canonicalInput(ids.map(id => { const bound = boundMcpConnection(this.services, id); return { id, binding: bound.session.admissionBinding ?? null, roleMap: bound.roleMap }; })));
  }
  existing(state: Readonly<RepositoryState>, admission: Admission, user: CurrentUser): Execution | null {
    const job = Object.values(state.readJobs).find((item) => item.idempotencyScope === admission.scope);
    if (!job) return null;
    const item = state.executions[job.executionId];
    if (!item || job.actorId !== user.id) throw new HandlerFailure(409, "Read job identity is inconsistent", { code: "READ_JOB_IDENTITY_INVALID" });
    try { assertCurrentRunController(state as RepositoryState, item, user.id); }
    catch { throw new HandlerFailure(403, "Current user cannot control this read job", { code: "EXECUTION_AUTHORITY_CHANGED" }); }
    if (job.requestFingerprint !== admission.fingerprint) throw new HandlerFailure(409, "Idempotency key belongs to different inputs or a different publication", { code: "READ_JOB_KEY_CONFLICT" });
    return structuredClone(item);
  }
  assertCapacity(state: RepositoryState): void {
    if (this.#closed || this.#stalled) throw new HandlerFailure(503, "Read workers are unavailable; inspect recovery state before admitting another run", { code: "READ_QUEUE_UNAVAILABLE" });
    if (Object.values(state.readJobs).filter((job) => ["QUEUED", "CLAIMED"].includes(job.state)).length >= 100)
      throw new HandlerFailure(429, "Read queue is full; no run was admitted", { code: "READ_QUEUE_FULL" });
  }
  store(state: RepositoryState, item: Execution, admission: Admission): void {
    if (this.#closed || this.#stalled) throw new HandlerFailure(503, "Read workers are unavailable", { code: "READ_QUEUE_UNAVAILABLE" });
    if (!item.workflowSnapshot?.yaml || this.connectionFingerprint(item.workflowSnapshot.yaml) !== admission.connectionFingerprint)
      throw new HandlerFailure(503, "Read connection identity is unavailable or changed during admission", { code: "READ_CONNECTION_BINDING_REQUIRED" });
    const inputCiphertext = this.#codec.encode(Buffer.from(JSON.stringify({ version: 1, executionId: item.id, input: admission.input }))).toString("base64");
    if (!Number.isSafeInteger(state.counter + 1) || state.counter < 0) throw new Error("Read admission sequence is unavailable");
    state.readJobs[item.id] = { version: 1, executionId: item.id, actorId: admission.actorId, admittedRole: admission.admittedRole, state: "QUEUED", inputCiphertext,
      requestFingerprint: admission.fingerprint, idempotencyScope: admission.scope, connectionFingerprint: admission.connectionFingerprint, createdAt: item.startedAt, queueSequence: ++state.counter };
  }
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const jobs = await this.services.repository.read(state => Object.values(state.readJobs).map(job => ({ state: job.state, id: job.executionId })));
    const interrupted = jobs.filter(job => job.state === "CLAIMED").map(job => job.id);
    for (const id of interrupted) {
      await reconcileInterruptedExecutions(this.services.repository, "READ_WORKER_RESTARTED", id);
      await this.services.repository.mutateExecution(id, (state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (job?.state !== "CLAIMED") return;
        job.state = item && ["DONE", "FAILED", "CANCELLED"].includes(item.status) ? "FINISHED" : "RECOVERY_REQUIRED";
        if (job.state === "FINISHED") { job.finishedAt = item!.completedAt ?? new Date().toISOString(); delete job.inputCiphertext; delete job.lease; }
      });
    }
    if (jobs.some(job => job.state === "QUEUED")) this.kick();
  }
  kick(): void {
    if (this.#closed || this.#stalled || this.#scheduled) return;
    if (this.#pumping) { this.#repump = true; return; }
    this.#scheduled = true;
    setImmediate(() => { this.#scheduled = false; void this.pump(); });
  }
  private async pump(): Promise<void> {
    if (this.#closed || this.#pumping) return;
    this.#pumping = true;
    try {
      while (!this.#closed && !this.#stalled && this.#active.size < this.#concurrency) {
        const selected = await this.services.repository.readAuthoritative(state => {
          const actors = new Map<string, number>(); for (const control of this.#active.values()) actors.set(control.actorId, (actors.get(control.actorId) ?? 0) + 1);
          const pick = nextFairReadJob(Object.values(state.readJobs).filter(job => !this.#active.has(job.executionId)), actors, this.#actorRing, this.#perActor);
          return { ...pick, actorId: pick.executionId ? state.readJobs[pick.executionId]!.actorId : undefined };
        });
        this.#actorRing = selected.ring; if (!selected.executionId || !selected.actorId || this.#closed || this.#stalled) break;
        const control: ActiveRead = { id: selected.executionId, actorId: selected.actorId, controller: new AbortController(), controllerAllowed: false };
        this.#active.set(control.id, control);
        control.task = this.process(control).catch(() => { this.#stalled = true; }).finally(() => {
          if (control.timer) clearTimeout(control.timer); this.#active.delete(control.id); this.kick();
        });
      }
    } catch { this.#stalled = true; /* Authoritative claim/selection failure never hot-loops or replays. */ }
    finally { this.#pumping = false; if (this.#repump) { this.#repump = false; this.kick(); } }
  }
  private observe(state: Readonly<RepositoryState>): void {
    for (const control of this.#active.values()) if (control.lease && !control.failure) {
      try {
        const item = state.executions[control.id];
        const lease = assertReadWorkerLease(this.#leaseKey, state.readJobs[control.id], item, control.lease, Date.now(), this.#leaseMs);
        control.lease = structuredClone(lease);
        try { assertCurrentRunController(state as RepositoryState, item!, control.actorId, state.readJobs[control.id]!.admittedRole); control.controllerAllowed = !item!.readProgress?.cancellation; }
        catch { control.controllerAllowed = false; }
      } catch (cause) { control.failure = cause instanceof ReadWorkerLeaseFailure ? cause : new ReadWorkerLeaseFailure(); }
    }
  }
  private workerContext(control: ActiveRead): ReadWorkerContext {
    const assertActive = () => {
      if (this.#closed || this.#stalled || control.failure || !control.lease || Date.now() < Date.parse(control.lease.renewedAt) || Date.now() >= Date.parse(control.lease.expiresAt)) {
        control.failure ??= new ReadWorkerLeaseFailure(); throw control.failure;
      }
    };
    return { assertActive, assertDispatch: () => { assertActive(); if (!control.controllerAllowed) throw new Error("Current queued controller is no longer authorized"); } };
  }
  private heartbeat(control: ActiveRead): void {
    if (this.#closed || !this.#active.has(control.id)) return;
    control.timer = setTimeout(() => { void (async () => {
      try {
        this.workerContext(control).assertActive();
        await this.services.repository.mutateExecution(control.id, state => {
          this.workerContext(control).assertActive(); const job = state.readJobs[control.id]!, item = state.executions[control.id]!;
          job.lease = renewReadWorkerLease(this.#leaseKey, job, item, control.lease!, Date.now(), this.#leaseMs);
        });
        this.workerContext(control).assertActive(); this.heartbeat(control);
      } catch { control.failure ??= new ReadWorkerLeaseFailure(); control.controller.abort(control.failure); await this.retire(control, "READ_WORKER_LEASE_LOST"); }
    })(); }, Math.floor(this.#leaseMs / 3)); control.timer.unref();
  }
  private async retire(control: ActiveRead, reason: string): Promise<void> {
    try { await this.services.repository.mutateExecution(control.id, state => {
      const job = state.readJobs[control.id], item = state.executions[control.id];
      if (!job || !item || job.workerId !== this.#workerId || job.state !== "CLAIMED" || !job.lease || control.lease && (job.lease.leaseId !== control.lease.leaseId || job.lease.epoch !== control.lease.epoch) || item.readProgress?.epoch !== job.lease.epoch) return;
      reconcileReadExecution(state, item, reason, new Date().toISOString());
      job.state = ["DONE", "FAILED", "CANCELLED"].includes(item.status) ? "FINISHED" : "RECOVERY_REQUIRED";
      if (job.state === "FINISHED") { delete job.inputCiphertext; delete job.lease; }
    }); } catch { /* Persistence remains fenced; startup performs authoritative reconciliation. */ }
  }
  private async process(control: ActiveRead): Promise<void> {
    const id = control.id;
    let initial: Execution | null = null;
    try {
      const claimed = await this.services.repository.mutateExecution(id, (state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (job?.state !== "QUEUED") return null;
        if (item?.status !== "PENDING" || !item.readProgress) throw new Error("Queued job has inconsistent execution state; refusing dispatch");
        job.state = "CLAIMED"; job.workerId = this.#workerId; job.claimedAt = new Date().toISOString();
        item.status = "RUNNING"; item.readProgress.epoch += 1;
        job.lease = issueReadWorkerLease(this.#leaseKey, job, item, this.#workerId, Date.now(), this.#leaseMs);
        appendExecutionEvent(state, item, "run.started", { profile: "read-job-v1", persistence: item.readProgress.persistence });
        appendJobAudit(state, item, "execution.worker_claimed", this.#workerId);
        return { item: structuredClone(item), job: structuredClone(job) };
      });
      if (!claimed) return;
      initial = claimed.item;
      control.lease = claimed.job.lease!; control.controllerAllowed = true; this.heartbeat(control);
      const job = claimed.job, snapshot = initial.workflowSnapshot;
      if (this.#closed || control.controller.signal.aborted || job.version !== 1 || !snapshot || snapshot.contentHash !== workflowContentHash(snapshot.yaml) ||
          job.actorId !== initial.startedBy.id || !job.inputCiphertext) throw new Error("Invalid queued job");
      if (this.services.config.mcpTransport === "erpbridge-mcp" && this.services.config.mcpMode === "remote" && !snapshot.compilation) throw new Error("Queued modern run has no compiled admission receipt");
      const actor = await this.services.repository.effectiveUser(job.actorId);
      const compilation = await this.services.repository.readAuthoritative((state) => {
        assertCurrentRunController(state as RepositoryState, initial!, job.actorId, job.admittedRole);
        const publication = (state.versions[initial!.workflowId] ?? []).findLast((version) => version.version === snapshot.version && version.artifactState === "PUBLISHED");
        if (publication?.yaml !== snapshot.yaml) throw new Error("Pinned publication unavailable");
        return prepareCompiledExecution(state, this.services, publication, snapshot.yaml, job.admittedRole, snapshot.compilation);
      });
      if (!actor || actor.role !== job.admittedRole || snapshot.registryHash !== this.services.registries.hash() ||
          job.connectionFingerprint !== this.connectionFingerprint(snapshot.yaml)) throw new Error("Queued authority, connection or registry changed");
      const privateInput = JSON.parse(this.#codec.decode(Buffer.from(job.inputCiphertext, "base64")).toString("utf8")) as { version?: number; executionId?: string; input?: Record<string, unknown> };
      if (privateInput.version !== 1 || privateInput.executionId !== id || !privateInput.input || Array.isArray(privateInput.input) || typeof privateInput.input !== "object") throw new Error("Private job input is not authentic");
      canonicalInput(privateInput.input);
      const gate = await validateWorkflow(this.services, "ReadJobWorker", snapshot.yaml, actor, { traceId: initial.traceId, workflowId: initial.workflowId, executionId: id, signal: control.controller.signal });
      if (!gate.result.passed || !gate.token || gate.token.registry_hash !== snapshot.registryHash) throw new Error("Queued verification failed");
      const pinnedIds = compilation.plan.ir.root.nodes.map(node => node.capability.admission?.connectionId).filter((value): value is string => !!value);
      const connectionIds = [...new Set(pinnedIds.length ? pinnedIds : parseWorkflowYAMLStrict(snapshot.yaml).steps.map(step => selectedMcpConnectionId(this.services, step.connection_id)))];
      const live = [...new Map((await Promise.all(connectionIds.map(async id => discoverTools(boundMcpConnection(this.services, id).session, this.services.registries))))
        .flatMap(tools => tools.map(tool => [tool.tool_id, tool] as const))).values()];
      if (inspectReadWorkflow(parseWorkflowYAMLStrict(snapshot.yaml), live, actor.role, supportsCollectionReads(this.services)).length) throw new Error("Queued contracts changed");
      this.workerContext(control).assertActive();
      const assertConnection = () => {
        if (job.connectionFingerprint !== this.connectionFingerprint(snapshot.yaml))
          throw new Error("Queued connection binding changed; refusing further dispatch");
      };
      if (compilation.plan.ir.schemaVersion === "workflow-read-ir/v4") await completeCheckpointedCollectionRead(this.services, initial, privateInput.input, gate.token,
        compilation.plan, readIterationBindingKey(this.services), control.controller.signal, assertConnection, this.workerContext(control));
      else await completeCheckpointedRead(this.services, initial, privateInput.input, gate.token, control.controller.signal, assertConnection, compilation.plan, this.workerContext(control));
    } catch (error) {
      // No confirmed claim means this job may still look QUEUED in rolled-back
      // memory. Propagate to stop the pump rather than repeatedly claiming it
      // (or starving the event loop) while storage is fenced.
      if (!initial) throw error;
      if (this.#closed || control.failure || error instanceof ReadWorkerLeaseFailure) { await this.retire(control, this.#closed ? "READ_WORKER_SHUTDOWN" : "READ_WORKER_LEASE_LOST"); return; }
      if (initial) {
        try { await this.services.repository.mutateExecution(id, (state) => {
          const item = state.executions[id];
          // Preparation errors imply no dispatch only when the journal confirms
          // no attempt existed. Other errors were reconciled by checkpoints.
          if (item?.status !== "RUNNING" || item.readProgress?.epoch !== initial!.readProgress!.epoch || Object.keys(item.readProgress.attempts).length) return;
          item.status = item.readProgress.cancellation ? "CANCELLED" : "FAILED"; item.completedAt = new Date().toISOString(); item.durationMs = Math.max(0, Date.parse(item.completedAt) - Date.parse(item.startedAt));
          item.failure = { failureCategory: "READ_JOB_PREPARATION_FAILED", failedStepId: "preflight", toolWasCalled: false };
          item.agentSummary = "Read job stopped before dispatch because its current authority, input, publication, connection or verification could not be confirmed. No replay was performed.";
          appendExecutionEvent(state, item, "run.completed", { status: item.status, phase: "preparation", outcome: "NOT_DISPATCHED" });
          appendJobAudit(state, item, "execution.completed", this.#workerId);
        }); } catch { /* storage stays fenced */ }
      }
    } finally {
      try { await this.services.repository.mutateExecution(id, (state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (!job || job.workerId !== this.#workerId || job.state !== "CLAIMED" || !item || job.lease?.leaseId !== control.lease?.leaseId || ["RUNNING", "PENDING"].includes(item.status)) return;
        job.state = item.status === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : "FINISHED"; job.finishedAt = new Date().toISOString();
        if (job.state === "FINISHED") { delete job.inputCiphertext; delete job.lease; }
      }); } catch { /* No replay/false completion on failed persistence. */ }
    }
  }
  async stop(): Promise<void> {
    this.#closed = true; this.#unobserve();
    const active = [...this.#active.values()]; for (const control of active) { if (control.timer) clearTimeout(control.timer); control.failure ??= new ReadWorkerLeaseFailure("READ_WORKER_SHUTDOWN"); control.controller.abort(control.failure); }
    await Promise.all(active.map(control => this.retire(control, "READ_WORKER_SHUTDOWN")));
  }
}

function appendJobAudit(state: RepositoryState, item: Execution, action: string, workerId: string): void {
  state.auditLogs.push({ id: `audit-${randomBytes(8).toString("hex")}`, source: "read-job-worker", actor: item.startedBy, action,
    resource: { type: "execution", id: item.id }, before: null, after: { status: item.status, workflowId: item.workflowId, workerId },
    createdAt: new Date().toISOString(), ...(item.traceId === undefined ? {} : { traceId: item.traceId }) });
}

function canonicalInput(value: unknown, depth = 0): string {
  if (depth > 16) throw new HandlerFailure(400, "Read job input nesting exceeds supported limits");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalInput(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalInput((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  throw new HandlerFailure(400, "Read job input must be JSON data");
}
