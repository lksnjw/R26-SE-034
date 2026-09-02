import type { ToolDefinition } from "../registry/schemas.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import type { QueryMessage, QueryToolDefinition } from "../analysisprovider/query-types.js";
import type { GovernanceUser } from "../governance/gate.js";
import { validateToolArguments } from "./workflow-runtime-validator.js";
import { ACTION_SYSTEM_PROMPT, promptData } from "../prompts/contracts.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { mcpResultForModel } from "../tools/mcp-result.js";
import { ErpbridgeMcpToolError } from "../tools/erpbridge-mcp-client.js";

export type GovernanceCheck = (
  toolName: string,
  toolDef: ToolDefinition,
  args: Record<string, unknown>,
  user: GovernanceUser,
  context: { traceId?: string; sessionId?: string },
) => Promise<{ allowed: boolean; reason?: string }>;

export type ActionStep = {
  toolName: string;
  displayName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  isReadOnly: boolean;
  governanceStatus: "allowed" | "blocked" | "skipped";
  governanceReason?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
};

export type ActionLoopInput = {
  userMessage: string;
  chatHistory: Array<{ role: string; text: string }>;
  sessionId: string;
  actorId: string;
  actorRole: string;
  user: GovernanceUser;
  signal?: AbortSignal;
  traceId?: string;
  onTurn?: (iteration: number) => Promise<void>;
};

export type ActionLoopResult = {
  text: string;
  steps: ActionStep[];
  blocked: boolean;
  workflowYaml: string;
  totalTokens: { input: number; output: number; measured?: boolean };
  latencyMs: number;
};

const MAX_ITERATIONS = parseInt(process.env.ACTION_AGENT_MAX_ITERATIONS ?? "12", 10);
const TIMEOUT_MS = parseInt(process.env.ACTION_AGENT_TIMEOUT_MS ?? "120000", 10);
const TOKEN_BUDGET = parseInt(process.env.ACTION_AGENT_TOKEN_BUDGET ?? "16000", 10);

const SYSTEM_PROMPT = ACTION_SYSTEM_PROMPT;

/*******************************************************************************
 * Function: runActionLoop
 *
 * Runs the chat action loop and records tool steps and governance outcomes.
 ******************************************************************************/
export async function runActionLoop(
  input: ActionLoopInput,
  allTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  _checkGovernance: GovernanceCheck,
  providerRuntime: ProviderRuntime,
): Promise<ActionLoopResult> {
  const started = performance.now();
  const provider = providerRuntime.snapshot?.() ?? providerRuntime;

  const agentTools: QueryToolDefinition[] = allTools.filter((tool) => tool.is_read_only).map((tool) => ({
    type: "function",
    function: {
      name: tool.mcp_tool_name.trim() || tool.name,
      description: `[${tool.is_read_only ? "READ" : "WRITE"}] ${tool.description}`,
      parameters: (tool.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  }));

  const messages: QueryMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...input.chatHistory.slice(-10).map((m) => ({
      role: (m.role === "user" || m.role === "assistant" ? m.role : "user") as QueryMessage["role"],
      content: promptData({ source: "untrusted_history", text: m.text }),
    })),
    { role: "user", content: promptData({ USER_REQUEST: input.userMessage }) },
  ];

  const steps: ActionStep[] = [];
  const totalTokens = { input: 0, output: 0, measured: true };
  let lastText = "";
  let blocked = false;
  const deadline = Date.now() + TIMEOUT_MS;

  try {
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (input.signal?.aborted) { blocked = true; lastText = "Read operation cancelled. No new ERP change was performed."; break; }
    if (Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) break;

    await input.onTurn?.(iteration);
    const turn = await provider.queryWithTools(messages, agentTools, {
      maxOutputTokens: TOKEN_BUDGET - totalTokens.output,
      promptTemplateVersion: "prompt/action/v2",
      context: { sessionId: input.sessionId, actor: { id: input.actorId, role: input.actorRole }, ...(input.traceId ? { traceId: input.traceId } : {}) },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    totalTokens.input += turn.inputTokens;
    totalTokens.output += turn.outputTokens;
    totalTokens.measured = totalTokens.measured && turn.measured === true;
    lastText = turn.text;
    if (input.signal?.aborted) { blocked = true; lastText = "Read operation cancelled. No new ERP change was performed."; break; }

    if (turn.toolCalls.length === 0 || turn.stopReason !== "tool_calls") break;

    messages.push({
      role: "assistant",
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    for (const call of turn.toolCalls) {
      if (blocked) break;
      if (input.signal?.aborted || Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) {
        blocked = true; lastText = "Read operation stopped at cancellation or a configured limit."; break;
      }

      const stepStartedAt = new Date().toISOString();
      const matches = allTools.filter((t) => (t.mcp_tool_name.trim() || t.name) === call.name);
      const toolDef = matches.length === 1 ? matches[0] : undefined;
      const isReadOnly = toolDef?.is_read_only === true;
      const displayName = toolDef?.display_name ?? humanizeName(call.name);

      // No guessed names or silent argument coercion. Invalid proposals are
      // rejected before governance or the dispatch callback is reached.
      const normalizedArguments = structuredClone(call.arguments);
      const argIssues = validateToolArguments(call.name, normalizedArguments, toolDef);
      if (toolDef === undefined || argIssues.missing.length > 0 || argIssues.invalid.length > 0 ||
          validateToolInput(toolDef.input_schema, normalizedArguments).length > 0 || (hasReservedBridgeRole(toolDef) && Object.hasOwn(normalizedArguments, "role"))) {
        const reason = toolDef === undefined ? "Tool is not admitted" : "Tool arguments failed runtime validation";
        steps.push({ toolName: call.name, displayName, arguments: redactCredentials(normalizedArguments), result: null,
          isReadOnly, governanceStatus: "blocked", governanceReason: reason, error: reason,
          startedAt: stepStartedAt, completedAt: new Date().toISOString() });
        blocked = true;
        lastText = reason;
        break;
      }

      // This chat execution profile is read-only regardless of model prose
      // or a permissive policy callback. Effects require the future transaction gateway.
      if (!isReadOnly) {
        const reason = "Live ERP writes are blocked until transaction approval, idempotency and recovery are enforced";
        steps.push({ toolName: call.name, displayName, arguments: redactCredentials(normalizedArguments), result: null,
          isReadOnly: false, governanceStatus: "blocked", governanceReason: reason,
          startedAt: stepStartedAt, completedAt: new Date().toISOString() });
        blocked = true; lastText = reason; break;
      }

      let rawResult: unknown = null;
      try {
        rawResult = await callTool(call.name, normalizedArguments);

        steps.push({
          toolName: call.name,
          displayName,
          arguments: redactCredentials(normalizedArguments),
          result: rawResult,
          isReadOnly,
          governanceStatus: isReadOnly ? "skipped" : "allowed",
          startedAt: stepStartedAt,
          completedAt: new Date().toISOString(),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: promptData({ source: "untrusted_tool_result", callId: call.id, toolName: call.name, status: "SUCCEEDED", data: mcpResultForModel(rawResult) }),
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        steps.push({
          toolName: call.name,
          displayName,
          arguments: redactCredentials(normalizedArguments),
          result: error instanceof ErpbridgeMcpToolError ? error.result : null,
          isReadOnly,
          governanceStatus: isReadOnly ? "skipped" : "allowed",
          error: errMsg,
          startedAt: stepStartedAt,
          completedAt: new Date().toISOString(),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: promptData({ source: "untrusted_tool_result", callId: call.id, toolName: call.name, status: "FAILED", error: errMsg }),
        });
        // A failed callback is not permission to retry or continue. Recovery
        // requires a separately verified operation, not model self-correction.
        blocked = true;
        lastText = "Tool operation failed; review is required";
        break;
      }
    }
    if (blocked) break;
  }
  } catch (error) {
    throw attachPartialSteps(error, steps);
  }

  return {
    text: lastText,
    steps,
    blocked,
    workflowYaml: buildWorkflowYaml(steps, input.userMessage),
    totalTokens,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

// Mirrors runner/executor.ts's attachPartial/partialResult pattern: when the loop
// throws (e.g. a provider outage mid-run), the steps completed so far are attached
// to the error so callers can still show real diagnostic info instead of nothing.
/*******************************************************************************
 * Function: attachPartialSteps
 *
 * Attaches completed action steps to an error for later recovery.
 ******************************************************************************/
function attachPartialSteps(error: unknown, steps: ActionStep[]): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(normalized, "actionLoopSteps", { value: steps, enumerable: false });
  return normalized;
}

/*******************************************************************************
 * Function: partialActionSteps
 *
 * Retrieves action steps preserved on an action-loop error.
 ******************************************************************************/
export function partialActionSteps(error: unknown): ActionStep[] | null {
  if (!(error instanceof Error)) return null;
  return (error as Error & { actionLoopSteps?: ActionStep[] }).actionLoopSteps ?? null;
}

/*******************************************************************************
 * Function: buildWorkflowYaml
 *
 * Builds workflow YAML from action steps that were not blocked.
 ******************************************************************************/
function buildWorkflowYaml(steps: ActionStep[], prompt: string): string {
  const name = prompt.trim().slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Agent Workflow";
  const runnable = steps.filter((s) => s.governanceStatus !== "blocked");
  if (runnable.length === 0) return `name: "${name}"\ndescription: "Generated from chat agent"\nsteps: []`;
  const stepsYaml = runnable.map((step, i) => {
    const paramLines =
      Object.keys(step.arguments).length > 0
        ? "\n    parameters:\n" +
          Object.entries(step.arguments)
            .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
            .join("\n")
        : "";
    return `  - id: step_${i + 1}\n    action: ${step.toolName}\n    description: "${step.displayName}"${paramLines}`;
  }).join("\n");
  return `name: "${name}"\ndescription: "Generated from chat agent"\nsteps:\n${stepsYaml}`;
}

/*******************************************************************************
 * Function: humanizeName
 *
 * Converts an underscored name into a readable title.
 ******************************************************************************/
function humanizeName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}



/*******************************************************************************
 * Function: redactCredentials
 *
 * Replaces values under credential-like keys with redaction markers.
 ******************************************************************************/
function redactCredentials(args: Record<string, unknown>): Record<string, unknown> {
  const cred = /(?:password|secret|token|key|credential|auth)/i;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, cred.test(k) ? "[REDACTED]" : v]));
}
