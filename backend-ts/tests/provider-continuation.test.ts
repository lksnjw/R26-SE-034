import { expect, test, vi } from "vitest";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { Repository } from "../src/repository/store.js";
import type { Executor } from "../src/runner/executor.js";
import { QUERY_SYSTEM_PROMPT } from "../src/prompts/contracts.js";
import { assistantToolCallMessage, assertProviderContinuation, captureProviderContinuation, providerWireMessages } from "../src/analysisprovider/provider-continuation.js";
import { withoutSecretFields } from "../src/redact/secrets.js";

const baseURL = "https://provider.example.invalid/v1", model = "selected-model";
const initial = [{ role: "system" as const, content: QUERY_SYSTEM_PROMPT }, { role: "user" as const, content: "Read invoices" }];
const details = [
  { type: "reasoning.text", text: "private-reasoning-marker", signature: "opaque-signature==", index: 0, format: "vendor-v1" },
  { type: "reasoning.encrypted", data: "opaque-ciphertext==", index: 1, id: "signed-block" },
];
const response = (fields: Record<string, unknown> = {}) => Response.json({ choices: [{ finish_reason: "tool_calls", message: {
  content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "erp.read", arguments: '{"id":"one"}' } }], ...fields,
} }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
const client = (send: typeof fetch, timeoutMs = 1000) => new OpenAICompatibleClient({ baseURL, model, apiKey: "fixture-only", fetchImplementation: send, timeoutMs });

test.each([
  { reasoning: "private-reasoning-marker" },
  { reasoning_content: "private-reasoning-marker" },
  { reasoning_details: details },
  { reasoning: "", reasoning_content: "", reasoning_details: [] },
  { reasoning: "private-reasoning-marker", reasoning_content: "alias", reasoning_details: details },
])("known continuation fields round-trip exactly and remain absent from public projections: %j", async fields => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => response(fields)), provider = client(send);
  const turn = await provider.queryWithTools(initial, [], {});
  const assistant = assistantToolCallMessage(turn);
  await provider.queryWithTools([...initial, assistant, { role: "tool", tool_call_id: "read-1", content: "Confirmed receipt" }], [], {});
  const wire = JSON.parse(String(send.mock.calls[1]![1]!.body)).messages[2];
  expect(wire).toMatchObject(fields);
  expect(wire).not.toHaveProperty("providerContinuationSecret");
  expect(wire.tool_calls[0].function.arguments).toBe('{"id":"one"}');
  expect(withoutSecretFields(turn)).not.toHaveProperty("providerContinuationSecret");
  expect(JSON.stringify(withoutSecretFields(assistant))).not.toContain("private-reasoning-marker");
});

test("different models/endpoints never receive another model's opaque continuation, but keep receipts", async () => {
  const turn = await client(vi.fn<typeof fetch>().mockImplementation(async () => response({ reasoning_details: details }))).queryWithTools(initial, [], {});
  const assistant = assistantToolCallMessage(turn);
  for (const [nextModel, endpoint] of [["backup-model", baseURL], [model, "https://other.example.invalid/v1"]]) {
    const wire = providerWireMessages([assistant, { role: "tool", tool_call_id: "read-1", content: "Confirmed receipt" }], nextModel!, endpoint!);
    expect(wire[0]).not.toHaveProperty("reasoning_details"); expect(wire[0]).not.toHaveProperty("providerContinuationSecret");
    expect(wire[0]!.tool_calls).toEqual(assistant.tool_calls); expect(wire[1]!.content).toBe("Confirmed receipt");
  }
});

test.each([{ reasoning: 1 }, { reasoning_content: {} }, { reasoning_details: {} }, { reasoning_details: ["invalid"] },
  { reasoning_details: Array.from({ length: 257 }, () => ({})) }, { reasoning: "x".repeat(262145) }])("malformed/bounded continuation fails before a turn is accepted", async fields => {
  await expect(client(vi.fn<typeof fetch>().mockImplementation(async () => response(fields))).queryWithTools(initial, [], {}))
    .rejects.toMatchObject({ kind: "malformed", message: "Query provider returned invalid continuation metadata" });
});

test("non-JSON objects/accessors/cycles cannot enter private continuation", () => {
  const cyclic: any = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, "text", { enumerable: true, get: () => { throw new Error("Getter must not execute"); } });
  for (const item of [cyclic, getter, { text: Infinity }, new Date()]) expect(() => captureProviderContinuation({ reasoning_details: [item] }, model, baseURL)).toThrow();
  expect(() => assertProviderContinuation({ profile: "provider-continuation/v1", model, baseURL, authority: "admin" })).toThrow();
});

test("null provider fields are absent and final responses never retain private reasoning", async () => {
  const provider = client(vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ choices: [{ finish_reason: "stop",
    message: { content: "Final answer", reasoning_details: details, reasoning: null } }] })));
  const turn = await provider.queryWithTools(initial, [], {}); expect(turn).not.toHaveProperty("providerContinuationSecret");
  expect(captureProviderContinuation({ reasoning: null, reasoning_content: null, reasoning_details: null }, model, baseURL)).toEqual({ profile: "provider-continuation/v1", model, baseURL });
});

function runtime(send: typeof fetch, timeoutMs = 1000) {
  const repository = new Repository(), runtime = new ProviderRuntime(repository, { setAnalysisProvider: vi.fn() } as unknown as Executor, send);
  runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL, apiKey: "fixture-only", model, fallbackModel: "backup-model", temperature: 0, timeoutMs,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://provider.example.invalid", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"],
      reviewedAt: "2026-10-12T00:00:00.000Z", reviewedBy: { id: "admin", name: "Admin" } } });
  return { repository, runtime };
}
const interactive = { allowFallback: true, promptTemplateVersion: "prompt/query/v2", context: { egress: { purpose: "interactive" as const, dataClass: "restricted" as const } } };

test.each([429, 500, 503])("technical HTTP %i failure tries exactly one backup and records both attempts", async status => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status })).mockImplementation(async () => response({ reasoning_details: details }));
  const s = runtime(send), turn = await s.runtime.snapshot().queryWithTools(initial, [], interactive);
  expect(send.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).model)).toEqual([model, "backup-model"]);
  expect(turn.modelRouting).toEqual({ requestedModel: model, model: "backup-model", fallbackUsed: true });
  expect(turn.measured).toBe(false);
  expect(Object.values((await s.repository.snapshot()).invocationProvenance).map(row => [row.model, row.status, row.fallbackUsed])).toEqual([[model, "FAILED", false], ["backup-model", "SUCCEEDED", true]]);
  expect(s.runtime.binding!.model).toBe(model);
});

test.each([400, 401, 402, 403])("HTTP %i configuration/auth/credit failures do not switch models", async status => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status })), s = runtime(send);
  await expect(s.runtime.queryWithTools(initial, [], interactive)).rejects.toMatchObject({ kind: "client" }); expect(send).toHaveBeenCalledTimes(1);
});

test("transport failure tries a backup; caller cancellation never does", async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fixture transport failure")).mockImplementation(async () => response());
  await runtime(send).runtime.queryWithTools(initial, [], interactive); expect(send).toHaveBeenCalledTimes(2);
  const cancelled = vi.fn<typeof fetch>().mockImplementation(async () => { throw new TypeError("cancelled transport"); }), controller = new AbortController(); controller.abort();
  await expect(runtime(cancelled).runtime.queryWithTools(initial, [], { ...interactive, signal: controller.signal })).rejects.toMatchObject({ kind: "cancelled" });
  expect(cancelled.mock.calls.length).toBeLessThanOrEqual(1);
});

test("provider timeout uses one backup within the caller's original wall-time bound", async () => {
  const send = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async () => response());
  const turn = await runtime(send, 20).runtime.queryWithTools(initial, [], { ...interactive, signal: AbortSignal.timeout(1000) });
  expect(turn.model).toBe("backup-model"); expect(send).toHaveBeenCalledTimes(2);
});

test("malformed tool proposals do not trigger a fallback and pinned workflow calls stay pinned", async () => {
  const malformed = vi.fn<typeof fetch>().mockImplementation(async () => response({ tool_calls: [{ id: "bad", type: "function", function: { name: "erp.read", arguments: "not-json" } }] }));
  await expect(runtime(malformed).runtime.queryWithTools(initial, [], interactive)).rejects.toMatchObject({ kind: "malformed" }); expect(malformed).toHaveBeenCalledTimes(1);
  const failed = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 503 }));
  const { allowFallback: _allow, ...pinned } = interactive;
  await expect(runtime(failed).runtime.queryWithTools(initial, [], { ...pinned, model })).rejects.toMatchObject({ kind: "server" }); expect(failed).toHaveBeenCalledTimes(1);
});

test("backup exhaustion is terminal, not a loop or a switch back to primary", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 503 }));
  await expect(runtime(send).runtime.queryWithTools(initial, [], interactive)).rejects.toMatchObject({ kind: "server" }); expect(send).toHaveBeenCalledTimes(2);
});
