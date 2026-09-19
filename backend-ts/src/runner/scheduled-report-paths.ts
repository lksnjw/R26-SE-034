import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { HandlerFailure } from "../http/handlers/common.js";
import type { ReportWindowInputBinding } from "../repository/store.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { reportCoverageParameters } from "../tools/report-coverage-contract.js";
import { isOperationToolNode, type CompiledOperationPlan, type OperationToolNode, type ReadBinding } from "../workflows/compiled-read.js";
import { decisionReturnScopes } from "../workflows/decision-return-scopes.js";
import { compileScheduledReportEvidence, scheduledReportHistories, type ScheduledReportEvidence } from "./scheduled-report-evidence.js";

/** Validate the bounded calendar structure before compiling evidence alternatives.
 * Explicit typed joins may carry branch-local proof, never sibling receipts. */
function supportedRoot(plan: CompiledOperationPlan) {
  try {
    const root = plan.ir.flow ?? { kind: "sequence" as const, nodes: plan.ir.root.nodes.map(node => ({ kind: "action" as const, nodeId: node.id })) };
    const scopes = decisionReturnScopes(root, new Set(), { merges: true });
    if (scopes.unreachable.length) throw new Error(`Unreachable calendar work after Return: ${scopes.unreachable.join(", ")}`);
    return root;
  } catch (error) {
    throw new HandlerFailure(422, error instanceof Error ? error.message : "Unsupported calendar control flow", { code: "SCHEDULE_OPERATION_CONTROL_UNSUPPORTED" });
  }
}

function parameterReference(binding: ReadBinding, parameter: string, name: string): boolean {
  const value = binding.kind === "object" ? binding.fields[parameter] : undefined;
  return value?.kind === "ref" && value.source === "workflowInput" && value.path.length === 1 && value.path[0] === name;
}
function nodeReference(binding: ReadBinding, parameter: string, nodeId: string, path: readonly string[]): boolean {
  const value = binding.kind === "object" ? binding.fields[parameter] : undefined;
  return value?.kind === "ref" && value.source === "nodeOutput" && value.nodeId === nodeId &&
    value.path.length === path.length && value.path.every((part, index) => part === path[index]);
}
function rejectCoverage(effectId?: string): never {
  throw new HandlerFailure(422, `An active schedule requires one reviewed complete report or an exact primary/related-key report pair in scope before ${effectId ? `effect ${effectId}` : "an effect"}`,
    { code: "SCHEDULE_REPORT_COVERAGE_REQUIRED" });
}

/** The same denial-only contract runs at activation, occurrence admission and
 * before approval/dispatch. It confers neither coverage receipts nor approval. */
export function scheduledReportPaths(plan: CompiledOperationPlan, tools: readonly ToolDefinition[], binding: ReportWindowInputBinding): Map<string, ScheduledReportEvidence<{ node: OperationToolNode; tool: ToolDefinition }>> {
  const root = supportedRoot(plan);
  const reports = new Map<string, { node: OperationToolNode; tool: ToolDefinition }>();
  const effects = new Set<string>();
  for (const node of plan.ir.root.nodes) {
    if (!isOperationToolNode(node)) continue;
    if (node.effectClass !== "read") effects.add(node.id);
    else { const tool = tools.find(value => value.tool_id === node.capability.toolId); if (tool?.report_coverage_contract) reports.set(node.id, { node, tool }); }
  }
  let histories: ReturnType<typeof scheduledReportHistories>;
  try { histories = scheduledReportHistories(root, new Set(reports.keys()), effects); }
  catch (error) {
    throw new HandlerFailure(422, error instanceof Error ? error.message : "Unsupported calendar report history", { code: "SCHEDULE_OPERATION_CONTROL_UNSUPPORTED" });
  }
  const result = new Map<string, ScheduledReportEvidence<{ node: OperationToolNode; tool: ToolDefinition }>>();
  for (const effect of plan.ir.root.nodes) {
    if (!isOperationToolNode(effect) || effect.effectClass === "read") continue;
    const history = histories.get(effect.id); if (!history) rejectCoverage(effect.id);
    const validate = (visible: readonly string[]) => {
      const coverage: Array<{ node: OperationToolNode; tool: ToolDefinition }> = [];
      for (const id of visible) {
        const report = reports.get(id); if (!report) rejectCoverage(effect.id);
        const { node, tool } = report;
        if (node.capability.contractHash !== resolvedParameterHashBytes(canonicalJSONBytes(tool))) rejectCoverage(effect.id);
        const parameters = reportCoverageParameters(tool)!;
        const pagination = tool.report_coverage_contract!.pagination;
        const pageParameter = pagination?.profile === "page-number/v1" ? pagination.page_parameter : pagination?.cursor_parameter;
        if (!parameterReference(node.inputs, parameters.start, binding.startAtInput) || !parameterReference(node.inputs, parameters.end, binding.endAtInput) ||
            pageParameter && (node.inputs.kind !== "object" || Object.hasOwn(node.inputs.fields, pageParameter))) rejectCoverage(effect.id);
        coverage.push(report);
      }
      const single = coverage.length === 1 && !coverage[0]!.tool.report_coverage_contract!.key_projection && !coverage[0]!.tool.report_coverage_contract!.requested_key_coverage;
      let related = false;
      if (coverage.length === 2) {
        const [primary, secondary] = coverage, a = primary!.tool.report_coverage_contract!, b = secondary!.tool.report_coverage_contract!;
        related = !!a.key_projection && !!b.requested_key_coverage && !a.requested_key_coverage && !b.key_projection &&
          a.key_projection.relation_name === b.requested_key_coverage.relation_name &&
          nodeReference(secondary!.node.inputs, b.requested_key_coverage.keys_parameter, primary!.node.id, ["structuredContent", ...a.key_projection.keys_path]);
      }
      if (!single && !related) rejectCoverage(effect.id);
      return coverage;
    };
    try { result.set(effect.id, compileScheduledReportEvidence(history, validate)); }
    catch (error) {
      if (error instanceof HandlerFailure) throw error;
      throw new HandlerFailure(422, error instanceof Error ? error.message : "Calendar report alternatives are invalid", { code: "SCHEDULE_REPORT_COVERAGE_REQUIRED" });
    }
  }
  if (!result.size) rejectCoverage();
  return result;
}
