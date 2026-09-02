import type { ProviderRuntime } from "../providers/runtime.js";
import type { VisualisationSpec } from "./query-loop.js";
import { promptData } from "../prompts/contracts.js";

const PROMPT_VERSION = "prompt/execution-analysis/v2";

export type ExecutionAnalysisInput = {
  executionId: string;
  workflowName: string;
  status: "DONE" | "FAILED" | "AWAITING_APPROVAL";
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  stepOutputs: Record<string, unknown>;
  timeline: Array<{ nodeId?: string; output?: unknown; durationMs?: number }>;
  // The executing agent's own final narration (e.g. "AWAITING APPROVAL: ...").
  // Critical for runs with zero tool steps — an empty timeline alone can't
  // distinguish "nothing needed to happen" from "stopped at an approval gate".
  agentSummary?: string;
  failedStepId?: string;
  failedRuleIds?: string[];
  gateExplanation?: unknown;
  tokens?: { input: number; output: number; total: number };
};

export type ExecutionAnalysisResult = {
  text: string;
  role: "system";
  visualisation?: VisualisationSpec;
};

/*******************************************************************************
 * Function: generateExecutionAnalysis
 *
 * Generates an execution summary and optional visualisation using the
 * provider.
 ******************************************************************************/
export async function generateExecutionAnalysis(
  input: ExecutionAnalysisInput,
  providerRuntime: ProviderRuntime,
  signal?: AbortSignal,
): Promise<ExecutionAnalysisResult> {
  const prompt = buildAnalysisPrompt(input);
  const response = await providerRuntime.generate(prompt, PROMPT_VERSION, signal);
  const text = response.text.trim();
  const visualisation = extractVisualisation(text);
  return {
    text: extractText(text),
    role: "system",
    ...(visualisation !== undefined ? { visualisation } : {}),
  };
}

/*******************************************************************************
 * Function: buildAnalysisPrompt
 *
 * Assembles execution details into the analysis prompt.
 ******************************************************************************/
function buildAnalysisPrompt(input: ExecutionAnalysisInput): string {
  return promptData({ recordedExecution: { executionId: input.executionId, workflowName: input.workflowName,
    status: input.status, startedAt: input.startedAt, completedAt: input.completedAt, durationMs: input.durationMs,
    timeline: input.timeline, stepOutputs: input.stepOutputs, failedStepId: input.failedStepId,
    failedRuleIds: input.failedRuleIds, gateExplanation: input.gateExplanation, tokens: input.tokens },
    untrustedAgentSummary: input.agentSummary ?? "" });
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
      (parsed.type === "bar" || parsed.type === "line" || parsed.type === "table") &&
      typeof parsed.title === "string" &&
      Array.isArray(parsed.data)
    ) return parsed as VisualisationSpec;
  } catch { /* ignore */ }
  return undefined;
}
