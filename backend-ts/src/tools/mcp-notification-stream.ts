import { boundedOperation } from "../core/bounded-operation.js";
import { parseJSONRPCMessage } from "@modelcontextprotocol/client";

export type McpNotificationState = Readonly<{
  state: "STARTING" | "ACTIVE" | "RECOVERING" | "UNSUPPORTED" | "FAILED" | "CLOSED";
  reason?: "STREAM_GAP" | "STREAM_UNAUTHORIZED" | "SESSION_EXPIRED" | "STREAM_PROTOCOL" | "STREAM_BUDGET" | "RECOVERY_EXHAUSTED";
  recoveryAttempts: number;
}>;

class StreamFailure extends Error {
  constructor(readonly reason: NonNullable<McpNotificationState["reason"]>) { super(`ERPBridge notification stream failed (${reason})`); }
}

/** Only the approved endpoint's notification GET may recover. Never replay a
 * POST, initialize, tools/call, credentials exchange, or session creation.
 * Gaps invalidate discovery even when Last-Event-ID is available: resumption
 * is not proof of a complete server history. All budgets are engine-owned. */
export function superviseMcpNotifications(options: {
  fetch: typeof fetch; endpoint: string; timeoutMs: number;
  onState?: (state: McpNotificationState) => void;
  onGap?: () => void; onFatal?: () => void;
  // Trusted backend/test options; not exposed to models or HTTP callers.
  idleMs?: number; stableMs?: number; recoveryDelayMs?: number; maxRecoveries?: number;
  maxLineBytes?: number; maxEventBytes?: number; maxWindowBytes?: number; maxWindowEvents?: number;
}) {
  const idleMs = options.idleMs ?? 120_000, stableMs = options.stableMs ?? 60_000, delayMs = options.recoveryDelayMs ?? 250, maxRecoveries = options.maxRecoveries ?? 3;
  const lineLimit = options.maxLineBytes ?? 65_536, eventLimit = options.maxEventBytes ?? 262_144;
  const windowBytesLimit = options.maxWindowBytes ?? 2_100_000, windowEventsLimit = options.maxWindowEvents ?? 1_000;
  for (const value of [options.timeoutMs, idleMs, stableMs, lineLimit, eventLimit, windowBytesLimit, windowEventsLimit])
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error("Invalid MCP notification budget");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000 || !Number.isInteger(maxRecoveries) || maxRecoveries < 0 || maxRecoveries > 8)
    throw new Error("Invalid MCP notification recovery budget");
  let closed = false, snapshot: McpNotificationState = { state: "STARTING", recoveryAttempts: 0 };
  const controllers = new Set<AbortController>();
  const publish = (state: McpNotificationState) => { snapshot = Object.freeze(state); options.onState?.(snapshot); };
  const close = () => { closed = true; for (const controller of controllers) controller.abort(); controllers.clear(); if (snapshot.state !== "FAILED") publish({ state: "CLOSED", recoveryAttempts: snapshot.recoveryAttempts }); };
  const wrapped: typeof fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") return options.fetch(input, init);
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const requestHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (closed || requestSignal?.aborted) throw new DOMException("Notification stream cancelled", "AbortError");
    if (String(input instanceof Request ? input.url : input) !== options.endpoint) throw new StreamFailure("STREAM_PROTOCOL");
    if (controllers.size) throw new StreamFailure("STREAM_PROTOCOL"); // One active notification reader per adapter.
    const lifetime = new AbortController(); controllers.add(lifetime);
    const signal = requestSignal ? AbortSignal.any([requestSignal, lifetime.signal]) : lifetime.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, attempt: AbortController | undefined;
    let recoveries = 0, lastId = new Headers(requestHeaders).get("last-event-id") ?? "";
    let decoder = new TextDecoder("utf-8", { fatal: true }), pending = "", lines: string[] = [], frameBytes = 0, skipLeadingLF = false;
    let openedAt: number | undefined;
    let windowStart = performance.now(), windowBytes = 0, windowEvents = 0;
    const cancelAttempt = () => { attempt?.abort(); void reader?.cancel().catch(() => {}); reader = undefined; };
    const release = () => { cancelAttempt(); controllers.delete(lifetime); signal.removeEventListener("abort", aborted); };
    const aborted = () => { release(); if (!closed && snapshot.state !== "FAILED") publish({ state: "CLOSED", recoveryAttempts: recoveries }); };
    signal.addEventListener("abort", aborted, { once: true });
    const fatal = (reason: NonNullable<McpNotificationState["reason"]>): never => {
      closed = true; release(); publish({ state: "FAILED", reason, recoveryAttempts: recoveries });
      for (const controller of controllers) controller.abort(); controllers.clear();
      options.onFatal?.(); throw new StreamFailure(reason);
    };
    const recover = async () => {
      // ERPBridge does not promise a heartbeat. A quiet stream is valid, so a
      // bounded idle renewal after a stable period starts a fresh retry cycle.
      // Rapid flapping cannot reset the budget merely by returning headers.
      if (openedAt !== undefined && performance.now() - openedAt >= stableMs) recoveries = 0;
      openedAt = undefined;
      cancelAttempt();
      if (signal.aborted) throw new DOMException("Notification stream cancelled", "AbortError");
      if (recoveries >= maxRecoveries) fatal("RECOVERY_EXHAUSTED");
      recoveries++; publish({ state: "RECOVERING", reason: "STREAM_GAP", recoveryAttempts: recoveries }); options.onGap?.();
      // The delay is cancelled with the connection, including ignored fetches.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Notification stream cancelled", "AbortError")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(2_000, delayMs * 2 ** (recoveries - 1)));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    };
    const open = async (): Promise<Response> => {
      for (;;) {
        if (signal.aborted) throw new DOMException("Notification stream cancelled", "AbortError");
        attempt = new AbortController();
        const requestSignal = AbortSignal.any([signal, attempt.signal]);
        const headers = new Headers(requestHeaders); if (lastId) headers.set("last-event-id", lastId); else headers.delete("last-event-id");
        let response: Response | undefined;
        try {
          response = await boundedOperation(async () => {
            response = await options.fetch(input, { ...init, method: "GET", headers, redirect: "error", signal: requestSignal }); return response;
          }, { timeoutMs: options.timeoutMs, label: "MCP notification headers", signal: requestSignal,
            onAbandon: () => attempt?.abort(), onLateSettlement: () => { void response?.body?.cancel().catch(() => {}); } });
        } catch { if (signal.aborted) throw new DOMException("Notification stream cancelled", "AbortError"); await recover(); continue; }
        if (!response.ok) {
          // Never read/persist unbounded authentication or upstream error bodies.
          void response.body?.cancel().catch(() => {}); attempt.abort();
          if (response.status === 405 && recoveries === 0) {
            release(); publish({ state: "UNSUPPORTED", recoveryAttempts: 0 }); return new Response(null, { status: 405 });
          }
          if ([401, 403].includes(response.status)) fatal("STREAM_UNAUTHORIZED");
          if ([404, 410].includes(response.status)) fatal("SESSION_EXPIRED");
          if (response.status === 429 || response.status >= 500) { await recover(); continue; }
          fatal("STREAM_PROTOCOL");
        }
        if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
          void response.body?.cancel().catch(() => {}); fatal("STREAM_PROTOCOL");
        }
        reader = response.body!.getReader(); openedAt = performance.now(); decoder = new TextDecoder("utf-8", { fatal: true }); pending = ""; lines = []; frameBytes = 0; skipLeadingLF = false;
        publish({ state: "ACTIVE", recoveryAttempts: recoveries }); return response;
      }
    };
    try {
      const initial = await open(); if (initial.status === 405) return initial;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            for (;;) {
              if (signal.aborted) throw new DOMException("Notification stream cancelled", "AbortError");
              // Preserve SSE semantics across CR/LF/chunk boundaries. Normalize
              // delimiters only; deliver complete bounded frames to the SDK.
              const boundary = pending.search(/[\r\n]/);
              if (boundary >= 0) {
                const line = pending.slice(0, boundary), delimiter = pending[boundary] === "\r" && pending[boundary + 1] === "\n" ? 2 : 1;
                if (pending[boundary] === "\r" && boundary === pending.length - 1) skipLeadingLF = true;
                pending = pending.slice(boundary + delimiter);
                if (Buffer.byteLength(line) > lineLimit) fatal("STREAM_BUDGET");
                frameBytes += Buffer.byteLength(line) + 1; if (frameBytes > eventLimit) fatal("STREAM_BUDGET");
                if (line) { lines.push(line); continue; }
                if (++windowEvents > windowEventsLimit) fatal("STREAM_BUDGET");
                const fields = lines.map(value => { const colon = value.indexOf(":"); return colon < 0 ? [value, ""] : [value.slice(0, colon), value.slice(colon + 1).replace(/^ /, "")]; });
                const data = fields.filter(([name]) => name === "data").map(([, value]) => value).join("\n");
                const event = fields.filter(([name]) => name === "event").at(-1)?.[1] ?? "message";
                if (fields.some(([name]) => name === "data") && (event === "message" || event === "")) {
                  // Use the pinned client's public wire validator before its
                  // reader can emit an error and silently continue past a gap.
                  try { parseJSONRPCMessage(JSON.parse(data)); } catch { fatal("STREAM_PROTOCOL"); }
                }
                for (const [name, value] of fields) if (name === "id" && !value!.includes("\0")) { if (Buffer.byteLength(value!) > 512 || /[\r\n]/.test(value!)) fatal("STREAM_BUDGET"); lastId = value!; }
                const frame = encoder.encode(lines.join("\n") + "\n\n"); lines = []; frameBytes = 0;
                target.enqueue(frame); return;
              }
              if (Buffer.byteLength(pending) > lineLimit) fatal("STREAM_BUDGET");
              let chunk: Awaited<ReturnType<NonNullable<typeof reader>["read"]>>;
              try { chunk = await boundedOperation(() => reader!.read(), { timeoutMs: idleMs, label: "MCP notification idle wait", signal, onAbandon: cancelAttempt }); }
              catch (error) {
                if (signal.aborted) throw error;
                await recover(); await open(); continue;
              }
              if (chunk.done) { await recover(); await open(); continue; }
              if (performance.now() - windowStart >= 10_000) { windowStart = performance.now(); windowBytes = 0; windowEvents = 0; }
              windowBytes += chunk.value.byteLength; if (windowBytes > windowBytesLimit) fatal("STREAM_BUDGET");
              try {
                let text = decoder.decode(chunk.value, { stream: true });
                if (skipLeadingLF && text.length) { if (text.startsWith("\n")) text = text.slice(1); skipLeadingLF = false; }
                pending += text;
              } catch { fatal("STREAM_PROTOCOL"); }
            }
          } catch (error) {
            let failure = error;
            if (!(error instanceof StreamFailure) && !signal.aborted) { try { fatal("STREAM_PROTOCOL"); } catch (safeFailure) { failure = safeFailure; } }
            release(); target.error(failure);
          }
        },
        cancel() { lifetime.abort(); release(); },
      }, { highWaterMark: 0 });
      return new Response(stream, { status: initial.status, headers: initial.headers });
    } catch (error) { release(); throw error; }
  };
  return { fetch: wrapped, close, get state(): McpNotificationState { return snapshot; } };
}
