import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundedOperation } from "../core/bounded-operation.js";
import type { Repository } from "../repository/store.js";
import type { OperationReadbackJob } from "./operation-readback-state.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";

const id = z.string().min(1).max(256), taskId = z.string().regex(/^readback-[a-f0-9]{64}$/);
export const readbackTaskCommandSchema = z.object({ profile: z.literal("readback-task-delivery/v1"), executionId: id, queryId: id, taskId }).strict();
export type ReadbackTaskCommand = z.infer<typeof readbackTaskCommandSchema>;
export const readbackTaskOutboxSchema = z.object({ profile: z.literal("readback-task-outbox/v1"), executionId: id, queryId: id, taskId,
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"]), attempts: z.number().int().min(0).max(1000),
  createdAt: z.iso.datetime(), intentAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime().optional() }).strict();
export type ReadbackTaskTransport = Readonly<{ timeoutMs: number;
  enqueue(command: ReadbackTaskCommand, signal: AbortSignal): Promise<{ taskId: string; outcome: "CREATED" | "ALREADY_EXISTS" }> }>;
const transports = new WeakMap<Repository, ReadbackTaskTransport>();
const hash = (value: unknown) => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
function identity(job: OperationReadbackJob) {
  return { profile: "readback-task-binding/v1", executionId: job.executionId, queryId: job.id, intentId: job.intentId, nodeId: job.nodeId,
    baseVersion: job.baseVersion, factsHash: job.factsHash, actorId: job.actorId, roleId: job.roleId, admittedRole: job.admittedRole,
    keyHash: job.keyHash, requestFingerprint: job.requestFingerprint, targetId: job.targetId, targetHash: job.targetHash, admission: job.admission,
    connectionBinding: job.connectionBinding, argumentHash: job.argumentHash, arguments: job.arguments, createdAt: job.createdAt };
}
export function newReadbackTaskOutbox(job: OperationReadbackJob) {
  const bindingHash = hash(identity(job));
  return readbackTaskOutboxSchema.parse({ profile: "readback-task-outbox/v1", executionId: job.executionId, queryId: job.id,
    taskId: `readback-${bindingHash}`, bindingHash, state: "PREPARED", attempts: 0, createdAt: job.createdAt });
}
export function assertReadbackTaskOutbox(job: OperationReadbackJob) {
  const record = readbackTaskOutboxSchema.parse(job.taskDispatchSecret), bindingHash = hash(identity(job));
  if (record.executionId !== job.executionId || record.queryId !== job.id || record.bindingHash !== bindingHash || record.taskId !== `readback-${bindingHash}` || record.createdAt !== job.createdAt ||
      record.state === "PREPARED" && (record.attempts !== 0 || record.intentAt || record.acceptedAt) ||
      record.state !== "PREPARED" && (record.attempts < 1 || !record.intentAt) ||
      record.state === "ENQUEUED" && !record.acceptedAt || record.state !== "ENQUEUED" && record.acceptedAt ||
      record.intentAt && Date.parse(record.intentAt) < Date.parse(record.createdAt) ||
      record.acceptedAt && Date.parse(record.acceptedAt) < Date.parse(record.intentAt!)) throw new Error("Readback outbox identity or history changed");
  return record;
}
export function configureReadbackTaskDispatch(repository: Repository, transport: ReadbackTaskTransport): void {
  if (bindExecutionHost(repository) !== "bounded-invocation" || transports.has(repository)) throw new Error("Readback dispatch requires one owned bounded adapter");
  if (!transport || typeof transport.enqueue !== "function" || !Number.isSafeInteger(transport.timeoutMs) || transport.timeoutMs < 1 || transport.timeoutMs > 30_000)
    throw new Error("Readback dispatch requires a bounded enqueue operation");
  const storage = repository.persistence;
  if (storage && (storage.readQueueDurability !== "encrypted-single-writer" || storage.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !storage.saveExecutionCheckpoint))
    throw new Error("Readback dispatch requires qualified encrypted scoped persistence");
  repository.assertAuthority(); transports.set(repository, Object.freeze({ enqueue: transport.enqueue.bind(transport), timeoutMs: transport.timeoutMs }));
}
export function readbackTaskAdmissionAvailable(repository: Repository) { return residentExecutionAllowed(repository) || transports.has(repository); }
export function requireReadbackTaskAdmission(repository: Repository): void {
  if (!readbackTaskAdmissionAvailable(repository)) requireResidentExecution(repository);
  repository.assertAuthority();
}
/** Enqueue intent is saved before calling the queue. Only the original query
 * identity is retried; this function cannot inspect or repeat an ERP effect. */
export async function dispatchReadbackTaskOutbox(repository: Repository, executionId: string, queryId: string): Promise<"ENQUEUED" | "PENDING" | "NOT_NEEDED"> {
  const transport = transports.get(repository);
  if (residentExecutionAllowed(repository) || !transport) throw new Error("Readback dispatch requires an owned bounded adapter");
  const prepared = await repository.mutateExecution(executionId, state => {
    const job = state.executions[executionId]?.operationSecret?.readbacks?.[queryId];
    if (!job || job.executionId !== executionId || job.id !== queryId) throw new Error("Original query is unavailable");
    const record = assertReadbackTaskOutbox(job);
    if (record.state === "ENQUEUED") return { state: "ENQUEUED" as const };
    if (job.state !== "QUEUED") return { state: "NOT_NEEDED" as const };
    if (record.attempts >= 1000) throw new Error("Readback dispatch attempt bound exceeded; operator review is required");
    job.taskDispatchSecret = { ...record, state: "ENQUEUE_INTENT", attempts: record.attempts + 1, intentAt: new Date().toISOString() };
    assertReadbackTaskOutbox(job);
    return { state: "DISPATCH" as const, attempt: record.attempts + 1,
      command: readbackTaskCommandSchema.parse({ profile: "readback-task-delivery/v1", executionId, queryId, taskId: record.taskId }) };
  });
  if (prepared.state !== "DISPATCH") return prepared.state;
  const controller = new AbortController();
  try {
    repository.assertAuthority();
    const accepted = await boundedOperation(() => transport.enqueue(Object.freeze(prepared.command), controller.signal), {
      timeoutMs: transport.timeoutMs, label: "Readback task enqueue", onAbandon: () => controller.abort() });
    if (!accepted || accepted.taskId !== prepared.command.taskId || !["CREATED", "ALREADY_EXISTS"].includes(accepted.outcome) ||
        Object.keys(accepted).some(key => !["taskId", "outcome"].includes(key))) throw new Error("Readback task acknowledgement is not exact");
    repository.assertAuthority();
    await repository.mutateExecution(executionId, state => {
      const job = state.executions[executionId]?.operationSecret?.readbacks?.[queryId]; if (!job) throw new Error("Original query disappeared");
      const record = assertReadbackTaskOutbox(job);
      if (record.state === "ENQUEUED") return;
      if (record.state !== "ENQUEUE_INTENT" || record.taskId !== prepared.command.taskId || record.attempts !== prepared.attempt) throw new Error("Readback enqueue acknowledgement was superseded");
      job.taskDispatchSecret = { ...record, state: "ENQUEUED", acceptedAt: new Date().toISOString() }; assertReadbackTaskOutbox(job);
    });
    return "ENQUEUED";
  } catch {
    try { repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "Query dispatch acknowledgement is unconfirmed. Reload the original query; do not create a replacement.", { code: "OPERATION_READBACK_UNCONFIRMED", executionId, queryId }); }
    return "PENDING";
  } finally { controller.abort(); }
}
export async function recoverReadbackTaskOutboxes(repository: Repository, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || residentExecutionAllowed(repository) || !transports.has(repository)) throw new Error("Invalid bounded readback recovery owner or limit");
  const jobs = await repository.readAuthoritative(state => Object.values(state.executions).flatMap(run => Object.values(run.operationSecret?.readbacks ?? {}))
    .filter(job => job.taskDispatchSecret && assertReadbackTaskOutbox(job).state !== "ENQUEUED" && job.state === "QUEUED")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit).map(job => ({ executionId: job.executionId, queryId: job.id })));
  let pending = 0;
  for (const job of jobs) if (await dispatchReadbackTaskOutbox(repository, job.executionId, job.queryId) === "PENDING") pending++;
  return { inspected: jobs.length, pending };
}
