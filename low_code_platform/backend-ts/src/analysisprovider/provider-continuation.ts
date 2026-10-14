import { z } from "zod";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import type { QueryMessage, QueryTurnResult } from "./query-types.js";

// Opaque provider context, never a user-visible answer or execution authority.
// Keep signatures, encrypted blocks and their order intact for the same model.
export const providerContinuationSchema = z.object({
  profile: z.literal("provider-continuation/v1"),
  model: z.string().min(1).max(256),
  baseURL: z.string().min(1).max(2048),
  reasoning: z.string().optional(),
  reasoning_content: z.string().optional(),
  reasoning_details: z.array(z.record(z.string(), z.unknown())).max(256).optional(),
}).strict();
export type ProviderContinuationSecret = z.infer<typeof providerContinuationSchema>;

export function assertProviderContinuation(value: unknown): asserts value is ProviderContinuationSecret {
  assertBoundedFiniteJSON(value, 262_144, 32_768);
  if (!providerContinuationSchema.safeParse(value).success) throw new Error("Invalid private provider continuation");
}

export function captureProviderContinuation(message: Record<string, unknown>, model: string, baseURL: string): ProviderContinuationSecret {
  const value: Record<string, unknown> = { profile: "provider-continuation/v1", model, baseURL };
  for (const key of ["reasoning", "reasoning_content", "reasoning_details"] as const) {
    if (message[key] !== undefined && message[key] !== null) value[key] = message[key];
  }
  assertProviderContinuation(value);
  return structuredClone(value);
}

export function assistantToolCallMessage(turn: Pick<QueryTurnResult, "text" | "toolCalls"> & { providerContinuationSecret?: ProviderContinuationSecret | undefined }, serialize: (args: Record<string, unknown>) => string = JSON.stringify): QueryMessage {
  if (turn.providerContinuationSecret) assertProviderContinuation(turn.providerContinuationSecret);
  return { role: "assistant", content: turn.text || null,
    tool_calls: turn.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: serialize(call.arguments) } })),
    ...(turn.providerContinuationSecret ? { providerContinuationSecret: structuredClone(turn.providerContinuationSecret) } : {}),
  };
}

/** Only known provider fields leave the backend. A different model/endpoint
 * gets confirmed messages/results, never another model's signed reasoning. */
export function providerWireMessages(messages: readonly QueryMessage[], model: string, baseURL: string) {
  return messages.map(message => {
    const { providerContinuationSecret, ...wire } = message;
    if (!providerContinuationSecret) return wire;
    assertProviderContinuation(providerContinuationSecret);
    if (message.role !== "assistant" || providerContinuationSecret.model !== model || providerContinuationSecret.baseURL !== baseURL) return wire;
    const { profile: _profile, model: _model, baseURL: _baseURL, ...reasoning } = providerContinuationSecret;
    return { ...wire, ...structuredClone(reasoning) };
  });
}

export function latestContinuationModel(messages: readonly QueryMessage[], baseURL: string): string | undefined {
  const saved = messages.findLast(message => message.role === "assistant" && message.providerContinuationSecret)?.providerContinuationSecret;
  if (!saved) return undefined;
  assertProviderContinuation(saved);
  return saved.baseURL === baseURL ? saved.model : undefined;
}
