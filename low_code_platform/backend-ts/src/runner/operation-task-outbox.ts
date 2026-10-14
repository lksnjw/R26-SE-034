import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundedOperation } from "../core/bounded-operation.js";
import type { Execution, Repository, RepositoryState } from "../repository/store.js";
import { appendExecutionEvent } from "./read-checkpoints.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";

const id = z.string().min(1).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/), at = z.iso.datetime(), taskId = z.string().regex(/^operation-[a-f0-9]{64}$/);
export const operationTaskCommandSchema = z.object({ profile: z.literal("operation-task-delivery/v1"), executionId: id, taskId }).strict();
export type OperationTaskCommand = z.infer<typeof operationTaskCommandSchema>;
const completionSchema = z.object({ profile: z.literal("operation-task-completion/v1"), milestone: z.enum(["AWAITING_APPROVAL", "CONTINUATION", "TERMINAL"]),
  runStatus: id, sequence: z.number().int().positive(), eventHash: hash, completedAt: at,
  results: z.record(id, hash).refine(value => Object.keys(value).length <= 1000, "Too many completed results") }).strict();
const generationSchema = z.object({ profile: z.literal("operation-task-generation/v1"), ordinal: z.number().int().min(1).max(1024), taskId,
  bindingHash: hash, checkpointHash: hash, createdAt: at, state: z.enum(["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"]),
  attempts: z.number().int().min(0).max(1000), intentAt: at.optional(), acceptedAt: at.optional(), completion: completionSchema.optional() }).strict();
export const operationTaskLedgerSchema = z.object({ profile: z.literal("operation-task-ledger/v1"), bindingHash: hash,
  generations: z.array(generationSchema).min(1).max(1024) }).strict();
export type OperationTaskLedger = z.infer<typeof operationTaskLedgerSchema>;
export type OperationTaskTransport = Readonly<{ timeoutMs: number;
  enqueue(command: OperationTaskCommand, signal: AbortSignal): Promise<{ taskId: string; outcome: "CREATED" | "ALREADY_EXISTS" }> }>;
const transports = new WeakMap<Repository, OperationTaskTransport>();
const digest = (value: unknown) => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
/** Hash only acknowledged node facts. Later generations may add results, but
 * cannot silently replace the evidence acknowledged by an earlier delivery. */
function resultHash(state: Readonly<RepositoryState>, run: Execution, nodeId: string) {
  const attempt = run.readProgress!.attempts[nodeId], output = run.stepOutputs?.[nodeId];
  if (attempt?.status !== "DONE" || output === undefined) throw new Error("Original task completed result is unavailable");
  // A storage map has no insertion-order contract. Preserve every intent fact,
  // but canonicalize this set by stable identity before turning it into an array.
  // The full-value tie break keeps even duplicate IDs order-independent; it does
  // not suppress or merge any evidence or change ordered timelines/events.
  const intents = Object.values(run.operationSecret!.intents).filter(intent => intent.nodeId === nodeId)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : Buffer.compare(canonicalJSONBytes(a), canonicalJSONBytes(b)));
  return digest({ nodeId, attempt, output, intents,
    timeline: state.timelines[run.id]?.filter(entry => entry.nodeId === nodeId && entry.attemptId === attempt.id) ?? [],
    events: state.executionEvents[run.id]?.filter(event => event.nodeId === nodeId && event.attemptId === attempt.id &&
      ["node.completed", "node.analysis_completed", "node.agent_completed"].includes(event.type)) ?? [] });
}
function assertCompletedResults(state: Readonly<RepositoryState>, run: Execution, ledger: OperationTaskLedger) {
  const seen = new Set<string>();
  for (const generation of ledger.generations) for (const [nodeId, expected] of Object.entries(generation.completion?.results ?? {})) {
    if (seen.has(nodeId) || resultHash(state, run, nodeId) !== expected) throw new Error("Original task completed result evidence changed");
    seen.add(nodeId);
  }
  return seen;
}
function binding(run: Execution) {
  const job = run.operationSecret;
  if (!job || job.profile !== "operation-job/v1" || job.actorId !== run.startedBy.id || !run.workflowSnapshot || !run.readProgress) throw new Error("Operation task source is unavailable");
  return digest({ profile: "operation-task-binding/v1", executionId: run.id, workflowId: run.workflowId, actorId: job.actorId, roleId: job.roleId,
    admittedRole: job.admittedRole, idempotencyScope: job.idempotencyScope, requestFingerprint: job.requestFingerprint, createdAt: job.createdAt,
    snapshot: run.workflowSnapshot, scheduleSource: run.scheduleSource ?? null, analysisProvider: job.analysisProvider ?? null, agentProvider: job.agentProvider ?? null });
}
function checkpoint(run: Execution) {
  const progress = run.readProgress!, approval = run.runtimeApprovalSecret;
  return digest({ profile: "operation-task-checkpoint/v1", epoch: progress.epoch, nextStepIndex: progress.nextStepIndex, sequence: progress.lastSequence,
    attempts: progress.attempts, decisions: progress.decisions ?? null, intents: run.operationSecret!.intents, outputs: run.stepOutputs,
    approval: approval ? approval.records[approval.activeId] : null, protectedScopes: run.operationSecret!.protectedScopes ?? null });
}
function taskHash(base: string, generation: Pick<OperationTaskLedger["generations"][number], "ordinal" | "checkpointHash" | "createdAt">) {
  return digest({ profile: "operation-task-generation-binding/v1", bindingHash: base, ordinal: generation.ordinal, checkpointHash: generation.checkpointHash, createdAt: generation.createdAt });
}
export function assertOperationTaskLedger(run: Execution) {
  const ledger = operationTaskLedgerSchema.parse(run.operationSecret?.taskDispatchSecret), base = binding(run);
  if (ledger.bindingHash !== base) throw new Error("Original operation task binding changed");
  for (const [index, generation] of ledger.generations.entries()) {
    if (generation.ordinal !== index + 1 || generation.bindingHash !== taskHash(base, generation) || generation.taskId !== `operation-${generation.bindingHash}` ||
        index > 0 && (!ledger.generations[index - 1]!.completion || ledger.generations[index - 1]!.completion!.milestone === "TERMINAL" ||
          Date.parse(generation.createdAt) < Date.parse(ledger.generations[index - 1]!.completion!.completedAt)) || generation.state === "PREPARED" && (generation.attempts || generation.intentAt || generation.acceptedAt || generation.completion) ||
        generation.state !== "PREPARED" && (!generation.intentAt || generation.attempts < 1) ||
        (generation.state === "ENQUEUED") !== !!generation.acceptedAt ||
        generation.intentAt && Date.parse(generation.intentAt) < Date.parse(generation.createdAt) ||
        generation.acceptedAt && Date.parse(generation.acceptedAt) < Date.parse(generation.intentAt!) ||
        generation.completion && Date.parse(generation.completion.completedAt) < Date.parse(generation.intentAt!)) throw new Error("Operation task generation identity/history changed");
  }
  return ledger;
}
/** Called only inside acknowledged admission/continuation checkpoints. */
export function prepareOperationTaskGeneration(run: Execution): void {
  if (run.status !== "PENDING" || run.operationSecret?.state !== "QUEUED" || run.operationSecret.lease) throw new Error("Only an exact queued checkpoint can own a new task generation");
  const previous = run.operationSecret.taskDispatchSecret ? assertOperationTaskLedger(run) : undefined, last = previous?.generations.at(-1);
  if (last && !last.completion) throw new Error("Original task generation has no completion receipt");
  const base = binding(run), generation = { ordinal: (last?.ordinal ?? 0) + 1, checkpointHash: checkpoint(run), createdAt: new Date().toISOString() };
  const bindingHash = taskHash(base, generation);
  run.operationSecret.taskDispatchSecret = operationTaskLedgerSchema.parse({ profile: "operation-task-ledger/v1", bindingHash: base,
    generations: [...(previous?.generations ?? []), { ...generation, profile: "operation-task-generation/v1", bindingHash,
      taskId: `operation-${bindingHash}`, state: "PREPARED", attempts: 0 }] });
}
export function operationTaskGeneration(run: Execution, command: OperationTaskCommand) {
  if (run.id !== command.executionId) throw new Error("Task execution identity differs");
  const ledger = assertOperationTaskLedger(run), generation = ledger.generations.find(value => value.taskId === command.taskId);
  if (!generation || generation.state === "PREPARED") throw new Error("Operation task has no acknowledged enqueue intention");
  return { ledger, generation };
}
export function assertOperationTaskReady(state: Readonly<RepositoryState>, run: Execution, command: OperationTaskCommand) {
  const { ledger, generation } = operationTaskGeneration(run, command);
  assertOperationTaskHistory(state, run, ledger);
  if (generation.completion || ledger.generations.at(-1)!.taskId !== command.taskId || run.status !== "PENDING" || run.operationSecret!.state !== "QUEUED" ||
      run.operationSecret!.lease || checkpoint(run) !== generation.checkpointHash) throw new Error("Task is not its original ready generation");
}
/** Delivery completion is distinct from business completion. The receipt/event
 * share a transaction, and older duplicate deliveries cannot enter later work. */
export function completeOperationTaskGeneration(state: RepositoryState, run: Execution, command: OperationTaskCommand) {
  const { ledger, generation } = operationTaskGeneration(run, command);
  assertOperationTaskHistory(state, run, ledger);
  if (generation.completion) return generation.completion;
  const priorResults = assertCompletedResults(state, run, ledger);
  if (ledger.generations.at(-1)!.taskId !== command.taskId || run.operationSecret!.lease) throw new Error("Task milestone still has an owned claim");
  const waiting = run.status === "AWAITING_APPROVAL" && run.operationSecret!.state === "WAITING";
  const continuation = run.status === "PENDING" && run.operationSecret!.state === "QUEUED";
  const terminal = ["DONE", "FAILED", "CANCELLED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED"].includes(run.status) && ["FINISHED", "RECOVERY_REQUIRED"].includes(run.operationSecret!.state);
  if (!waiting && !continuation && !terminal) throw new Error("Task has no supported acknowledged milestone");
  if (continuation && checkpoint(run) === generation.checkpointHash) throw new Error("An unchanged queued task is not a completed continuation checkpoint");
  if (waiting) {
    const approval = run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId];
    if (!approval || approval.state !== "PENDING" || !run.pendingApproval || approval.binding.nodeId !== run.pendingApproval.stepId ||
        !state.executionEvents[run.id]?.some(event => event.type === "approval.requested" && event.nodeId === approval.binding.nodeId && event.attemptId === approval.binding.invocationId &&
          event.payload.approvalId === approval.id && event.payload.reviewHash === approval.reviewHash && event.payload.version === 1)) throw new Error("Task wait lacks its exact approval request");
  }
  const milestone = waiting ? "AWAITING_APPROVAL" : continuation ? "CONTINUATION" : "TERMINAL", completedAt = new Date().toISOString();
  appendExecutionEvent(state, run, "operation.task_checkpoint", { taskId: command.taskId, ordinal: generation.ordinal, milestone, runStatus: run.status });
  const completion = completionSchema.parse({ profile: "operation-task-completion/v1", milestone, runStatus: run.status, completedAt,
    sequence: run.readProgress!.lastSequence, eventHash: digest(state.executionEvents[run.id]!.at(-1)),
    results: Object.fromEntries(Object.values(run.readProgress!.attempts).filter(attempt => attempt.status === "DONE" && !priorResults.has(attempt.nodeId))
      .map(attempt => [attempt.nodeId, resultHash(state, run, attempt.nodeId)])) });
  run.operationSecret!.taskDispatchSecret!.generations[generation.ordinal - 1]!.completion = completion;
  return completion;
}
function assertOperationTaskHistory(state: Readonly<RepositoryState>, run: Execution, ledger: OperationTaskLedger) {
  const events = state.executionEvents[run.id] ?? [];
  assertCompletedResults(state, run, ledger);
  if (events.length !== run.readProgress!.lastSequence || events.some((value, index) => value.sequence !== index + 1)) throw new Error("Original task completion journal is unconfirmed");
  for (const generation of ledger.generations) {
    const receipt = generation.completion; if (!receipt) continue; const event = events[receipt.sequence - 1];
    if (!event || digest(event) !== receipt.eventHash || event.type !== "operation.task_checkpoint" || event.payload.taskId !== generation.taskId ||
        event.payload.milestone !== receipt.milestone || event.payload.runStatus !== receipt.runStatus || event.payload.ordinal !== generation.ordinal)
      throw new Error("Original task completion journal is unconfirmed");
  }
}
export function operationTaskReceipt(state: Readonly<RepositoryState>, run: Execution, command: OperationTaskCommand) {
  const { ledger, generation } = operationTaskGeneration(run, command), receipt = generation.completion;
  assertOperationTaskHistory(state, run, ledger);
  if (!receipt) throw new Error("Original task has no acknowledged completion");
  return { profile: "operation-task-receipt/v1", executionId: run.id, taskId: command.taskId, milestone: receipt.milestone, checkpointStatus: receipt.runStatus,
    sequence: receipt.sequence, deliveryVerified: false, noReplay: true };
}
export function configureOperationTaskDispatch(repository: Repository, transport: OperationTaskTransport): void {
  if (bindExecutionHost(repository) !== "bounded-invocation" || transports.has(repository)) throw new Error("Operation dispatch requires one owned bounded adapter");
  if (!transport || typeof transport.enqueue !== "function" || !Number.isSafeInteger(transport.timeoutMs) || transport.timeoutMs < 1 || transport.timeoutMs > 30_000) throw new Error("Operation enqueue wait must be bounded");
  const storage = repository.persistence;
  if (storage && (storage.readQueueDurability !== "encrypted-single-writer" || storage.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !storage.saveExecutionCheckpoint)) throw new Error("Operation tasks require qualified scoped persistence");
  repository.assertAuthority(); transports.set(repository, Object.freeze({ enqueue: transport.enqueue.bind(transport), timeoutMs: transport.timeoutMs }));
}
export function requireOperationTaskAdmission(repository: Repository) {
  if (!residentExecutionAllowed(repository) && !transports.has(repository)) requireResidentExecution(repository);
  repository.assertAuthority();
}
export async function dispatchOperationTaskOutbox(repository: Repository, executionId: string): Promise<"ENQUEUED" | "PENDING" | "NOT_NEEDED"> {
  const transport = transports.get(repository);
  if (residentExecutionAllowed(repository) || !transport) throw new Error("Operation dispatch requires a bounded owner");
  const prepared = await repository.mutateExecution(executionId, state => {
    const run = state.executions[executionId]; if (!run) throw new Error("Original operation is unavailable");
    const ledger = assertOperationTaskLedger(run), generation = ledger.generations.at(-1)!;
    if (generation.completion || run.status !== "PENDING" || run.operationSecret!.state !== "QUEUED") return { state: "NOT_NEEDED" as const };
    if (generation.state === "ENQUEUED") return { state: "ENQUEUED" as const };
    if (generation.attempts >= 1000) throw new Error("Task enqueue attempt bound exceeded");
    const stored = run.operationSecret!.taskDispatchSecret!.generations[generation.ordinal - 1]!;
    stored.state = "ENQUEUE_INTENT"; stored.attempts++; stored.intentAt = new Date().toISOString();
    return { state: "DISPATCH" as const, attempt: stored.attempts,
      command: operationTaskCommandSchema.parse({ profile: "operation-task-delivery/v1", executionId, taskId: stored.taskId }) };
  });
  if (prepared.state !== "DISPATCH") return prepared.state;
  const controller = new AbortController();
  try {
    repository.assertAuthority(); const accepted = await boundedOperation(() => transport.enqueue(Object.freeze(prepared.command), controller.signal), {
      timeoutMs: transport.timeoutMs, label: "Operation task enqueue", onAbandon: () => controller.abort() });
    if (!accepted || accepted.taskId !== prepared.command.taskId || !["CREATED", "ALREADY_EXISTS"].includes(accepted.outcome) || Object.keys(accepted).some(key => !["taskId", "outcome"].includes(key))) throw new Error("Task acknowledgement is not exact");
    repository.assertAuthority(); await repository.mutateExecution(executionId, state => {
      const run = state.executions[executionId]!, { generation } = operationTaskGeneration(run, prepared.command);
      if (generation.state === "ENQUEUED") return;
      if (generation.attempts !== prepared.attempt) throw new Error("Task enqueue acknowledgement was superseded");
      const stored = run.operationSecret!.taskDispatchSecret!.generations[generation.ordinal - 1]!;
      stored.state = "ENQUEUED"; stored.acceptedAt = new Date().toISOString(); assertOperationTaskLedger(run);
    }); return "ENQUEUED";
  } catch {
    try { repository.assertAuthority(); } catch { throw new HandlerFailure(503, "Operation task acknowledgement is unconfirmed. Reload the original run and approval; never create a replacement action.", { code: "OPERATION_TASK_UNCONFIRMED", executionId }); }
    return "PENDING";
  } finally { controller.abort(); }
}
export async function recoverOperationTaskOutboxes(repository: Repository, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid operation task recovery limit");
  requireOperationTaskAdmission(repository); if (residentExecutionAllowed(repository)) throw new Error("Recovery requires a bounded owner");
  const ids = await repository.readAuthoritative(state => Object.values(state.executions).filter(run => {
    if (!run.operationSecret?.taskDispatchSecret) return false;
    const generation = assertOperationTaskLedger(run).generations.at(-1)!;
    return !generation.completion && generation.state !== "ENQUEUED" && run.status === "PENDING" && run.operationSecret.state === "QUEUED";
  }).slice(0, limit).map(run => run.id));
  let pending = 0; for (const id of ids) if (await dispatchOperationTaskOutbox(repository, id) === "PENDING") pending++;
  return { inspected: ids.length, pending };
}
