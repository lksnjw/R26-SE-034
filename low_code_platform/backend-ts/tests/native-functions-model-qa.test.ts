import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error JavaScript operator fixture, not a production dependency.
import { nativeModelResponse, startNativeModelFixture } from "../scripts/native-functions-model-qa.mjs";
// @ts-expect-error JavaScript operator fixture, not a production dependency.
import { openNativeQaInspector } from "../scripts/native-functions-read-qa.mjs";
import { FirestoreOwnershipFailure } from "../src/storage/firestore-writer-ownership.js";

afterEach(() => vi.unstubAllEnvs());
const config = { LCWE_LOCAL_DOCKER_QA: "native-read/v1", FIRESTORE_PROJECT_ID: "demo-lcwe-records",
  FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`, ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080" };
const query = { model: "local-planning-fixture", messages: [{ role: "user", content: "Reply with exactly OK." }] };

test("literal model response refuses unsupported models, arbitrary prompts and malformed messages", () => {
  expect(nativeModelResponse(query).choices[0].message.content).toBe("OK");
  for (const body of [null, [], { ...query, model: "external-model" }, { ...query, messages: [] },
    { ...query, messages: [{ role: "user", content: "Send an email" }] }, { ...query, messages: [{ role: "user", content: {} }] }])
    expect(() => nativeModelResponse(body)).toThrow();
});

test("local model fixture refuses missing emulator scope and owner credentials before listening", async () => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
  await expect(startNativeModelFixture(config)).rejects.toThrow();
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "owner.json");
  await expect(startNativeModelFixture(config)).rejects.toThrow();
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  for (const patch of [{ LCWE_LOCAL_DOCKER_QA: "other" }, { FIRESTORE_PROJECT_ID: "production" }, { FIRESTORE_WORKSPACE_ID: "owner" }, { ERPBRIDGE_BASE_URL: "https://remote.example.test" }])
    await expect(startNativeModelFixture({ ...config, ...patch })).rejects.toThrow();
});

test("actual loopback fixture authenticates, bounds requests and records only supported completions", async () => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  const fixture = await startNativeModelFixture(config);
  try {
    const send = (path: string, key: string, body: unknown) => fetch(`${fixture.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await send("/other", fixture.apiKey, query)).status).toBe(404);
    expect((await send("/chat/completions", "wrong", query)).status).toBe(403);
    expect((await send("/chat/completions", fixture.apiKey, { ...query, model: "external" })).status).toBe(422);
    expect((await send("/chat/completions", fixture.apiKey, { content: "x".repeat(256001) })).status).toBe(413);
    const accepted = await send("/chat/completions", fixture.apiKey, query); expect(accepted.status).toBe(200); expect(await accepted.json()).toMatchObject({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(fixture.calls).toHaveLength(1); expect(JSON.stringify(fixture.calls)).not.toContain(fixture.apiKey);
  } finally { await fixture.close(); }
});

test.each(["WRITER_HELD", "WRITER_HANDOFF"] as const)("QA inspection retries only confirmed %s, not uncertain storage or work", async reason => {
  const held = new Error("Closing task still owns storage", { cause: new FirestoreOwnershipFailure(reason) });
  const owner = {}, open = vi.fn().mockRejectedValueOnce(held).mockResolvedValue(owner);
  expect(await openNativeQaInspector(open)).toBe(owner); expect(open).toHaveBeenCalledTimes(2);
  for (const reason of ["UNCONFIRMED", "ACK_DEADLINE", "ANCHOR_CHANGED", "LEASE_INVALID"] as const) {
    const failure = new Error("Uncertain", { cause: new FirestoreOwnershipFailure(reason) }), uncertain = vi.fn().mockRejectedValue(failure);
    await expect(openNativeQaInspector(uncertain)).rejects.toBe(failure); expect(uncertain).toHaveBeenCalledOnce();
  }
});

test("QA inspection gives up on persistent contention without starting business work", async () => {
  vi.useFakeTimers();
  try {
    const held = new Error("Held", { cause: new FirestoreOwnershipFailure("WRITER_HELD") }), open = vi.fn().mockRejectedValue(held);
    const result = openNativeQaInspector(open), rejected = expect(result).rejects.toBe(held);
    await vi.advanceTimersByTimeAsync(5000); await rejected; expect(open).toHaveBeenCalledTimes(25);
  } finally { vi.useRealTimers(); }
});

test("loopback delay hook holds one literal response without changing its content or accepting unsupported requests", async () => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:23671"); vi.stubEnv("GCLOUD_PROJECT", "demo-lcwe-records"); vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { enter = resolve; });
  const hook = vi.fn(async () => { enter(); await gate; });
  const fixture = await startNativeModelFixture(config, { beforeReply: hook });
  const send = (body: unknown) => fetch(`${fixture.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${fixture.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect((await send({ ...query, model: "unconfigured" })).status).toBe(422); expect(hook).not.toHaveBeenCalled();
    let finished = false;
    const pending = send(query).then(result => { finished = true; return result; });
    await started; expect(finished).toBe(false); expect(fixture.calls).toHaveLength(1);
    release(); const accepted = await pending; expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ choices: [{ message: { content: "OK" } }] }); expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]).toEqual([{ model: query.model, system: "provider-test" }]);
  } finally { release(); await fixture.close(); }
});
