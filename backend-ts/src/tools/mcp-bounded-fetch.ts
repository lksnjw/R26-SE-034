import { boundedOperation, OperationDeadlineExceeded } from "../core/bounded-operation.js";

/** Bound RPC response bytes before SDK parsing (including POST SSE), and use
 * one header/body deadline. GET is the long-lived notification stream: its
 * per-event resource budget requires a separate supervised connection design.
 * Neither cancellation nor a size error proves remote rollback. */
export function boundedMcpFetch(fetchImplementation: typeof fetch, timeoutMs: number, maxBytes = 2_100_000): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "GET") return fetchImplementation(input, init);
    const deadline = performance.now() + timeoutMs;
    const controller = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    let response: Response | undefined;
    response = await boundedOperation(async () => {
      response = await fetchImplementation(input, { ...init, signal }); return response;
    }, { timeoutMs, label: "ERPBridge response headers", signal, onAbandon: () => controller.abort(),
      onLateSettlement: () => { void response?.body?.cancel().catch(() => {}); } });
    if (!response.body) return response;
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
      controller.abort(); void response.body.cancel().catch(() => {});
      throw new Error("ERPBridge RPC response exceeds supported byte limit");
    }
    const reader = response.body.getReader(); let bytes = 0, stopped = false;
    const cancel = () => { stopped = true; controller.abort(); void reader.cancel().catch(() => {}); };
    const stream = new ReadableStream<Uint8Array>({
      async pull(target) {
        if (stopped) return;
        try {
          if (performance.now() >= deadline) throw new OperationDeadlineExceeded("ERPBridge response body", timeoutMs);
          const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
          const chunk = await boundedOperation(() => reader.read(), { timeoutMs: remaining, label: "ERPBridge response body", signal, onAbandon: cancel });
          if (stopped) return;
          if (performance.now() >= deadline) throw new OperationDeadlineExceeded("ERPBridge response body", timeoutMs);
          if (chunk.done) { stopped = true; target.close(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new Error("ERPBridge RPC response exceeds supported byte limit");
          target.enqueue(chunk.value);
        } catch (error) { if (!stopped) cancel(); target.error(error); }
      },
      cancel,
    }, { highWaterMark: 0 });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
