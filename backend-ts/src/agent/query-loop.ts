import type { ToolDefinition } from "../registry/schemas.js";
import type { QueryMessage, QueryToolDefinition } from "../analysisprovider/query-types.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import { QUERY_SYSTEM_PROMPT, promptData } from "../prompts/contracts.js";
import { validateToolInput } from "../tools/tool-input-schema.js";

export type VisualisationSpec = {
  type: "bar" | "line" | "table" | "pie";
  title: string;
  data: Array<{ label: string; value: number }>;
};

export type ToolCallLogEntry = {
  name: string;
  arguments: Record<string, unknown>;
  iterationIndex: number;
};

export type ToolStep = {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  status?: "SUCCEEDED" | "FAILED";
};

export type QueryLoopInput = {
  userMessage: string;
  chatHistory: Array<{ role: string; text: string }>;
  sessionId: string;
  actorId: string;
  actorRole: string;
  signal?: AbortSignal;
  traceId?: string;
};

export type QueryLoopResult = {
  text: string;
  toolCallLog: ToolCallLogEntry[];
  toolSteps: ToolStep[];
  iterationsUsed: number;
  boundHit: boolean;
  visualisation?: VisualisationSpec;
  totalTokens: { input: number; output: number; measured?: boolean };
  latencyMs: number;
  narrativeRejected?: boolean;
  readOutcome?: "NO_CONFIRMED_READ" | "PARTIAL_READ" | "READS_COMPLETED";
  stopReason?: "COMPLETED" | "LIMIT_REACHED" | "PROVIDER_FAILED" | "CANCELLED";
};

const MAX_ITERATIONS = parseInt(process.env.QUERY_AGENT_MAX_ITERATIONS ?? "5", 10);
const TIMEOUT_MS = parseInt(process.env.QUERY_AGENT_TIMEOUT_MS ?? "30000", 10);
const TOKEN_BUDGET = parseInt(process.env.QUERY_AGENT_TOKEN_BUDGET ?? "4000", 10);

const SYSTEM_PROMPT = QUERY_SYSTEM_PROMPT;

/*******************************************************************************
 * Function: runQueryLoop
 *
 * Runs the query agent with mandatory read-only contract enforcement.
 ******************************************************************************/
export async function runQueryLoop(
  input: QueryLoopInput,
  readOnlyTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  providerRuntime: ProviderRuntime,
  _policyCheckerEnabled = false,
): Promise<QueryLoopResult> {
  const started = performance.now();
  const provider = providerRuntime.snapshot?.() ?? providerRuntime;

  // Mandatory scope, independent of the optional advisory-policy setting.
  assertAllReadOnly(readOnlyTools);
  const agentTools: QueryToolDefinition[] = readOnlyTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.mcp_tool_name.trim() || tool.name,
      description: tool.description,
      parameters: (tool.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  }));

  // Build initial messages
  const messages: QueryMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...input.chatHistory.slice(-10).map((m) => ({
      role: (m.role === "user" || m.role === "assistant" ? m.role : "user") as QueryMessage["role"],
      content: promptData({ source: "untrusted_history", text: m.text }),
    })),
    { role: "user", content: promptData({ USER_REQUEST: input.userMessage }) },
  ];

  const toolCallLog: ToolCallLogEntry[] = [];
  const toolSteps: ToolStep[] = [];
  const seenCallHashes = new Set<string>();
  const totalTokens = { input: 0, output: 0, measured: true };
  let lastText = "";
  let boundHit = false;

  const deadline = Date.now() + TIMEOUT_MS;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (input.signal?.aborted) return buildResult("Read preparation cancelled.", toolCallLog, toolSteps, iteration, true, totalTokens, started, "CANCELLED");
    if (Date.now() > deadline) {
      boundHit = true;
      break;
    }
    if (totalTokens.output >= TOKEN_BUDGET) {
      boundHit = true;
      break;
    }

    let turn;
    try {
      turn = await provider.queryWithTools(messages, agentTools, {
        maxOutputTokens: TOKEN_BUDGET - totalTokens.output,
        promptTemplateVersion: "prompt/query/v2",
        context: { sessionId: input.sessionId, actor: { id: input.actorId, role: input.actorRole }, ...(input.traceId ? { traceId: input.traceId } : {}) },
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    } catch {
      totalTokens.measured = false;
      // Preserve acknowledged read evidence even if the summarising provider
      // fails later. Never expose an arbitrary provider exception as content.
      return buildResult("Report preparation stopped before a complete answer was produced.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started, input.signal?.aborted ? "CANCELLED" : "PROVIDER_FAILED");
    }

    totalTokens.input += turn.inputTokens;
    totalTokens.output += turn.outputTokens;
    totalTokens.measured = totalTokens.measured && turn.measured === true;
    if (input.signal?.aborted) return buildResult("Read preparation cancelled.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started, "CANCELLED");
    lastText = turn.text;

    if (turn.toolCalls.length === 0 || turn.stopReason !== "tool_calls") {
      // Truncation/filtering is not a completed report, even after real reads.
      const complete = turn.stopReason === "stop" && turn.toolCalls.length === 0 && Date.now() <= deadline;
      return buildResult(lastText, toolCallLog, toolSteps, iteration + 1, !complete, totalTokens, started);
    }

    // Append assistant message with tool calls
    messages.push({
      role: "assistant",
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    // Process each tool call
    for (const call of turn.toolCalls) {
      if (input.signal?.aborted) return buildResult("Read preparation cancelled.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started, "CANCELLED");
      if (Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) return buildResult("Read preparation reached its limit.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started);
      const callHash = `${call.name}:${stableHash(call.arguments)}`;
      if (seenCallHashes.has(callHash)) {
        boundHit = true;
        return buildResult(
          lastText || "(Note: search ended — repeated tool call detected.)",
          toolCallLog,
          toolSteps,
          iteration + 1,
          true,
          totalTokens,
          started,
        );
      }
      seenCallHashes.add(callHash);

      toolCallLog.push({ name: call.name, arguments: redactCredentials(call.arguments), iterationIndex: iteration });

      let toolResultContent: string;
      try {
        const matches = readOnlyTools.filter((tool) => (tool.mcp_tool_name.trim() || tool.name) === call.name);
        if (matches.length !== 1 || validateToolInput(matches[0]!.input_schema, call.arguments).length > 0 || Object.hasOwn(call.arguments, "role"))
          throw new Error("Read proposal does not match an offered tool and valid arguments");
        const raw = await callTool(call.name, call.arguments);
        toolSteps.push({ toolName: call.name, arguments: redactCredentials(call.arguments), result: raw, status: "SUCCEEDED" });
        toolResultContent = promptData({ source: "untrusted_tool_result", callId: call.id, toolName: call.name, status: "SUCCEEDED", data: raw });
      } catch (error) {
        toolSteps.push({ toolName: call.name, arguments: redactCredentials(call.arguments), result: { error: errorText(error) }, status: "FAILED" });
        // A denial/failure is not permission to try another tool or argument.
        return buildResult("Read preparation stopped after a failed or denied tool request.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started);
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: toolResultContent });
    }
  }

  // Exhausted iterations
  boundHit = true;
  const notice = lastText.trim() !== ""
    ? `${lastText}\n\n*(Note: search incomplete — maximum iterations reached)*`
    : "*(Note: search incomplete — maximum iterations reached)*";
  return buildResult(notice, toolCallLog, toolSteps, MAX_ITERATIONS, true, totalTokens, started);
}

/*******************************************************************************
 * Function: buildResult
 *
 * Assembles the query response, tool history, usage, and timing.
 ******************************************************************************/
function buildResult(
  text: string,
  toolCallLog: ToolCallLogEntry[],
  toolSteps: ToolStep[],
  iterationsUsed: number,
  boundHit: boolean,
  totalTokens: { input: number; output: number; measured?: boolean },
  started: number,
  stopReason: QueryLoopResult["stopReason"] = boundHit ? "LIMIT_REACHED" : "COMPLETED",
): QueryLoopResult {
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  const successful = toolSteps.filter((step) => step.status === "SUCCEEDED").length;
  // No-read model prose is not evidence of ERP data or completed actions. A
  // read response can never acknowledge a new email, write or schedule.
  const completionClaim = /\b(?:(?:i|we|i've|we've|i have|we have)\s+(?:successfully\s+)?(?:sent|emailed|forwarded|delivered|scheduled|paid|created|updated|deleted|approved|submitted))\b|\b(?:email|e-mail|message|report)\s+(?:(?:has been|was|is|successfully)\s+)*(?:sent|emailed|delivered|scheduled)\b/i.test(text);
  const narrativeRejected = successful === 0 || completionClaim;
  if (narrativeRejected) text = successful === 0 ? "No confirmed ERP data was retrieved. No email was sent, schedule activated or ERP change made." : "The assistant returned an unsupported action-completion claim. Confirmed read results are available, but no email was sent, schedule activated or ERP change made.";
  const vis = extractVisualisation(text);
  return {
    text: extractText(text),
    toolCallLog,
    toolSteps,
    iterationsUsed,
    boundHit,
    ...(vis !== undefined ? { visualisation: vis } : {}),
    totalTokens,
    latencyMs,
    narrativeRejected, readOutcome: successful === 0 ? "NO_CONFIRMED_READ" : successful !== toolSteps.length || boundHit ? "PARTIAL_READ" : "READS_COMPLETED",
    stopReason,
  };
}

/*******************************************************************************
 * Function: extractText
 *
 * Removes embedded visualisation blocks from response text.
 ******************************************************************************/
function extractText(text: string): string {
  return text.replace(/<vis>[\s\S]*?<\/vis>/g, "").trim();
}

/*******************************************************************************
 * Function: extractVisualisation
 *
 * Parses and checks an embedded visualisation specification.
 ******************************************************************************/
function extractVisualisation(text: string): VisualisationSpec | undefined {
  const match = /<vis>([\s\S]*?)<\/vis>/i.exec(text);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed.type === "bar" || parsed.type === "line" || parsed.type === "table" || parsed.type === "pie") &&
      typeof parsed.title === "string" &&
      Array.isArray(parsed.data)
    ) {
      return parsed as VisualisationSpec;
    }
  } catch { /* not parseable — ignore */ }
  return undefined;
}

/*******************************************************************************
 * Function: assertAllReadOnly
 *
 * Rejects tools that are not explicitly marked as read-only.
 ******************************************************************************/
function assertAllReadOnly(tools: readonly ToolDefinition[]): void {
  for (const tool of tools) {
    if (tool.is_read_only !== true) {
      throw new Error(
        `Query loop startup failed: tool "${tool.name}" is not marked is_read_only. ` +
        "Only read-only tools may be offered to the query agent.",
      );
    }
  }
}

/*******************************************************************************
 * Function: stableHash
 *
 * Serializes sorted top-level keys for a stable tool-argument comparison.
 ******************************************************************************/
function stableHash(obj: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = obj[k]; return acc; }, {}));
}

/*******************************************************************************
 * Function: redactCredentials
 *
 * Replaces values under credential-like keys with redaction markers.
 ******************************************************************************/
function redactCredentials(args: Record<string, unknown>): Record<string, unknown> {
  const credentialKeys = /(?:password|secret|token|key|credential|auth)/i;
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, credentialKeys.test(k) ? "[REDACTED]" : v]),
  );
}



/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
