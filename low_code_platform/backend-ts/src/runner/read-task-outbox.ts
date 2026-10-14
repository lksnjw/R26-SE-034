import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundedOperation } from "../core/bounded-operation.js";
import type { ReadJob, Repository } from "../repository/store.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";

const id = z.string().min(1).max(256);
export const readTaskCommandSchema = z.object({ profile: z.literal("read-task-delivery/v1"), executionId: id,
  taskId: z.string().regex(/^read-[a-f0-9]{64}$/) }).strict();
export type ReadTaskCommand = z.infer<typeof readTaskCommandSchema>;
const outboxSchema = z.object({ profile: z.literal("read-task-outbox/v1"), executionId: id,
  taskId: z.string().regex(/^read-[a-f0-9]{64}$/), bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"]), attempts: z.number().int().min(0).max(1000),
  createdAt: z.iso.datetime(), intentAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime().optional() }).strict();
export type ReadTaskOutbox = z.infer<typeof outboxSchema>;
export type ReadTaskTransport = Readonly<{
  enqueue(command: ReadTaskCommand, signal: AbortSignal): Promise<{ taskId: string; outcome: "CREATED" | "ALREADY_EXISTS" }>;
  timeoutMs: number;
}>;
const transports = new WeakMap<Repository, ReadTaskTransport>();
const hash = (value: unknown) => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
function identity(job: ReadJob) {
  return { profile: "read-task-binding/v1", executionId: job.executionId, actorId: job.actorId, admittedRole: job.admittedRole,
    requestFingerprint: job.requestFingerprint, idempotencyScope: job.idempotencyScope, connectionFingerprint: job.connectionFingerprint,
    createdAt: job.createdAt };
}

/** Private durable DATA attached to the same job checkpoint as admission.
 * Stable queue identity permits enqueue reconciliation, never ERP replay. */
export function newReadTaskOutbox(job: ReadJob): ReadTaskOutbox {
  const bindingHash = hash(identity(job));
  return outboxSchema.parse({ profile: "read-task-outbox/v1", executionId: job.executionId, taskId: `read-${bindingHash}`,
    bindingHash, state: "PREPARED", attempts: 0, createdAt: job.createdAt });
}
export function assertReadTaskOutbox(job: ReadJob): ReadTaskOutbox {
  const record = outboxSchema.parse(job.taskDispatchSecret), bindingHash = hash(identity(job));
  if (record.executionId !== job.executionId || record.bindingHash !== bindingHash || record.taskId !== `read-${bindingHash}` || record.createdAt !== job.createdAt ||
      record.state === "PREPARED" && (record.attempts !== 0 || record.intentAt || record.acceptedAt) ||
      record.state !== "PREPARED" && (record.attempts < 1 || !record.intentAt) ||
      record.state === "ENQUEUED" && !record.acceptedAt || record.state !== "ENQUEUED" && record.acceptedAt ||
      record.intentAt && Date.parse(record.intentAt) < Date.parse(record.createdAt) ||
      record.acceptedAt && Date.parse(record.acceptedAt) < Date.parse(record.intentAt!)) throw new Error("Read task outbox identity or history changed");
  return record;
}

/** Server composition only. Request/model data cannot install dispatch.
 * A repository gets one transport for its ownership lifetime. */
export function configureReadTaskDispatch(repository: Repository, transport: ReadTaskTransport): void {
  if (bindExecutionHost(repository) !== "bounded-invocation") throw new Error("Task dispatch requires a bounded invocation owner");
  if (transports.has(repository)) throw new Error("Read task transport is already bound to this owner");
  if (!transport || typeof transport.enqueue !== "function" || !Number.isSafeInteger(transport.timeoutMs) || transport.timeoutMs < 1 || transport.timeoutMs > 30_000)
    throw new Error("Read task transport requires a bounded enqueue operation");
  const storage = repository.persistence;
  if (storage && (storage.readQueueDurability !== "encrypted-single-writer" || storage.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !storage.saveExecutionCheckpoint))
    throw new Error("Task admission requires qualified encrypted scoped storage");
  repository.assertAuthority(); transports.set(repository, Object.freeze({ enqueue: transport.enqueue.bind(transport), timeoutMs: transport.timeoutMs }));
}
export function requireReadTaskAdmission(repository: Repository): void {
  if (residentExecutionAllowed(repository)) return;
  if (!transports.has(repository)) requireResidentExecution(repository);
  repository.assertAuthority();
}

/** Enqueue is always AFTER the committed outbox intent. Failed/lost queue
 * acknowledgement leaves the original stable identity recoverable. This
 * operation cannot claim a job, invoke a tool, or infer business completion. */
export async function dispatchReadTaskOutbox(repository: Repository, executionId: string): Promise<"ENQUEUED" | "PENDING" | "NOT_NEEDED"> {
  if (residentExecutionAllowed(repository)) throw new Error("Resident workers cannot dispatch task-owned jobs");
  const transport = transports.get(repository);
  if (!transport) throw new HandlerFailure(503, "Read task transport is unavailable", { code: "READ_TASK_TRANSPORT_UNAVAILABLE" });
  const prepared = await repository.mutateExecution(executionId, state => {
    const job = state.readJobs[executionId], run = state.executions[executionId];
    if (!job || !run || job.executionId !== run.id || job.actorId !== run.startedBy.id) throw new Error("Read task source is unavailable");
    const record = assertReadTaskOutbox(job);
    if (record.state === "ENQUEUED") return { state: "ENQUEUED" as const };
    if (job.state !== "QUEUED" || run.status !== "PENDING") return { state: "NOT_NEEDED" as const };
    if (record.attempts >= 1000) throw new Error("Read task dispatch attempt bound exceeded; operator review is required");
    job.taskDispatchSecret = { ...record, state: "ENQUEUE_INTENT", attempts: record.attempts + 1, intentAt: new Date().toISOString() };
    assertReadTaskOutbox(job);
    return { state: "DISPATCH" as const, attempt: record.attempts + 1,
      command: readTaskCommandSchema.parse({ profile: "read-task-delivery/v1", executionId, taskId: record.taskId }) };
  });
  if (prepared.state !== "DISPATCH") return prepared.state;
  const controller = new AbortController();
  try {
    repository.assertAuthority();
    const accepted = await boundedOperation(() => transport.enqueue(Object.freeze(prepared.command), controller.signal), {
      timeoutMs: transport.timeoutMs, label: "Read task enqueue", onAbandon: () => controller.abort(),
    });
    if (!accepted || accepted.taskId !== prepared.command.taskId || !["CREATED", "ALREADY_EXISTS"].includes(accepted.outcome) ||
        Object.keys(accepted).some(key => !["taskId", "outcome"].includes(key))) throw new Error("Read task queue acknowledgement is not exact");
    repository.assertAuthority();
    await repository.mutateExecution(executionId, state => {
      const job = state.readJobs[executionId]; if (!job) throw new Error("Read task source disappeared");
      const record = assertReadTaskOutbox(job);
      if (record.state === "ENQUEUED") return;
      if (record.state !== "ENQUEUE_INTENT" || record.taskId !== prepared.command.taskId || record.attempts !== prepared.attempt)
        throw new Error("Read task enqueue acknowledgement was superseded");
      job.taskDispatchSecret = { ...record, state: "ENQUEUED", acceptedAt: new Date().toISOString() }; assertReadTaskOutbox(job);
    });
    return "ENQUEUED";
  } catch {
    // A late enqueue may have succeeded, but cannot commit an abandoned ACK.
    // Never log arbitrary queue errors or fabricate an ENQUEUED record.
    try { repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "Read task dispatch acknowledgement is unconfirmed. Reload the original run; do not submit a new key.", { code: "READ_TASK_ACK_UNCONFIRMED", executionId }); }
    return "PENDING";
  } finally { controller.abort(); }
}

export async function recoverReadTaskOutboxes(repository: Repository, limit = 10): Promise<{ inspected: number; pending: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid read task recovery bound");
  if (residentExecutionAllowed(repository) || !transports.has(repository)) throw new Error("Read task recovery requires an owned bounded dispatcher");
  const ids = await repository.readAuthoritative(state => Object.values(state.readJobs).filter(job => {
    if (!job.taskDispatchSecret) return false;
    const record = assertReadTaskOutbox(job);
    return job.state === "QUEUED" && state.executions[job.executionId]?.status === "PENDING" && record.state !== "ENQUEUED";
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.executionId.localeCompare(b.executionId)).slice(0, limit).map(job => job.executionId));
  let pending = 0;
  for (const id of ids) if (await dispatchReadTaskOutbox(repository, id) === "PENDING") pending++;
  return { inspected: ids.length, pending };
}
