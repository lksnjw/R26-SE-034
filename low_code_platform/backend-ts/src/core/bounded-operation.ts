/** Bounds the application's wait, even when a dependency ignores cancellation.
 * Abandonment is not evidence that the remote operation stopped or rolled back.
 * Late settlements are observed, but can never resolve the abandoned wait. */
export class OperationDeadlineExceeded extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} exceeded its ${timeoutMs}ms wait deadline`);
    this.name = "OperationDeadlineExceeded";
  }
}

export function boundedOperation<T>(start: () => Promise<T>, options: {
  timeoutMs: number;
  label: string;
  signal?: AbortSignal | undefined;
  onAbandon?: (() => void) | undefined;
  onLateSettlement?: (() => void) | undefined;
}): Promise<T> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)
    return Promise.reject(new Error("Operation timeout must be a positive supported integer"));
  if (options.signal?.aborted) return Promise.reject(new DOMException("Operation wait cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    let settled = false, abandoned = false;
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    const abandon = (error: Error) => {
      if (settled) return;
      settled = true; abandoned = true; cleanup();
      // Cleanup hooks must not suppress the deadline or cancellation result.
      try { options.onAbandon?.(); } catch { /* best effort only */ }
      reject(error);
    };
    const abort = () => abandon(new DOMException("Operation wait cancelled; remote outcome may be unknown", "AbortError"));
    const timer = setTimeout(() => abandon(new OperationDeadlineExceeded(options.label, options.timeoutMs)), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    const complete = (value: T | unknown, failed: boolean) => {
      if (settled) {
        if (abandoned) { try { options.onLateSettlement?.(); } catch { /* best effort only */ } }
        return;
      }
      settled = true; cleanup();
      if (failed) reject(value); else resolve(value as T);
    };
    try { Promise.resolve(start()).then(value => complete(value, false), error => complete(error, true)); }
    catch (error) { complete(error, true); }
  });
}
