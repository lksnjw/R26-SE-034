import { expect, test } from "vitest";
import type { Execution, ExecutionEvent, InvocationProvenanceRecord } from "../src/repository/store.js";
import { recordedTokenCounts, publicExecution, publicExecutionEvent, publicExecutionEventPayload, publicModelInvocation } from "../src/redact/public-model-usage.js";
import { withoutSecretFields } from "../src/redact/secrets.js";

const tokens = { input: 11, output: 7, total: 18 };
const execution: Execution = { id: "run", workflowId: "flow", workflowName: "Synthetic", status: "DONE", startedAt: "2026-10-08T00:00:00Z", completedAt: null,
  durationMs: 10, costUsd: 0, startedBy: { id: "qa", name: "QA" }, tokens };
const invocation: InvocationProvenanceRecord = { id: "inv", promptTemplateVersion: "prompt/runtime-agent/v1", promptSha256: "sha256:fixture", provider: "fixture", model: "fixture",
  inputTokens: 11, outputTokens: 7, measured: true, latencyMs: 3, temperature: 0, fallbackUsed: false, status: "SUCCEEDED", createdAt: execution.startedAt };
const event = (type: string, payload: Record<string, unknown>): ExecutionEvent => ({ version: 1, executionId: "run", workflowId: "flow", sequence: 1, timestamp: execution.startedAt, type, payload });

test.each([undefined, null, [], "18", {}, { ...tokens, input: "11" }, { ...tokens, output: null }, { ...tokens, total: 19 }, { ...tokens, input: -1 },
  { ...tokens, output: 0.5 }, { ...tokens, total: Infinity }, { ...tokens, total: NaN }, { input: Number.MAX_SAFE_INTEGER, output: 1, total: Number.MAX_SAFE_INTEGER + 1 }, Object.create(tokens)])(
  "malformed usage %j cannot masquerade as zero or a measured total", value => { expect(recordedTokenCounts(value)).toBeUndefined();
    expect(publicExecution({ ...execution, tokens: value as Execution["tokens"] })).not.toHaveProperty("tokens"); });

test("only three validated root counters survive; nested payloads and generic filtering remain strict", () => {
  const raw = { ...execution, tokens: { ...tokens, apiKey: "nested-secret", arbitrary: { token: "nested-token" } }, apiKey: "root-secret",
    operationSecret: { provider: { apiKey: "private-provider" } }, stepOutputs: { tool: { tokens: { ...tokens, password: "tool-secret" }, visible: "readable" } } };
  const before = structuredClone(raw), safe = publicExecution(raw as unknown as Execution);
  expect(safe.tokens).toEqual(tokens); expect(safe.stepOutputs).toEqual({ tool: { visible: "readable" } }); expect(raw).toEqual(before);
  expect(JSON.stringify(safe)).not.toMatch(/secret|private-provider|nested-token/); expect(withoutSecretFields(raw)).not.toHaveProperty("tokens");
  expect(recordedTokenCounts({ input: 0, output: 0, total: 0 })).toEqual({ input: 0, output: 0, total: 0 });
  expect(recordedTokenCounts({ input: Number.MAX_SAFE_INTEGER, output: 0, total: Number.MAX_SAFE_INTEGER })).toEqual({ input: Number.MAX_SAFE_INTEGER, output: 0, total: Number.MAX_SAFE_INTEGER });
});

test.each(["node.agent_model_acknowledged", "node.agent_completed", "node.analysis_completed"])("%s retains only exact finite numeric usage in the journal and replay projection", type => {
  const payload = { inputTokens: 11, outputTokens: 7, apiKey: "hidden", totalTokens: "not-allowed", nested: { inputTokens: 4, apiKey: "hidden" } };
  const saved = publicExecutionEventPayload(type, payload);
  expect(saved).toEqual({ inputTokens: 11, outputTokens: 7, nested: {} });
  expect(publicExecutionEvent(event(type, saved)).payload).toEqual(saved);
  expect(publicExecutionEvent(event(type, { inputTokens: "secret", outputTokens: 7 })).payload).toEqual({});
  expect(publicExecutionEvent(event(type, {})).payload).toEqual({});
});

test.each(["node.completed", "node.agent_preparing", "run.completed", "fake.model_usage"])("%s cannot restore arbitrary token-shaped tool data", type => {
  expect(publicExecutionEvent(event(type, { inputTokens: 11, outputTokens: 7, tokens, password: "hidden", visible: true })).payload).toEqual({ visible: true });
});

test("audit invocation usage requires measured evidence and never restores extra credential keys", () => {
  const safe = publicModelInvocation({ ...invocation, apiKey: "private" } as InvocationProvenanceRecord);
  expect(safe).toMatchObject({ inputTokens: 11, outputTokens: 7, measured: true }); expect(safe).not.toHaveProperty("apiKey");
  expect(publicModelInvocation({ ...invocation, measured: false })).not.toHaveProperty("inputTokens");
  expect(publicModelInvocation({ ...invocation, inputTokens: Infinity })).not.toHaveProperty("outputTokens");
  expect(publicModelInvocation({ ...invocation, inputTokens: 0, outputTokens: 0 })).toMatchObject({ inputTokens: 0, outputTokens: 0 });
});
