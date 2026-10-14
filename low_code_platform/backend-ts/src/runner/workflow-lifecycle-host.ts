import type { Repository } from "../repository/store.js";
import { boundedOperation } from "../core/bounded-operation.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";
import { requireOperationTaskAdmission } from "./operation-task-outbox.js";

const configured = new WeakSet<Repository>();
const scopes = new WeakMap<Repository, WorkflowLifecycleScope>();
const retired = new WeakSet<WorkflowLifecycleScope>();
export type WorkflowLifecycleScope = Readonly<{ nowMs: number; occurrenceLimit: number; expiryLimit: number; deadlineAt: number }>;

/** Trusted composition capability, never an environment/request/model switch.
 * A task transport alone does not promise a business recurrence trigger. */
export function configureWorkflowLifecycle(repository: Repository): void {
  if (bindExecutionHost(repository) !== "bounded-invocation" || configured.has(repository)) throw new Error("Workflow lifecycle requires one bounded composition adapter");
  requireOperationTaskAdmission(repository); configured.add(repository);
}
export function requireWorkflowLifecycleAdmission(repository: Repository): void {
  if (!residentExecutionAllowed(repository) && !configured.has(repository)) requireResidentExecution(repository);
  requireOperationTaskAdmission(repository);
}
export function assertWorkflowLifecycleScope(repository: Repository, scope: WorkflowLifecycleScope): void {
  if (scopes.get(repository) !== scope || retired.has(scope) || Date.now() >= scope.deadlineAt) throw new Error("Original workflow lifecycle invocation is unavailable or expired");
  repository.assertAuthority();
}

/** One awaited denial/admission scope, with no resident timers or worker pump.
 * On abandonment revoke this owned repository, then drain the original work.
 * Late queue/storage results are not proof that an occurrence never saved. */
export async function withWorkflowLifecycleScope<T>(repository: Repository,
  options: { nowMs?: number; occurrenceLimit?: number; expiryLimit?: number; timeoutMs?: number; signal?: AbortSignal },
  work: (scope: WorkflowLifecycleScope) => Promise<T>): Promise<T> {
  requireWorkflowLifecycleAdmission(repository);
  if (residentExecutionAllowed(repository) || scopes.has(repository)) throw new Error("Workflow lifecycle requires an idle bounded owner");
  const nowMs = options.nowMs ?? Date.now(), occurrenceLimit = options.occurrenceLimit ?? 10, expiryLimit = options.expiryLimit ?? 50, timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(occurrenceLimit) || occurrenceLimit < 1 || occurrenceLimit > 100 ||
      !Number.isSafeInteger(expiryLimit) || expiryLimit < 1 || expiryLimit > 100 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || options.signal?.aborted)
    throw new Error("Invalid or cancelled workflow lifecycle invocation");
  const scope = Object.freeze({ nowMs, occurrenceLimit, expiryLimit, deadlineAt: Date.now() + timeoutMs });
  scopes.set(repository, scope);
  let running: Promise<T> | undefined, closing: Promise<void> | undefined;
  const abandon = () => {
    retired.add(scope);
    // Retain this first close: a second Repository.close() observes its closed
    // flag and need not await the persistence teardown already in progress.
    closing = repository.close(); void closing.catch(() => {});
  };
  try {
    return await boundedOperation(() => {
      assertWorkflowLifecycleScope(repository, scope);
      running = work(scope); return running;
    }, { timeoutMs, label: "Workflow lifecycle invocation", signal: options.signal, onAbandon: abandon });
  } finally {
    retired.add(scope);
    // Do not return while our original callback can continue against storage.
    await running?.catch(() => {});
    // Preserve the cancellation/deadline error, but observe and drain its
    // original storage teardown rather than a later no-op close call.
    await closing?.catch(() => {});
    scopes.delete(repository);
  }
}
