import { createHmac, randomBytes } from "node:crypto";
import type { Execution, Repository, RepositoryState } from "../repository/store.js";
import type { Workflow } from "../models/schemas.js";
import { AESGCMCodec, decodeEncryptionKey } from "../storage/aes-gcm.js";
import { HandlerFailure, validateWorkflow, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { completeCheckpointedRead } from "./checkpointed-read.js";
import { appendExecutionEvent, assertCurrentRunController, reconcileInterruptedExecutions } from "./read-checkpoints.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { inspectReadWorkflow } from "./read-workflow.js";
import { discoverTools } from "../agent/tool-discovery.js";

type Admission = { input: Record<string, unknown>; actorId: string; admittedRole: string; scope: string; fingerprint: string; connectionFingerprint: string };
const queues = new WeakMap<Repository, ReadJobQueue>();
export function supportsReadJobs(services: HandlerServices): boolean {
  return services.repository.persistence === null || services.repository.persistence.readQueueDurability === "encrypted-single-writer";
}
export function readJobQueue(services: HandlerServices): ReadJobQueue {
  let queue = queues.get(services.repository);
  if (!queue || queue.closed) { queue = new ReadJobQueue(services); queues.set(services.repository, queue); }
  return queue;
}

/** Single-owner read queue on the locked repository. No worker pool/lease
 * failover, no implicit retries, no resume of any claimed/interrupted run. */
export class ReadJobQueue {
  readonly #codec: AESGCMCodec;
  readonly #fingerprintKey: string;
  readonly #workerId = `read-worker-${randomBytes(8).toString("hex")}`;
  #scheduled = false;
  #pumping = false;
  #controller: AbortController | undefined;
  #activeId: string | undefined;
  #closed = false;
  #started = false;
  get closed(): boolean { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    if (!supportsReadJobs(services)) throw new HandlerFailure(503, "This storage backend has no verified encrypted single-writer read queue", { code: "READ_QUEUE_STORAGE_UNSUPPORTED" });
    const key = services.repository.persistence === null ? randomBytes(32).toString("base64") : services.config.storageEncryptionKey;
    this.#codec = new AESGCMCodec(key);
    this.#fingerprintKey = createHmac("sha256", decodeEncryptionKey(key)).update("read-job-fingerprint-v1").digest("hex");
  }
  prepare(workflow: Workflow, input: Record<string, unknown>, user: CurrentUser, key: string): Admission {
    if (this.#closed) throw new HandlerFailure(503, "Read queue is shutting down", { code: "READ_QUEUE_UNAVAILABLE" });
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HandlerFailure(400, "Async read admission requires a 16–128 character idempotency key", { code: "READ_JOB_KEY_REQUIRED" });
    const canonical = canonicalInput(input);
    if (Buffer.byteLength(canonical) > 64_000) throw new HandlerFailure(413, "Read job input exceeds 64 KB", { code: "READ_JOB_INPUT_LIMIT" });
    const scope = this.digest(JSON.stringify([user.id, workflow.id, key]));
    const fingerprint = this.digest(JSON.stringify([workflow.publishedVersion, workflowContentHash(workflow.yaml), canonical]));
    return { input: structuredClone(input), actorId: user.id, admittedRole: user.role, scope, fingerprint, connectionFingerprint: this.connectionFingerprint() };
  }
  private digest(value: string): string { return createHmac("sha256", this.#fingerprintKey).update(value).digest("hex"); }
  private connectionFingerprint(): string {
    return this.digest(canonicalInput({ binding: this.services.erpbridgeSession?.admissionBinding ?? null, roleMap: this.services.config.erpbridgeRoleMap }));
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
    if (Object.values(state.readJobs).filter((job) => ["QUEUED", "CLAIMED"].includes(job.state)).length >= 100)
      throw new HandlerFailure(429, "Read queue is full; no run was admitted", { code: "READ_QUEUE_FULL" });
  }
  store(state: RepositoryState, item: Execution, admission: Admission): void {
    if (this.#closed) throw new HandlerFailure(503, "Read queue is shutting down", { code: "READ_QUEUE_UNAVAILABLE" });
    if (!this.services.erpbridgeSession?.admissionBinding || this.connectionFingerprint() !== admission.connectionFingerprint)
      throw new HandlerFailure(503, "Read connection identity is unavailable or changed during admission", { code: "READ_CONNECTION_BINDING_REQUIRED" });
    const inputCiphertext = this.#codec.encode(Buffer.from(JSON.stringify({ version: 1, executionId: item.id, input: admission.input }))).toString("base64");
    state.readJobs[item.id] = { version: 1, executionId: item.id, actorId: admission.actorId, admittedRole: admission.admittedRole, state: "QUEUED", inputCiphertext,
      requestFingerprint: admission.fingerprint, idempotencyScope: admission.scope, connectionFingerprint: admission.connectionFingerprint, createdAt: item.startedAt };
  }
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const interrupted = await this.services.repository.read((state) => Object.values(state.readJobs).filter((job) => job.state === "CLAIMED").map((job) => job.executionId));
    for (const id of interrupted) {
      await reconcileInterruptedExecutions(this.services.repository, "READ_WORKER_RESTARTED", id);
      await this.services.repository.mutate((state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (job?.state !== "CLAIMED") return;
        job.state = item && ["DONE", "FAILED", "CANCELLED"].includes(item.status) ? "FINISHED" : "RECOVERY_REQUIRED";
        if (job.state === "FINISHED") { job.finishedAt = item!.completedAt ?? new Date().toISOString(); delete job.inputCiphertext; }
      });
    }
    this.kick();
  }
  kick(): void {
    if (this.#closed || this.#scheduled || this.#pumping) return;
    this.#scheduled = true;
    setImmediate(() => { this.#scheduled = false; void this.pump(); });
  }
  private async pump(): Promise<void> {
    if (this.#closed || this.#pumping) return;
    this.#pumping = true;
    try {
      while (!this.#closed) {
        const id = await this.services.repository.read((state) => Object.values(state.readJobs).filter((job) => job.state === "QUEUED").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.executionId);
        if (!id) break;
        await this.process(id);
      }
    } catch { /* A failed claim/save stops admission/dispatch; repository fences uncertain writes. No background replay. */ }
    finally { this.#pumping = false; }
  }
  private async process(id: string): Promise<void> {
    this.#controller = new AbortController(); this.#activeId = id;
    let initial: Execution | null = null;
    try {
      const claimed = await this.services.repository.mutate((state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (job?.state !== "QUEUED") return null;
        if (item?.status !== "PENDING" || !item.readProgress) throw new Error("Queued job has inconsistent execution state; refusing dispatch");
        job.state = "CLAIMED"; job.workerId = this.#workerId; job.claimedAt = new Date().toISOString();
        item.status = "RUNNING"; item.readProgress.epoch += 1;
        appendExecutionEvent(state, item, "run.started", { profile: "read-job-v1", persistence: item.readProgress.persistence });
        appendJobAudit(state, item, "execution.worker_claimed", this.#workerId);
        return { item: structuredClone(item), job: structuredClone(job) };
      });
      if (!claimed) return;
      initial = claimed.item;
      const job = claimed.job, snapshot = initial.workflowSnapshot;
      if (this.#closed || this.#controller.signal.aborted || job.version !== 1 || !snapshot || snapshot.contentHash !== workflowContentHash(snapshot.yaml) ||
          job.actorId !== initial.startedBy.id || !job.inputCiphertext) throw new Error("Invalid queued job");
      const actor = await this.services.repository.effectiveUser(job.actorId);
      await this.services.repository.read((state) => {
        assertCurrentRunController(state as RepositoryState, initial!, job.actorId, job.admittedRole);
        const publication = (state.versions[initial!.workflowId] ?? []).findLast((version) => version.version === snapshot.version && version.artifactState === "PUBLISHED");
        if (publication?.yaml !== snapshot.yaml) throw new Error("Pinned publication unavailable");
      });
      if (!actor || actor.role !== job.admittedRole || snapshot.registryHash !== this.services.registries.hash() ||
          !this.services.erpbridgeSession?.admissionBinding || job.connectionFingerprint !== this.connectionFingerprint()) throw new Error("Queued authority, connection or registry changed");
      const privateInput = JSON.parse(this.#codec.decode(Buffer.from(job.inputCiphertext, "base64")).toString("utf8")) as { version?: number; executionId?: string; input?: Record<string, unknown> };
      if (privateInput.version !== 1 || privateInput.executionId !== id || !privateInput.input || Array.isArray(privateInput.input) || typeof privateInput.input !== "object") throw new Error("Private job input is not authentic");
      canonicalInput(privateInput.input);
      const gate = await validateWorkflow(this.services, "ReadJobWorker", snapshot.yaml, actor, { traceId: initial.traceId, workflowId: initial.workflowId, executionId: id, signal: this.#controller.signal });
      if (!gate.result.passed || !gate.token || gate.token.registry_hash !== snapshot.registryHash || !this.services.erpbridgeSession) throw new Error("Queued verification failed");
      const live = await discoverTools(this.services.erpbridgeSession, this.services.registries);
      if (inspectReadWorkflow(parseWorkflowYAMLStrict(snapshot.yaml), live, actor.role).length) throw new Error("Queued contracts changed");
      if (this.#closed) return;
      await completeCheckpointedRead(this.services, initial, privateInput.input, gate.token, this.#controller.signal, () => {
        if (!this.services.erpbridgeSession?.admissionBinding || job.connectionFingerprint !== this.connectionFingerprint())
          throw new Error("Queued connection binding changed; refusing further dispatch");
      });
    } catch (error) {
      // No confirmed claim means this job may still look QUEUED in rolled-back
      // memory. Propagate to stop the pump rather than repeatedly claiming it
      // (or starving the event loop) while storage is fenced.
      if (!initial) throw error;
      if (initial) {
        try { await this.services.repository.mutate((state) => {
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
      try { await this.services.repository.mutate((state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (!job || job.workerId !== this.#workerId || job.state !== "CLAIMED" || !item || ["RUNNING", "PENDING"].includes(item.status)) return;
        job.state = item.status === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : "FINISHED"; job.finishedAt = new Date().toISOString();
        if (job.state === "FINISHED") delete job.inputCiphertext;
      }); } catch { /* No replay/false completion on failed persistence. */ }
      this.#activeId = undefined; this.#controller = undefined;
    }
  }
  async stop(): Promise<void> {
    this.#closed = true; this.#controller?.abort();
    if (this.#activeId) {
      const id = this.#activeId;
      await reconcileInterruptedExecutions(this.services.repository, "READ_WORKER_SHUTDOWN", id);
      await this.services.repository.mutate((state) => { const job = state.readJobs[id]; if (job?.state === "CLAIMED") job.state = "RECOVERY_REQUIRED"; });
    }
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
