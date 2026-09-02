import type { ProviderInvocationContext } from "./types.js";

export type QueryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
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
  inputTokens: number;
  outputTokens: number;
  measured?: boolean;
  model?: string;
  provider?: string;
  configurationRevision?: string;
};
