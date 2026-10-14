import { boundedOperation } from "./bounded-operation.js";

export class InvalidResponseJSON extends Error {
  constructor() { super("Dependency response was not valid JSON"); this.name = "InvalidResponseJSON"; }
}
export type OwnedJSONRequest = Readonly<{ settled: Promise<void>; abort(): void }>;
export class JSONRequestCleanupFailure extends Error {
  constructor() { super("Dependency body disposal was not confirmed"); }
}

/** One deadline covers both response headers and JSON consumption. Aborting
 * fetch is best effort; the application's wait is bounded independently. */
export async function boundedJSONRequest(fetchImplementation: typeof fetch, input: string, init: RequestInit,
  timeoutMs: number, label: string, ownRequest?: (request: OwnedJSONRequest) => void): Promise<{ response: Response; decoded: unknown }> {
  // Reject unsupported deadlines before publishing an owned lifetime that
  // could never be started by boundedOperation.
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Operation timeout must be a positive supported integer");
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  // Publish transport ownership before synchronous fetch entry. The detached
  // lifetime includes headers, JSON and confirmed body disposal; the bounded
  // caller's deadline is deliberately not a disposal acknowledgement.
  let resolveSettled!: () => void, rejectSettled!: (error: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
  void settled.catch(() => {});
  try { ownRequest?.({ settled, abort: () => controller.abort() }); }
  catch (error) {
    // The registrar is trusted task-owner plumbing, but if it fails, no raw
    // transport was entered. Close that never-started lifetime and preserve
    // the registrar's original error for the caller.
    controller.abort();
    resolveSettled();
    throw error;
  }
  if (init.signal?.aborted) resolveSettled();
  const start = async () => {
    if (signal.aborted) throw new DOMException("Dependency wait cancelled", "AbortError");
    const response = await fetchImplementation(input, { ...init, signal });
    const cancelBody = async () => { try { await response.body?.cancel(); } catch { throw new JSONRequestCleanupFailure(); } };
    if (signal.aborted) {
      await cancelBody();
      throw new DOMException("Dependency wait cancelled", "AbortError");
    }
    if (!response.ok) { await cancelBody(); return { response, decoded: undefined }; }
    let decoded: unknown;
    if (ownRequest && response.body) {
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try { reader = response.body.getReader(); }
      catch (error) {
        // Reader acquisition itself can fail for a locked or hostile body.
        // Do not report owned disposal until the response body confirms cancel.
        await cancelBody();
        throw error;
      }
      const decoder = new TextDecoder(); let text = "", complete = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (signal.aborted) throw new DOMException("Dependency wait cancelled", "AbortError");
          if (chunk.done) { complete = true; text += decoder.decode(); break; }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } catch (error) {
        try { await reader.cancel(); } catch { throw new JSONRequestCleanupFailure(); }
        if (signal.aborted) throw new DOMException("Dependency wait cancelled", "AbortError"); throw error;
      } finally { reader.releaseLock(); }
      if (!complete) throw new JSONRequestCleanupFailure();
      try { decoded = JSON.parse(text); } catch { throw new InvalidResponseJSON(); }
    } else {
      try { decoded = await response.json(); }
      catch {
        if (ownRequest) await cancelBody();
        if (signal.aborted) throw new DOMException("Dependency wait cancelled", "AbortError"); throw new InvalidResponseJSON();
      }
    }
    if (signal.aborted) throw new DOMException("Dependency wait cancelled", "AbortError");
    return { response, decoded };
  };
  return boundedOperation(() => {
    const raw = start();
    // A remote HTTP/parse/abort failure can still have a fully settled owned
    // operation. Cancellation failure itself is conservatively unconfirmed.
    raw.then(resolveSettled, error => {
      if (error instanceof JSONRequestCleanupFailure) rejectSettled(error); else resolveSettled();
    });
    return raw;
  }, { timeoutMs, label, signal: init.signal ?? undefined, onAbandon: () => controller.abort() });
}
