import { afterEach, expect, test, vi } from "vitest";
import { boundedMcpFetch } from "../src/tools/mcp-bounded-fetch.js";
afterEach(() => vi.useRealTimers());
test("content length and incremental bytes block oversized data before JSON/SSE parsing", async () => {
  for (const declared of [true, false]) {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(101)); }, cancel }), { headers: declared ? { "content-length": "101" } : { "content-type": "text/event-stream" } });
    const bounded = boundedMcpFetch(vi.fn(async () => response), 1000, 100);
    if (declared) await expect(bounded("https://fixture.test", { method: "POST" })).rejects.toThrow(/byte limit/);
    else await expect((await bounded("https://fixture.test", { method: "POST" })).text()).rejects.toThrow(/byte limit/);
    expect(cancel).toHaveBeenCalledOnce();
  }
});
test("one deadline covers headers and a body that ignores cancellation", async () => {
  vi.useFakeTimers();
  const implementation = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 60)); return new Response(new ReadableStream({ pull: () => new Promise(() => {}) })); });
  const response = boundedMcpFetch(implementation, 100)("https://fixture.test", { method: "POST" });
  await vi.advanceTimersByTimeAsync(60);
  const body = (await response).text(), assertion = expect(body).rejects.toMatchObject({ name: "OperationDeadlineExceeded" });
  await vi.advanceTimersByTimeAsync(40); await assertion;
  expect(implementation).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
test("pre-abort makes zero RPCs, in-flight abort rejects and no retry starts", async () => {
  const controller = new AbortController(); controller.abort(); const implementation = vi.fn<typeof fetch>(async () => new Response());
  await expect(boundedMcpFetch(implementation, 100)("https://fixture.test", { method: "POST", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(implementation).not.toHaveBeenCalled();
  const active = new AbortController(), cancel = vi.fn();
  implementation.mockResolvedValueOnce(new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel })));
  const body = (await boundedMcpFetch(implementation, 100)("https://fixture.test", { method: "POST", signal: active.signal })).text();
  const assertion = expect(body).rejects.toMatchObject({ name: "AbortError" }); active.abort(); await assertion;
  expect(implementation).toHaveBeenCalledOnce();
});
test("successful bounded JSON and SSE chunks are passed byte-for-byte, with no leftover timers", async () => {
  vi.useFakeTimers();
  for (const contentType of ["application/json", "text/event-stream"]) {
    const bounded = boundedMcpFetch(vi.fn(async () => new Response("fixture bytes", { headers: { "content-type": contentType } })), 100);
    expect(await (await bounded("https://fixture.test", { method: "POST" })).text()).toBe("fixture bytes");
  }
  expect(vi.getTimerCount()).toBe(0);
});
test("GET notification stream remains long-lived; late abandoned header bodies are cancelled", async () => {
  vi.useFakeTimers(); const stream = new Response("notification"); const implementation = vi.fn<typeof fetch>(async () => stream);
  expect(await boundedMcpFetch(implementation, 100)("https://fixture.test", { method: "GET" })).toBe(stream);
  let release!: (value: Response) => void; implementation.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = boundedMcpFetch(implementation, 100)("https://fixture.test", { method: "POST" }); const assertion = expect(pending).rejects.toMatchObject({ name: "OperationDeadlineExceeded" });
  await vi.advanceTimersByTimeAsync(100); await assertion;
  const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel }))); await Promise.resolve(); await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
