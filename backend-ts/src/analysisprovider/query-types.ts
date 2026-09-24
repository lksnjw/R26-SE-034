import type { ProviderInvocationContext } from "./types.js";
import type { ProviderContinuationSecret } from "./provider-continuation.js";

export type QueryModelRouting = { requestedModel: string; model: string; fallbackUsed: boolean };

/** Query orchestration needs no repository or executor ownership. */
export interface QueryProvider {
  queryWithTools(messages: QueryMessage[], tools: QueryToolDefinition[], options: QueryOptions): Promise<QueryTurnResult>;
  snapshot?(): QueryProvider;
}

export type QueryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  providerContinuationSecret?: ProviderContinuationSecret;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type QueryToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type QueryOptions = {
  model?: string;
  /** Interactive only. Reviewed/pinned runtime nodes do not silently switch. */
  allowFallback?: boolean;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  promptTemplateVersion?: string;
  context?: Omit<ProviderInvocationContext, "promptTemplateVersion" | "fallbackUsed">;
};

export type QueryToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type QueryTurnResult = {
  text: string;
  toolCalls: QueryToolCall[];
  stopReason: string;
  /** True only when the provider explicitly completed this choice with finish_reason=stop and no tool calls. */
  completionConfirmed?: boolean;
  inputTokens: number;
  outputTokens: number;
  measured?: boolean;
  model?: string;
  provider?: string;
  configurationRevision?: string;
  providerContinuationSecret?: ProviderContinuationSecret;
  modelRouting?: QueryModelRouting;
};
