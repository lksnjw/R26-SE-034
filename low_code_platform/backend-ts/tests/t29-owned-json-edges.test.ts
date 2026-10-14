import { expect, test, vi } from "vitest";
import { setTimeout as pause } from "node:timers/promises";
import { boundedJSONRequest, JSONRequestCleanupFailure, type OwnedJSONRequest } from "../src/core/bounded-json-request.js";

const url = "https://synthetic.example.test";

test("invalid timeouts are rejected before request ownership is registered", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const register = vi.fn();

  await expect(boundedJSONRequest(fetcher, url, {}, 0, "fixture", register)).rejects.toThrow("positive supported integer");
  await expect(boundedJSONRequest(fetcher, url, {}, 2_147_483_648, "fixture", register)).rejects.toThrow("positive supported integer");
  expect(register).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test("a throwing ownership registrar aborts and settles the never-started request", async () => {
  const sentinel = new Error("registrar failed");
  let request!: OwnedJSONRequest;
  let settled = false;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));

  await expect(boundedJSONRequest(fetcher, url, {}, 100, "fixture", owned => {
    request = owned;
    void owned.settled.then(() => { settled = true; });
    throw sentinel;
  })).rejects.toBe(sentinel);

  const didSettle = await Promise.race([request.settled.then(() => true), pause(20).then(() => false)]);
  expect(didSettle).toBe(true);
  expect(settled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  ["valid JSON", "{\"value\":7}", { value: 7 }],
  ["malformed JSON", "{broken", undefined],
] as const)("owned reader confirms %s only after EOF", async (_label, body, expected) => {
  let request!: OwnedJSONRequest;
  let settled = false;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
  const pending = boundedJSONRequest(fetcher, url, {}, 500, "fixture", owned => {
    request = owned;
    void owned.settled.then(() => { settled = true; });
  });

  if (expected === undefined) await expect(pending).rejects.toThrow("not valid JSON");
  else await expect(pending).resolves.toMatchObject({ decoded: expected });
  await request.settled;
  expect(settled).toBe(true);
});

test("a premature reader failure waits for its cancellation before confirming disposal", async () => {
  const readError = new Error("synthetic reader failure");
  let releaseCancel!: () => void;
  let request!: OwnedJSONRequest;
  let settled = false;
  const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  const reader = {
    read: vi.fn(async () => { throw readError; }),
    cancel: vi.fn(() => cancelGate),
    releaseLock: vi.fn(),
  };
  const response = { ok: true, body: { getReader: () => reader } } as unknown as Response;
  const pending = boundedJSONRequest(async () => response, url, {}, 500, "fixture", owned => {
    request = owned;
    void owned.settled.then(() => { settled = true; });
  });

  await vi.waitFor(() => expect(reader.cancel).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  releaseCancel();
  await expect(pending).rejects.toBe(readError);
  await request.settled;
  expect(settled).toBe(true);
  expect(reader.releaseLock).toHaveBeenCalledOnce();
});

test("failed reader cancellation leaves owned disposal unconfirmed", async () => {
  const reader = {
    read: vi.fn(async () => { throw new Error("synthetic reader failure"); }),
    cancel: vi.fn(async () => { throw new Error("synthetic cancel failure"); }),
    releaseLock: vi.fn(),
  };
  const response = { ok: true, body: { getReader: () => reader } } as unknown as Response;
  let request!: OwnedJSONRequest;

  await expect(boundedJSONRequest(async () => response, url, {}, 500, "fixture", owned => { request = owned; }))
    .rejects.toBeInstanceOf(JSONRequestCleanupFailure);
  await expect(request.settled).rejects.toBeInstanceOf(JSONRequestCleanupFailure);
  expect(reader.cancel).toHaveBeenCalledOnce();
});

test("a hanging reader cancellation stays unconfirmed after the caller deadline", async () => {
  let releaseCancel!: () => void;
  let request!: OwnedJSONRequest;
  const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  const reader = {
    read: vi.fn(async () => { throw new Error("synthetic reader failure"); }),
    cancel: vi.fn(() => cancelGate),
    releaseLock: vi.fn(),
  };
  const response = { ok: true, body: { getReader: () => reader } } as unknown as Response;
  const pending = boundedJSONRequest(async () => response, url, {}, 25, "fixture", owned => { request = owned; });

  await expect(pending).rejects.toThrow("25ms");
  let didSettle = false;
  void request.settled.then(() => { didSettle = true; }, () => { didSettle = true; });
  await pause(5);
  expect(didSettle).toBe(false);
  releaseCancel();
  await request.settled;
  expect(reader.cancel).toHaveBeenCalledOnce();
});

test("reader acquisition failure confirms only after response cancellation succeeds", async () => {
  const acquisitionError = new Error("synthetic locked reader");
  let request!: OwnedJSONRequest;
  const body = { getReader: () => { throw acquisitionError; }, cancel: vi.fn(async () => {}) };
  await expect(boundedJSONRequest(async () => ({ ok: true, body } as unknown as Response), url, {}, 500, "fixture", owned => { request = owned; }))
    .rejects.toBe(acquisitionError);
  await expect(request.settled).resolves.toBeUndefined();
  expect(body.cancel).toHaveBeenCalledOnce();
});

test("failed cancellation after reader acquisition failure stays unconfirmed", async () => {
  const body = { getReader: () => { throw new Error("synthetic locked reader"); }, cancel: vi.fn(async () => { throw new Error("cancel failed"); }) };
  let request!: OwnedJSONRequest;
  await expect(boundedJSONRequest(async () => ({ ok: true, body } as unknown as Response), url, {}, 500, "fixture", owned => { request = owned; }))
    .rejects.toBeInstanceOf(JSONRequestCleanupFailure);
  await expect(request.settled).rejects.toBeInstanceOf(JSONRequestCleanupFailure);
  expect(body.cancel).toHaveBeenCalledOnce();
});

test("hanging cancellation after reader acquisition failure remains pending past caller deadline", async () => {
  let releaseCancel!: () => void;
  let request!: OwnedJSONRequest;
  const gate = new Promise<void>(resolve => { releaseCancel = resolve; });
  const body = { getReader: () => { throw new Error("synthetic locked reader"); }, cancel: vi.fn(() => gate) };
  const pending = boundedJSONRequest(async () => ({ ok: true, body } as unknown as Response), url, {}, 25, "fixture", owned => { request = owned; });
  await expect(pending).rejects.toThrow("25ms");
  let settled = false;
  void request.settled.then(() => { settled = true; }, () => { settled = true; });
  await pause(5);
  expect(settled).toBe(false);
  releaseCancel();
  await expect(request.settled).resolves.toBeUndefined();
});
