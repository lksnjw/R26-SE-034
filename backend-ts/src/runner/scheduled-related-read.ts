import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { Execution, RepositoryState } from "../repository/store.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { assertScheduledReportCoverageReceipt } from "../tools/report-coverage-contract.js";
import { resolveReadBinding, type CompiledOperationPlan, type OperationToolNode } from "../workflows/compiled-read.js";
import { assertOperationMergeEvidence, operationValueState } from "./operation-merge-checkpoints.js";
import { selectScheduledReportEvidence } from "./scheduled-report-evidence.js";
import { scheduledRelatedReportPaths } from "./scheduled-report-paths.js";

/** Denial-only pre-dispatch check inside the owned intent transaction, including
 * each page intent. A plausible displayed key array is never a receipt. */
export function assertScheduledRelatedRead(state: Readonly<RepositoryState>, run: Execution, plan: CompiledOperationPlan,
  tools: readonly ToolDefinition[], node: OperationToolNode, args: Record<string, unknown>): void {
  const source = run.scheduleSource, tool = tools.find(value => value.tool_id === node.capability.toolId);
  if (!source || node.effectClass !== "read" || !tool?.report_coverage_contract?.requested_key_coverage) return;
  assertOperationMergeEvidence(state as RepositoryState, run, plan);
  const evidence = scheduledRelatedReportPaths(plan, tools, source.reportWindowBinding).get(node.id);
  const selected = evidence ? selectScheduledReportEvidence(evidence, run.readProgress!) : [];
  if (selected.length !== 1) throw new Error("Related read requires one selected acknowledged primary report");
  const { node: primary, tool: primaryTool } = selected[0]!;
  const receipt = run.reportCoverages?.[primary.id] ?? (run.reportCoverage?.nodeId === primary.id ? run.reportCoverage : undefined);
  const attempt = run.readProgress?.attempts[primary.id], output = run.stepOutputs?.[primary.id];
  if (!receipt || attempt?.status !== "DONE" || !output || typeof output !== "object" || Array.isArray(output) ||
      receipt.toolId !== primaryTool.tool_id || receipt.contractHash !== primary.capability.contractHash ||
      receipt.relatedRecords?.mode !== "PROJECTED" || receipt.relatedRecords.relationName !== tool.report_coverage_contract.requested_key_coverage.relation_name)
    throw new Error("Related read primary report has no exact complete acknowledged coverage");
  const intents = Object.values(run.operationSecret?.intents ?? {}).filter(intent => intent.nodeId === primary.id);
  const timeline = state.timelines[run.id]?.filter(entry => entry.nodeId === primary.id && entry.attemptId === attempt.id);
  const completed = state.executionEvents[run.id]?.filter(event => event.nodeId === primary.id && event.type === "node.completed" && event.attemptId === attempt.id);
  if (intents.length !== (receipt.pagination?.pageCount ?? 1) || intents.some(intent => intent.state !== "ACKNOWLEDGED") ||
      timeline?.length !== 1 || timeline[0]!.status !== "DONE" || completed?.length !== 1)
    throw new Error("Related read primary report is detached from acknowledged execution evidence");
  const primaryArgs = resolveReadBinding(primary.inputs, operationValueState(run)) as Record<string, unknown>;
  assertScheduledReportCoverageReceipt(receipt, { tool: primaryTool, nodeId: primary.id, contractHash: primary.capability.contractHash,
    args: primaryArgs, output: output as Record<string, unknown>, startAt: source.reportWindow.startAt, endAt: source.reportWindow.endAt });
  let keys: unknown = (output as Record<string, unknown>).structuredContent;
  for (const field of primaryTool.report_coverage_contract!.key_projection!.keys_path)
    keys = keys && typeof keys === "object" ? (keys as Record<string, unknown>)[field] : undefined;
  const requested = args[tool.report_coverage_contract.requested_key_coverage.keys_parameter];
  if (!Array.isArray(keys) || !canonicalJSONBytes(keys).equals(canonicalJSONBytes(requested)))
    throw new Error("Related read arguments differ from the selected acknowledged primary key projection");
}
