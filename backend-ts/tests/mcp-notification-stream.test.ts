import { afterEach, expect, test, vi } from "vitest";
import { superviseMcpNotifications } from "../src/tools/mcp-notification-stream.js";

const endpoint = "https://bridge.example.test/mcp/";
const message = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
const encode = (text: string) => new TextEncoder().encode(text);
const sse = (chunks: Uint8Array[], hold = false, cancel = vi.fn()) => new Response(new ReadableStream<Uint8Array>({
  start(target) { for (const chunk of chunks) target.enqueue(chunk); if (!hold) target.close(); }, cancel,
}), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
afterEach(() => vi.useRealTimers());

test("bounded SSE frames preserve Unicode, comments, multi-line data and split CR/LF delimiters", async () => {
  const content = `: heartbeat\r\nid: opaque-one\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "method":"notifications/tools/list_changed","params":{"name":"ආ"}}\r\n\r\n`;
  const bytes = encode(content), fetcher = vi.fn<typeof fetch>(async () => sse([...bytes].map(byte => new Uint8Array([byte])), true));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100 });
  const reader = (await supervisor.fetch(endpoint)).body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(content.replaceAll("\r\n", "\n"));
    expect(supervisor.state).toEqual({ state: "ACTIVE", recoveryAttempts: 0 }); expect(fetcher).toHaveBeenCalledOnce();
  } finally { await reader.cancel(); supervisor.close(); }
});

test("EOF resumes only GET at the same authenticated session, emits a discovery gap and never replays POST", async () => {
  vi.useFakeTimers(); const gap = vi.fn(), fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(sse([encode(`id: one\ndata: ${message}\n\n`)]))
    .mockResolvedValueOnce(sse([encode(`id: two\ndata: ${message}\n\n`)], true))
    .mockResolvedValueOnce(Response.json({ acknowledged: true }));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100, recoveryDelayMs: 5, onGap: gap });
  const reader = (await supervisor.fetch(endpoint, { headers: { Authorization: "Bearer private-test", "Mcp-Session-Id": "session-one", "MCP-Protocol-Version": "2025-11-25" } })).body!.getReader();
  try {
    await reader.read(); const resumed = reader.read(); await vi.advanceTimersByTimeAsync(5); expect(new TextDecoder().decode((await resumed).value)).toContain("id: two");
    expect(fetcher).toHaveBeenCalledTimes(2); expect(gap).toHaveBeenCalledOnce();
    const headers = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(headers.get("last-event-id")).toBe("one"); expect(headers.get("authorization")).toBe("Bearer private-test"); expect(headers.get("mcp-session-id")).toBe("session-one");
    expect(fetcher.mock.calls.every(([url, init]) => String(url) === endpoint && init?.method === "GET" && init.redirect === "error")).toBe(true);
    expect(await (await supervisor.fetch(endpoint, { method: "POST", body: "one business call" })).json()).toEqual({ acknowledged: true });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  } finally { await reader.cancel(); supervisor.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

test("idle ignored readers and network failures have an unstable-cycle retry budget, then fence the session", async () => {
  vi.useFakeTimers(); const cancel = vi.fn(), fatal = vi.fn(), gap = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel }), { headers: { "content-type": "text/event-stream" } }));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 50, idleMs: 20, recoveryDelayMs: 1, maxRecoveries: 2, onFatal: fatal, onGap: gap });
  const read = (await supervisor.fetch(endpoint)).body!.getReader().read(); const assertion = expect(read).rejects.toThrow(/RECOVERY_EXHAUSTED/);
  await vi.advanceTimersByTimeAsync(100); await assertion;
  expect(fetcher).toHaveBeenCalledTimes(3); expect(cancel).toHaveBeenCalledTimes(3); expect(gap).toHaveBeenCalledTimes(2); expect(fatal).toHaveBeenCalledOnce();
  expect(supervisor.state).toEqual({ state: "FAILED", reason: "RECOVERY_EXHAUSTED", recoveryAttempts: 2 }); supervisor.close(); expect(supervisor.state.state).toBe("FAILED");
  expect(vi.getTimerCount()).toBe(0);
});

test("quiet stable streams renew without assuming a server heartbeat or exhausting a rapid-failure budget", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const fetcher = vi.fn<typeof fetch>(async () => sse([], true));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100, idleMs: 20, stableMs: 10, recoveryDelayMs: 1, maxRecoveries: 1 });
  const reader = (await supervisor.fetch(endpoint)).body!.getReader(), read = reader.read(), assertion = expect(read).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(2_000); expect(fetcher.mock.calls.length).toBeGreaterThan(90); expect(supervisor.state.state).not.toBe("FAILED"); expect(supervisor.state.recoveryAttempts).toBe(1);
  supervisor.close(); await assertion; expect(vi.getTimerCount()).toBe(0);
});

test("CR-only frame endings deliver promptly without waiting for another network chunk", async () => {
  const supervisor = superviseMcpNotifications({ fetch: vi.fn(async () => sse([encode(`data: ${message}\r\r`)], true)), endpoint, timeoutMs: 100 });
  const reader = (await supervisor.fetch(endpoint)).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(`data: ${message}\n\n`); await reader.cancel(); supervisor.close();
});

test("transient GET 503 is recovered with no upstream body or server retry instruction exposed", async () => {
  vi.useFakeTimers(); const gap = vi.fn(), fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("private-upstream", { status: 503, headers: { "retry-after": "999999" } })).mockResolvedValueOnce(sse([encode(`retry: 999999999999\ndata: ${message}\n\n`)], true));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100, recoveryDelayMs: 1, onGap: gap });
  const pending = supervisor.fetch(endpoint); await vi.advanceTimersByTimeAsync(1); const reader = (await pending).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(message); expect(supervisor.state).toEqual({ state: "ACTIVE", recoveryAttempts: 1 });
  expect(gap).toHaveBeenCalledOnce(); expect(JSON.stringify(supervisor.state)).not.toMatch(/private|999999/); await reader.cancel(); supervisor.close(); expect(vi.getTimerCount()).toBe(0);
});

test.each([401, 403, 404, 410, 400])("GET HTTP %s is safely fenced without unbounded error-body parsing or OAuth/new-session recovery", async status => {
  const cancel = vi.fn(), fatal = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(t) { t.enqueue(encode("secret upstream body")); }, cancel }), { status }));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100, onFatal: fatal });
  const error = await supervisor.fetch(endpoint).catch(value => value);
  expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("secret"); expect(fetcher).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce(); expect(fatal).toHaveBeenCalledOnce(); expect(supervisor.state.state).toBe("FAILED"); supervisor.close();
});

test("405 is optional unsupported GET, not a failed POST-only MCP session", async () => {
  const fatal = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => new Response("private error", { status: 405 }));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100, onFatal: fatal });
  const response = await supervisor.fetch(endpoint); expect(response.status).toBe(405); expect(await response.text()).toBe("");
  expect(supervisor.state.state).toBe("UNSUPPORTED"); expect(fatal).not.toHaveBeenCalled(); supervisor.close();
});

test.each([
  { text: "x".repeat(33), budgets: { maxLineBytes: 32 } },
  { text: ": one\n: two\n: three\n\n", budgets: { maxEventBytes: 12 } },
  { text: "id: " + "x".repeat(513) + "\n\n", budgets: {} },
  { text: "data: " + message + "\n\n", budgets: { maxWindowBytes: 12 } },
  { text: ": first\n\n: second\n\n", budgets: { maxWindowEvents: 1 } },
])("partial lines, frames, IDs and byte/event floods fail closed within bounded memory: %j", async ({ text, budgets }) => {
  const fatal = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => sse([encode(text)], true));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100, onFatal: fatal, ...budgets });
  const reader = (await supervisor.fetch(endpoint)).body!.getReader();
  if (budgets.maxWindowEvents) await reader.read();
  await expect(reader.read()).rejects.toThrow(/STREAM_BUDGET/); expect(fatal).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce(); supervisor.close();
});

test.each([
  { chunks: [encode("data: not-json\n\n")] },
  { chunks: [encode('data: {"jsonrpc":"1.0","method":"fake"}\n\n')] },
  { chunks: [encode("data:\n\n")] },
  { chunks: [encode('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":42}\n\n')] },
  { chunks: [new Uint8Array([0xc3]), new Uint8Array([0x28])] },
])("malformed MCP messages or UTF-8 cannot silently drop a notification", async ({ chunks }) => {
  const fatal = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => sse(chunks, true));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100, onFatal: fatal });
  await expect((await supervisor.fetch(endpoint)).body!.getReader().read()).rejects.toThrow(/STREAM_PROTOCOL/);
  expect(fatal).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce(); supervisor.close();
});

test("wrong content type and foreign endpoint are not accepted as notification streams", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ private: "not SSE" }));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100 });
  await expect(supervisor.fetch("https://other.example.test/mcp/")).rejects.toThrow(/STREAM_PROTOCOL/); expect(fetcher).not.toHaveBeenCalled();
  await expect(supervisor.fetch(endpoint)).rejects.toThrow(/STREAM_PROTOCOL/); supervisor.close();
});

test("late ignored header responses are cancelled after timeout; close interrupts recovery and leaves no timers", async () => {
  vi.useFakeTimers(); let release!: (response: Response) => void; const cancel = vi.fn(), fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 10, recoveryDelayMs: 50 });
  const pending = supervisor.fetch(endpoint), assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(10); expect(supervisor.state.state).toBe("RECOVERING"); supervisor.close(); await assertion;
  release(sse([], true, cancel)); await Promise.resolve(); await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

test("pre-abort makes no GET; active cancellation bounds ignored reads and never opens a recovery", async () => {
  vi.useFakeTimers(); const controller = new AbortController(), cancel = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => sse([], true, cancel));
  const supervisor = superviseMcpNotifications({ fetch: fetcher, endpoint, timeoutMs: 100 }); controller.abort();
  await expect(supervisor.fetch(endpoint, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).not.toHaveBeenCalled();
  const active = new AbortController(), reader = (await supervisor.fetch(endpoint, { signal: active.signal })).body!.getReader(), pending = reader.read();
  const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" }); active.abort(); await assertion;
  expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce(); expect(supervisor.state.state).toBe("CLOSED"); supervisor.close(); expect(vi.getTimerCount()).toBe(0);
});
