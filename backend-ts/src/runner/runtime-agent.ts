import type { QueryMessage, QueryToolCall, QueryToolDefinition, QueryTurnResult } from "../analysisprovider/query-types.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { mcpResultForModel } from "../tools/mcp-result.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { validateValue } from "../structured-output/validate.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { promptData, RUNTIME_AGENT_SYSTEM_PROMPT } from "../prompts/contracts.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import type { OperationAgentCapability, OperationAgentNode } from "../workflows/compiled-read.js";

export const RUNTIME_AGENT_PROMPT_VERSION = "prompt/runtime-agent/v1";

export type RuntimeAgentFailureCode =
  | "AGENT_BUDGET_EXHAUSTED"
  | "AGENT_COMPLETION_UNMET"
  | "AGENT_OUTPUT_INVALID"
  | "AGENT_TOOL_DENIED"
  | "AGENT_USAGE_UNMEASURED";

export class RuntimeAgentKnownFailure extends Error {
  constructor(readonly code: RuntimeAgentFailureCode, message: string) { super(message); this.name = "RuntimeAgentKnownFailure"; }
}

export type RuntimeAgentHooks = {
  beforeModel(round: number, messages: readonly QueryMessage[]): Promise<void>;
  afterModel(round: number, turn: QueryTurnResult): Promise<void>;
  callTool(capability: OperationAgentCapability, tool: ToolDefinition, call: QueryToolCall, round: number, callIndex: number, signal: AbortSignal): Promise<Record<string, unknown>>;
  afterTool(capability: OperationAgentCapability, call: QueryToolCall, output: Record<string, unknown>, round: number, callIndex: number): Promise<void>;
};

export type RuntimeAgentResult = {
  output: Record<string, unknown>;
  rounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

/** Runs one reviewed runtime-agent node. It has no direct connector access:
 * every proposed call is handed to the caller's governed read gateway hook. */
export async function runRuntimeAgent(input: {
  node: OperationAgentNode;
  taskInput: unknown;
  runtime: ProviderRuntime;
  tools: readonly ToolDefinition[];
  hooks: RuntimeAgentHooks;
  workflowId: string;
  executionId: string;
  actor: { id: string; role: string };
  traceId?: string;
  signal?: AbortSignal;
}): Promise<RuntimeAgentResult> {
  const { node } = input, started = performance.now(), deadline = Date.now() + node.maxWallTimeMs;
  const timeoutSignal = AbortSignal.timeout(node.maxWallTimeMs), signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const offered = node.allowedCapabilities.map(capability => {
    const matches = input.tools.filter(tool => tool.tool_id === capability.toolId && tool.is_read_only &&
      (tool.name === capability.action || tool.mcp_tool_name === capability.remoteName));
    if (matches.length !== 1) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Allowed capability ${capability.action} is unavailable`);
    return { capability, tool: matches[0]! };
  });
  const definitions: QueryToolDefinition[] = offered.map(({ capability, tool }) => ({ type: "function", function: {
    name: capability.remoteName, description: tool.description, parameters: structuredClone(tool.input_schema),
  } }));
  const messages: QueryMessage[] = [
    { role: "system", content: RUNTIME_AGENT_SYSTEM_PROMPT },
    { role: "user", content: promptData({ TASK: node.instruction, INPUT: input.taskInput, OUTPUT_SCHEMA: node.outputSchema, COMPLETION_PREDICATE: node.completionPredicate }) },
  ];
  const seen = new Set<string>();
  let totalInput = 0, totalOutput = 0, toolCalls = 0;
  const assertBudget = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Runtime agent cancelled");
    if (Date.now() >= deadline) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent wall-time budget was exhausted");
    if (totalInput + totalOutput >= node.maxTotalTokens) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent token budget was exhausted");
  };
  for (let round = 0; round < node.maxRounds; round++) {
    assertBudget();
    await input.hooks.beforeModel(round, messages);
    const remaining = node.maxTotalTokens - totalInput - totalOutput;
    const turn = await input.runtime.queryWithTools(messages, definitions, {
      ...(node.model ? { model: node.model } : {}), maxOutputTokens: Math.min(node.maxOutputTokens, remaining), signal,
      promptTemplateVersion: RUNTIME_AGENT_PROMPT_VERSION,
      context: { workflowId: input.workflowId, executionId: input.executionId, actor: input.actor,
        ...(input.traceId ? { traceId: input.traceId } : {}), egress: { purpose: "runtime_agent", dataClass: node.dataClass } },
    });
    await input.hooks.afterModel(round, turn);
    if (turn.measured !== true) throw new RuntimeAgentKnownFailure("AGENT_USAGE_UNMEASURED", "Runtime agent provider did not return measurable token usage");
    totalInput += turn.inputTokens; totalOutput += turn.outputTokens;
    if (totalInput + totalOutput > node.maxTotalTokens) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent token budget was exceeded");
    if (turn.toolCalls.length === 0) {
      if (turn.stopReason !== "stop" || !turn.text.trim()) throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent did not return a complete structured response");
      let decoded: unknown;
      try { decoded = JSON.parse(turn.text); } catch { throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent output was not valid JSON"); }
      const safe = withoutSecretFields(decoded), errors = validateValue(node.outputSchema, safe);
      if (errors.length || !safe || typeof safe !== "object" || Array.isArray(safe) || canonicalJSONBytes(safe).length > 1_000_000)
        throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", errors.join("; ") || "Runtime agent output exceeded supported bounds");
      let selected: unknown = safe;
      for (const part of node.completionPredicate.path) {
        if (!selected || typeof selected !== "object" || Array.isArray(selected) || !Object.hasOwn(selected, part))
          throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Runtime agent output did not satisfy its reviewed completion predicate");
        selected = (selected as Record<string, unknown>)[part];
      }
      if (!Object.is(selected, node.completionPredicate.equals))
        throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Runtime agent output did not satisfy its reviewed completion predicate");
      return { output: safe as Record<string, unknown>, rounds: round + 1, toolCalls, inputTokens: totalInput, outputTokens: totalOutput,
        latencyMs: Math.max(0, Math.round(performance.now() - started)) };
    }
    if (turn.stopReason !== "tool_calls") throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent returned tool calls with an invalid stop reason");
    if (toolCalls + turn.toolCalls.length > node.maxToolCalls) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent tool-call budget was exhausted");
    messages.push({ role: "assistant", content: turn.text || null, tool_calls: turn.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    for (const [callIndex, call] of turn.toolCalls.entries()) {
      assertBudget();
      const match = offered.filter(value => value.capability.remoteName === call.name);
      if (match.length !== 1) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Runtime agent proposed unavailable action ${call.name}`);
      const { capability, tool } = match[0]!, callKey = `${capability.toolId}:${canonicalJSONBytes(call.arguments).toString("base64url")}`;
      if (seen.has(callKey)) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", "Runtime agent repeated an identical tool request");
      seen.add(callKey);
      const validation = validateToolArguments(capability.action, call.arguments, tool);
      if (validateToolInput(tool.input_schema, call.arguments).length || validation.missing.length || validation.invalid.length || hasReservedBridgeRole(tool) && Object.hasOwn(call.arguments, "role"))
        throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Runtime agent proposed invalid arguments for ${capability.action}`);
      const output = await input.hooks.callTool(capability, tool, call, round, callIndex, signal);
      await input.hooks.afterTool(capability, call, output, round, callIndex);
      toolCalls++;
      messages.push({ role: "tool", tool_call_id: call.id, content: promptData({ source: "untrusted_tool_result", callId: call.id, toolName: capability.action,
        status: "SUCCEEDED", data: mcpResultForModel(output) }) });
    }
  }
  throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent round budget was exhausted");
}
