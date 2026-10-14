import type { ActionLoopResult } from "./action-loop.js";
import type { RunnerResult } from "../runner/executor.js";

/** Projects actual attempts. Model prose is never completion evidence. This
 * legacy projection does not certify workflow branch or postcondition semantics. */
export function projectActionOutcome(result: ActionLoopResult, expected: ReadonlyArray<{ id: string; names: readonly string[] }>) {
  const matched = result.steps.length === expected.length && result.steps.length > 0 &&
    result.steps.every((step, index) => expected[index]!.names.includes(step.toolName));
  const failed = result.blocked || !matched || result.steps.some((step) => step.error !== undefined || step.governanceStatus === "blocked");
  const projection: RunnerResult = {
    state: Object.fromEntries(result.steps.filter((step) => step.error === undefined && step.governanceStatus !== "blocked")
      .map((step, index) => [`attempt_${index + 1}_${step.toolName}`, step.result])),
    timeline: result.steps.map((step, index) => {
      const nodeId = expected[index]?.names.includes(step.toolName) ? expected[index]!.id : `unmapped_attempt_${index + 1}`;
      const started = Date.parse(step.startedAt), completed = Date.parse(step.completedAt);
      return { id: `tl_${index + 1}`, nodeId, label: step.displayName,
        status: step.error === undefined && step.governanceStatus !== "blocked" ? "DONE" : "FAILED",
        startedAt: step.startedAt, completedAt: step.completedAt,
        durationMs: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0,
        output: step.error ?? step.governanceReason ?? step.result };
    }),
    logs: result.steps.map((step, index) => ({
      level: step.error === undefined && step.governanceStatus !== "blocked" ? "info" : "error",
      nodeId: expected[index]?.names.includes(step.toolName) ? expected[index]!.id : `unmapped_attempt_${index + 1}`,
      timestamp: step.completedAt,
      message: step.error ?? step.governanceReason ?? "Tool attempt completed",
      metadata: { toolName: step.toolName, governanceStatus: step.governanceStatus },
    })),
    tokens: { input: result.totalTokens.input, output: result.totalTokens.output, total: result.totalTokens.input + result.totalTokens.output },
  };
  return { failed, result: projection, reason: result.blocked ? "Operation blocked or failed; review is required"
    : !matched ? "Requested workflow actions were not completed in the expected order"
    : failed ? "One or more tool attempts failed" : null };
}
