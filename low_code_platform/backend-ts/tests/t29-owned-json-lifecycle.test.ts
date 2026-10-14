import { expect, test, vi } from "vitest";
import { boundedJSONRequest, JSONRequestCleanupFailure, type OwnedJSONRequest } from "../src/core/bounded-json-request.js";
import { setTimeout as pause } from "node:timers/promises";

test("owned JSON lifetime is registered before synchronous transport entry and outlives a stuck body deadline", async () => {
  let request!: OwnedJSONRequest, release!: (value: unknown) => void, settled = false;
  const body = new Promise(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async () => {
    expect(request).toBeDefined();
    return { ok: true, json: () => body } as Response;
  });
  const pending = boundedJSONRequest(fetcher, "https://synthetic.example.test", {}, 30, "fixture", owned => {
    request = owned; void owned.settled.then(() => { settled = true; });
  });
  await expect(pending).rejects.toThrow("30ms"); expect(settled).toBe(false); expect(fetcher).toHaveBeenCalledOnce();
  release({ value: "late" }); await request.settled; expect(settled).toBe(true);
});

test("late headers await cancellation, including a hanging cancellation, before confirming raw disposal", async () => {
  let request!: OwnedJSONRequest, releaseHeaders!: (response: Response) => void, releaseCancel!: () => void, settled = false;
  const headers = new Promise<Response>(resolve => { releaseHeaders = resolve; }), cancelled = new Promise<void>(resolve => { releaseCancel = resolve; });
  const cancel = vi.fn(() => cancelled), json = vi.fn(async () => ({}));
  await expect(boundedJSONRequest(async () => headers, "https://synthetic.example.test", {}, 30, "fixture", owned => {
    request = owned; void owned.settled.then(() => { settled = true; });
  })).rejects.toThrow("30ms");
  expect(settled).toBe(false);
  releaseHeaders({ ok: true, body: { cancel }, json } as unknown as Response);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); expect(settled).toBe(false); expect(json).not.toHaveBeenCalled();
  releaseCancel(); await request.settled; expect(settled).toBe(true);
});

test("HTTP error bodies require confirmed disposal and preserve cancellation failure as unknown cleanup", async () => {
  let request!: OwnedJSONRequest;
  const cancel = vi.fn(async () => { throw new Error("synthetic failed cleanup"); });
  await expect(boundedJSONRequest(async () => ({ ok: false, body: { cancel } }) as unknown as Response,
    "https://synthetic.example.test", {}, 100, "fixture", owned => { request = owned; })).rejects.toBeInstanceOf(JSONRequestCleanupFailure);
  await expect(request.settled).rejects.toBeInstanceOf(JSONRequestCleanupFailure); expect(cancel).toHaveBeenCalledOnce();
});

test("pre-cancelled request registers a settled lifetime and performs zero transport calls", async () => {
  const controller = new AbortController(); controller.abort(); let request!: OwnedJSONRequest;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
  await expect(boundedJSONRequest(fetcher, "https://synthetic.example.test", { signal: controller.signal }, 100, "fixture", owned => { request = owned; })).rejects.toThrow(/cancel/i);
  await request.settled; expect(fetcher).not.toHaveBeenCalled();
});
