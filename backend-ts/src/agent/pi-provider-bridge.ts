import type {
  AssistantMessage,
  JsonObject,
  Message,
  Model,
  ToolResultMessage,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import type { ProviderContinuationSecret } from "../analysisprovider/provider-continuation.js";
import { assistantToolCallMessage } from "../analysisprovider/provider-continuation.js";
import type { QueryMessage } from "../analysisprovider/query-types.js";

/** A metadata-only Pi model. The actual provider invocation remains owned by
 * LCWE's configured provider runtime through the custom StreamFn adapter. */
export function piBridgeModel(id: string, name: string, maxTokens: number): Model<"lcwe-query"> {
  return {
    id,
    name,
    api: "lcwe-query",
    provider: "lcwe",
    baseUrl: "",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens,
  };
}

export function piBridgeAssistantMessage(
  bridgeModel: Model<"lcwe-query">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  sequence: number,
  tokens: { input: number; output: number },
  model = bridgeModel.id,
  provider = bridgeModel.provider,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: bridgeModel.api,
    provider,
    model,
    usage: piUsage(tokens),
    stopReason,
    timestamp: Date.now() + sequence,
  };
}

export function combinedAgentSignal(inputSignal: AbortSignal | undefined, agentSignal: AbortSignal | undefined, deadline: number): AbortSignal {
  const signals = [inputSignal, agentSignal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]
    .filter((signal): signal is AbortSignal => signal !== undefined);
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

/** Convert Pi's typed transcript back to LCWE's existing provider contract. */
export function piTranscriptMessages(context: TranscriptContext, continuationByCall: ReadonlyMap<string, ProviderContinuationSecret>): QueryMessage[] {
  return context.messages.flatMap((message): QueryMessage[] => {
    if (message.role === "system") {
      const content = transcriptText(message.content);
      return content === "" ? [] : [{ role: "system", content }];
    }
    if (message.role === "user") return [{ role: "user", content: transcriptText(message.content) }];
    if (message.role === "toolResult") return [{ role: "tool", tool_call_id: message.toolCallId, content: transcriptText(message.content) }];

    const text = message.content.flatMap(content => content.type === "text" ? [content.text] : []).join("\n");
    const calls = message.content.flatMap(content => content.type === "toolCall" ? [{
      id: content.id,
      name: content.name,
      arguments: content.arguments as Record<string, unknown>,
    }] : []);
    if (calls.length === 0) return [{ role: "assistant", content: text || null }];
    const continuation = calls.map(call => continuationByCall.get(call.id)).find((value): value is ProviderContinuationSecret => value !== undefined);
    return [assistantToolCallMessage({ text, toolCalls: calls, ...(continuation ? { providerContinuationSecret: continuation } : {}) })];
  });
}

export function piJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function piUsage(tokens: { input: number; output: number }): Usage {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens.input + tokens.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function transcriptText(content: string | Message["content"] | ToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
}
