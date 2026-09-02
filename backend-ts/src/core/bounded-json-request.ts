import { boundedOperation } from "./bounded-operation.js";

export class InvalidResponseJSON extends Error {
  constructor() { super("Dependency response was not valid JSON"); this.name = "InvalidResponseJSON"; }
}

/** One deadline covers both response headers and JSON consumption. Aborting
 * fetch is best effort; the application's wait is bounded independently. */
export async function boundedJSONRequest(fetchImplementation: typeof fetch, input: string, init: RequestInit,
  timeoutMs: number, label: string): Promise<{ response: Response; decoded: unknown }> {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  return boundedOperation(async () => {
    const response = await fetchImplementation(input, { ...init, signal });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new DOMException("Dependency wait cancelled", "AbortError");
    }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return { response, decoded: undefined }; }
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch { if (signal.aborted) throw new DOMException("Dependency wait cancelled", "AbortError"); throw new InvalidResponseJSON(); }
    if (signal.aborted) throw new DOMException("Dependency wait cancelled", "AbortError");
    return { response, decoded };
  }, { timeoutMs, label, signal: init.signal ?? undefined, onAbandon: () => controller.abort() });
}
