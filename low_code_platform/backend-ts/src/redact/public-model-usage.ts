import type { Execution, ExecutionEvent, InvocationProvenanceRecord } from "../repository/store.js";
import { withoutSecretFields } from "./secrets.js";

export type RecordedTokenCounts = { input: number; output: number; total: number };
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Numeric evidence only: no coercion, inherited fields, arbitrary nested data,
 * overflow or inconsistent totals. Missing/malformed evidence is not zero. */
export function recordedTokenCounts(value: unknown): RecordedTokenCounts | undefined {
  if (!record(value) || !["input", "output", "total"].every(key => Object.hasOwn(value, key))) return undefined;
  const { input, output, total } = value;
  if (!count(input) || !count(output) || !count(total) || !Number.isSafeInteger(input + output) || input + output !== total) return undefined;
  return { input, output, total };
}

function invocationCounts(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!record(value) || !["inputTokens", "outputTokens"].every(key => Object.hasOwn(value, key))) return undefined;
  const { inputTokens, outputTokens } = value;
  if (!count(inputTokens) || !count(outputTokens) || !Number.isSafeInteger(inputTokens + outputTokens)) return undefined;
  return { inputTokens, outputTokens };
}

/** Call only after execution visibility/control checks. Generic secret filtering
 * stays unchanged; reconstruct exactly three root numeric counters afterward.
 * These are recorded counters, not a claim that uncertain calls were free. */
export function publicExecution(execution: Execution): Record<string, unknown> {
  const safe = withoutSecretFields(execution) as Record<string, unknown>;
  const tokens = recordedTokenCounts(execution.tokens);
  return { ...safe, ...(tokens ? { tokens } : {}) };
}

/** Only code-owned model-usage event types restore the exact numeric pair.
 * Tool results, arbitrary events and nested 'tokens' objects stay filtered. */
export function publicExecutionEvent(event: ExecutionEvent): Record<string, unknown> {
  const safe = withoutSecretFields(event) as Record<string, unknown>;
  return { ...safe, payload: publicExecutionEventPayload(event.type, event.payload) };
}

/** The same strict projection is used when recording a new journal event.
 * Historical events without counts are never backfilled or guessed. */
export function publicExecutionEventPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const safe = withoutSecretFields(payload) as Record<string, unknown>;
  if (!["node.agent_model_acknowledged", "node.agent_completed", "node.analysis_completed"].includes(type)) return safe;
  const usage = invocationCounts(payload);
  return { ...safe, ...(usage ?? {}) };
}

/** Audit-only trace projections retain provider-reported usage only when
 * explicitly measured. An unmeasured invocation must not fabricate zero. */
export function publicModelInvocation(invocation: InvocationProvenanceRecord): Record<string, unknown> {
  const safe = withoutSecretFields(invocation) as Record<string, unknown>;
  const usage = invocation.measured === true ? invocationCounts(invocation) : undefined;
  return { ...safe, ...(usage ?? {}) };
}
