import type { Execution, RepositoryState } from "../repository/store.js";
import type { OperationNode } from "../workflows/compiled-read.js";
import type { CompiledProtectedOperationPlan } from "../workflows/protected-operation-compiler.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";
import type { ProtectedMachinePoint } from "../workflows/protected-machine-state.js";
import { toolSchema, type ToolDefinition } from "../registry/schemas.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { protectedJournalHash as hash } from "../repository/protected-invocation-records.js";
import { assertReportPageProgress, assertReportCursorProgress, assertScheduledReportCoverageReceipt, reportPagination,
  type ReportPaginationProgress } from "../tools/report-coverage-contract.js";

export type ProtectedReportNode = Extract<OperationNode, { kind: "action" }>;
/** Historical reviewed definition, never a discovery hint or current substitute. */
export function protectedReportDefinition(state: Readonly<RepositoryState>, node: ProtectedReportNode): ToolDefinition {
  const pin = node.capability.admission, revision = pin && state.capabilityRevisions[pin.revisionId];
  const tool = toolSchema.parse(revision?.definition);
  if (!pin || revision?.capabilityId !== pin.capabilityId || revision.connectionId !== pin.connectionId ||
      tool.tool_id !== node.capability.toolId || capabilityContractHash(tool) !== node.capability.contractHash ||
      !tool.is_read_only || !tool.report_coverage_contract?.pagination)
    throw new Error("Protected report requires its exact reviewed paginated read contract");
  reportPagination(tool); return tool;
}
export function protectedReportWindow(tool: ToolDefinition, args: Record<string, unknown>) {
  const contract = tool.report_coverage_contract!, pagination = reportPagination(tool)!;
  const startAt = args[contract.start_parameter], endAt = args[contract.end_parameter];
  if (typeof startAt !== "string" || typeof endAt !== "string" || !Number.isFinite(Date.parse(startAt)) ||
      !Number.isFinite(Date.parse(endAt)) || Date.parse(startAt) >= Date.parse(endAt) ||
      Object.hasOwn(args, pagination.profile === "page-number/v1" ? pagination.page_parameter : pagination.cursor_parameter))
    throw new Error("Protected report needs an exact valid window and server-owned continuation");
  return { startAt, endAt };
}
export function protectedReportArguments(tool: ToolDefinition, base: Record<string, unknown>, progress: ReportPaginationProgress) {
  const pagination = reportPagination(tool)!;
  if (pagination.profile === "page-number/v1" && progress.profile === "schedule-report-pages/v1")
    return { ...structuredClone(base), [pagination.page_parameter]: progress.nextPage };
  if (pagination.profile === "opaque-cursor/v1" && progress.profile === "schedule-report-cursors/v1")
    return { ...structuredClone(base), [pagination.cursor_parameter]: progress.nextCursor };
  throw new Error("Protected report continuation profile changed");
}
export function assertProtectedReportProgress(tool: ToolDefinition, point: ProtectedMachinePoint, progress: ReportPaginationProgress) {
  const window = protectedReportWindow(tool, point.arguments as Record<string, unknown>);
  if (progress.nodeId !== point.nodeId || progress.toolId !== tool.tool_id || progress.contractHash !== capabilityContractHash(tool) ||
      progress.startAt !== window.startAt || progress.endAt !== window.endAt || progress.pages.some(page => page.resolution))
    throw new Error("Protected report progress belongs to another invocation/window/contract");
  if (progress.profile === "schedule-report-pages/v1") assertReportPageProgress(tool, progress); else assertReportCursorProgress(tool, progress);
}
/** Replay exact item boundaries and bind every page ordinal to its original
 * journal. The surrounding continuation authenticates the accumulator bytes.
 * An aggregate is acknowledged by the final page transition; earlier page
 * hashes remain individual genuine SDK results, never complete node answers. */
export function assertProtectedReportHistory(plan: CompiledProtectedOperationPlan, run: Execution, state: Readonly<RepositoryState>) {
  const ledger = run.protectedInvocationSecret!, progressRows = run.reportPageSecret ?? {}, coverageRows = run.reportCoverages ?? {};
  if (!plan.ir.root.nodes.some(node => node.kind === "action" && plan.ir.contracts[node.capability.toolId]?.reportCoverageContract)) {
    if (Object.keys(progressRows).length || Object.keys(coverageRows).length || Object.values(ledger.intents).some(intent => intent.purpose === "report-page"))
      throw new Error("Protected run has orphan report state");
    return;
  }
  const seenProgress = new Set<string>(), seenCoverage = new Set<string>();
  const replay = new ProtectedMachine(plan.machine, run.workflowSnapshot!.input); replay.peek();
  for (let at = 0; at <= ledger.nextSequence; at++) {
    const point = replay.peek(), node = point && plan.ir.root.nodes.find(item => item.id === point.nodeId);
    if (point?.kind === "action" && node?.kind === "action" && plan.ir.contracts[node.capability.toolId]?.reportCoverageContract) {
      const tool = protectedReportDefinition(state, node), pagination = reportPagination(tool)!;
      const intents = Object.values(ledger.intents).filter(item => item.sequence === at).sort((a, b) =>
        (a.component.kind === "report-page" ? a.component.ordinal : -1) - (b.component.kind === "report-page" ? b.component.ordinal : -1));
      const progress = progressRows[point.invocationId], coverage = coverageRows[point.invocationId];
      if (progress) { seenProgress.add(point.invocationId); assertProtectedReportProgress(tool, point, progress); }
      if (coverage) seenCoverage.add(point.invocationId);
      const receipt = ledger.receipts[String(at)], output = receipt?.result.kind === "accept" ? receipt.result.output as Record<string, unknown> : undefined;
      if (at < ledger.nextSequence) {
        if (!coverage || !output || progress || hash(run.stepOutputs?.[point.invocationId]) !== hash(output)) throw new Error("Protected report advanced without exact complete coverage and answer");
        assertScheduledReportCoverageReceipt(coverage, { tool, nodeId: point.nodeId, contractHash: node.capability.contractHash,
          args: point.arguments as Record<string, unknown>, output, ...protectedReportWindow(tool, point.arguments as Record<string, unknown>) });
      } else if (coverage) throw new Error("Protected pending report cannot claim complete coverage");
      const pages = coverage?.pagination?.pages ?? progress?.pages ?? [];
      if (intents.length < pages.length || intents.length > pages.length + (coverage ? 0 : 1)) throw new Error("Protected report page journal count changed");
      for (let ordinal = 0; ordinal < intents.length; ordinal++) {
        const intent = intents[ordinal]!, page = pages[ordinal];
        if (intent.purpose !== "report-page" || intent.component.kind !== "report-page" || intent.component.ordinal !== ordinal ||
            intent.component.mode !== (pagination.profile === "page-number/v1" ? "page" : "cursor") ||
            (page ? intent.state !== "ACKNOWLEDGED" || intent.result?.kind !== "OUTPUT" || intent.argumentHash !== page.argumentHash ||
              intent.result.hash !== (coverage && ordinal === pages.length - 1 ? hash(output) : page.outputHash) : intent.state === "ACKNOWLEDGED"))
          throw new Error("Protected report page evidence differs from exact original ordinal and result");
        if (!page && progress && intent.argumentHash !== hash(protectedReportArguments(tool, point.arguments as Record<string, unknown>, progress)))
          throw new Error("Protected prepared page arguments changed");
      }
      if (!progress && !coverage && intents.length) throw new Error("Protected report page lacks its private accumulator");
    }
    if (at < ledger.nextSequence) { const result = ledger.receipts[String(at)]!.result; if (result.kind === "accept") replay.accept(result.output); else replay.fail(result.fault); replay.peek(); }
  }
  if (Object.keys(progressRows).some(key => !seenProgress.has(key)) || Object.keys(coverageRows).some(key => !seenCoverage.has(key)))
    throw new Error("Protected report state has foreign invocation records");
}
