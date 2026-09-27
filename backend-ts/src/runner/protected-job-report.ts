import type { HandlerServices } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import type { ProtectedMachinePoint } from "../workflows/protected-machine-state.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { reportPagination, newReportPageProgress, newReportCursorProgress, confirmScheduledReportPage, confirmScheduledReportCursor,
  assertReportRelatedKeyProgress, completePaginatedReport, completeCursorPaginatedReport, confirmScheduledReportCoverage } from "../tools/report-coverage-contract.js";
import { protectedHash as hash, sealProtectedCursor, type assertProtectedJobCurrent, type ProtectedJobOwner } from "./protected-job-state.js";
import { protectedReportDefinition, protectedReportWindow, protectedReportArguments, assertProtectedReportProgress, type ProtectedReportNode } from "./protected-report-state.js";
import { appendExecutionEvent } from "./read-checkpoints.js";
import { consumeAcknowledgedProtectedReadResult } from "../tools/read-tool-broker.js";
import type { ProtectedJobCheckpoints } from "./protected-job-checkpoints.js";

export type ProtectedReportCall = { point: ProtectedMachinePoint; node: ProtectedReportNode; index: number; key: string; args: Record<string, unknown> };
/** One genuine broker call per durable ordinal. Nothing external runs inside
 * a transaction. Last-page ACK, aggregate, coverage and machine advancement
 * commit together; an uncertain entered page is never dispatched again. */
export async function executeProtectedReport(services: HandlerServices, executionId: string, options: {
  owner: ProtectedJobOwner; guard: () => void; current: (state: Readonly<RepositoryState>) => ReturnType<typeof assertProtectedJobCurrent>;
  checkpoints: ProtectedJobCheckpoints;
  dispatch: (call: ProtectedReportCall, yaml: string, workflowId: string, actorId: string) => Promise<Record<string, unknown>>;
  advance: (state: RepositoryState, point: ProtectedMachinePoint, output: Record<string, unknown>, saved: ReturnType<typeof assertProtectedJobCurrent>) => void;
  oneBoundary: boolean;
}) {
  for (;;) {
    const prepared = await services.repository.mutateExecution(executionId, state => {
      options.guard(); const saved = options.current(state), point = saved.machine.peek();
      const node = saved.plan.ir.root.nodes.find(item => item.id === point?.nodeId);
      if (!point?.valid || point.kind !== "action" || node?.kind !== "action" || node.effectClass !== "read") throw new Error("Protected report lacks exact owned read boundary");
      const tool = protectedReportDefinition(state, node), pagination = reportPagination(tool)!;
      const base = point.arguments as Record<string, unknown>, window = protectedReportWindow(tool, base);
      const progress = saved.run.reportPageSecret?.[point.invocationId] ?? (pagination.profile === "page-number/v1" ?
        newReportPageProgress(tool, point.nodeId, node.capability.contractHash, window.startAt, window.endAt) :
        newReportCursorProgress(tool, point.nodeId, node.capability.contractHash, window.startAt, window.endAt));
      assertProtectedReportProgress(tool, point, progress);
      const args = protectedReportArguments(tool, base, progress), ordinal = progress.pages.length;
      if (ordinal >= pagination.max_pages || ordinal >= 100 || validateToolInput(tool.input_schema, args).length) throw new Error("Protected report page exceeds reviewed bounds or input schema");
      const existing = Object.values(saved.ledger.snapshot().intents).find(item => item.sequence === point.sequence && item.component.kind === "report-page" && item.component.ordinal === ordinal);
      const key = existing?.key ?? saved.ledger.prepare(saved.machine, "report-page", { kind: "report-page", mode: pagination.profile === "page-number/v1" ? "page" : "cursor", ordinal }, args, options.owner.epoch);
      if (existing && (existing.state !== "PREPARING" || existing.epoch !== options.owner.epoch || existing.argumentHash !== hash(args))) throw new Error("Protected report cannot replay an entered page");
      (saved.run.reportPageSecret ??= {})[point.invocationId] = progress;
      saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(services, state, saved.run, saved.machine);
      appendExecutionEvent(state, saved.run, "node.protected_report_preparing", { invocationId: point.invocationId, ordinal }, point.nodeId, point.invocationId);
      const yaml = saved.run.workflowSnapshot!.yaml, index = parseWorkflowYAMLStrict(yaml).steps.findIndex(step => step.id === point.nodeId);
      return { point, node, args, key, index, ordinal, tool, progress: structuredClone(progress), yaml, workflowId: saved.run.workflowId, actorId: saved.run.startedBy.id };
    });
    const result = await options.dispatch(prepared, prepared.yaml, prepared.workflowId, prepared.actorId);
    const output = consumeAcknowledgedProtectedReadResult(result, options.checkpoints, prepared.node.capability.toolId, prepared.node.capability.contractHash, prepared.args,
      { actorId: prepared.actorId, executionId, workflowId: prepared.workflowId, admissionPin: prepared.node.capability.admission! });
    if (!output) throw new Error("Protected report page lacks genuine exact broker completion");
    if (validateToolInput(prepared.tool.bridge_contract!.output_schema, output.structuredContent).length) throw new Error("Protected report page violates reviewed output schema");
    const pagination = reportPagination(prepared.tool)!;
    const confirmed = pagination.profile === "page-number/v1" && prepared.progress.profile === "schedule-report-pages/v1" ?
      confirmScheduledReportPage({ tool: prepared.tool, args: prepared.args, output, startAt: prepared.progress.startAt, endAt: prepared.progress.endAt, page: prepared.progress.nextPage }) :
      pagination.profile === "opaque-cursor/v1" && prepared.progress.profile === "schedule-report-cursors/v1" ?
      confirmScheduledReportCursor({ tool: prepared.tool, args: prepared.args, output, startAt: prepared.progress.startAt, endAt: prepared.progress.endAt,
        cursor: prepared.progress.nextCursor, ordinal: prepared.ordinal + 1 }) : (() => { throw new Error("Protected report pagination profile changed"); })();
    const candidate = [...prepared.progress.items, ...confirmed.items];
    assertReportRelatedKeyProgress(prepared.tool, prepared.args, candidate, confirmed.hasMore);
    if (prepared.progress.snapshotValue !== undefined && prepared.progress.snapshotValue !== confirmed.snapshotValue ||
        prepared.progress.totalCount !== undefined && prepared.progress.totalCount !== confirmed.totalCount ||
        (confirmed.hasMore ? candidate.length >= confirmed.totalCount : candidate.length !== confirmed.totalCount) ||
        candidate.length > pagination.max_items || canonicalJSONBytes(candidate).length > 1_000_000 ||
        confirmed.hasMore && prepared.ordinal + 1 >= pagination.max_pages)
      throw new Error("Protected report snapshot, total, exhaustion or reviewed bounds are inconsistent");
    if ("nextCursor" in confirmed && prepared.progress.profile === "schedule-report-cursors/v1" && confirmed.hasMore &&
        [hash(prepared.progress.initialCursor), ...prepared.progress.pages.map(page => page.nextCursorHash)].includes(confirmed.evidence.nextCursorHash))
      throw new Error("Protected report cursor repeated a consumed page");
    await services.repository.mutateExecution(executionId, state => {
      options.guard(); const saved = options.current(state), point = saved.machine.peek(), progress = saved.run.reportPageSecret?.[prepared.point.invocationId];
      if (hash(point) !== hash(prepared.point) || !progress || hash(progress) !== hash(prepared.progress)) throw new Error("Protected report completion lost its exact item/page state");
      progress.pages.push(confirmed.evidence as never); progress.items = candidate; progress.snapshotValue ??= confirmed.snapshotValue;
      progress.totalCount ??= confirmed.totalCount; progress.lastOutput = structuredClone(output);
      if (progress.profile === "schedule-report-pages/v1") progress.nextPage++; else if ("nextCursor" in confirmed) progress.nextCursor = confirmed.nextCursor;
      let accepted = output;
      if (!confirmed.hasMore) {
        const completed = progress.profile === "schedule-report-pages/v1" ? completePaginatedReport(prepared.tool, progress) : completeCursorPaginatedReport(prepared.tool, progress);
        // Page text describes only the last page and can echo raw cursors. The
        // complete answer is the schema-checked server aggregate alone.
        accepted = withoutSecretFields({ content: [], structuredContent: completed.output.structuredContent }) as Record<string, unknown>;
        if (validateToolInput(prepared.tool.bridge_contract!.output_schema, accepted.structuredContent).length) throw new Error("Protected report aggregate violates reviewed output schema");
        const coverage = confirmScheduledReportCoverage({ tool: prepared.tool, nodeId: prepared.point.nodeId, contractHash: prepared.node.capability.contractHash,
          args: prepared.point.arguments as Record<string, unknown>, output: accepted, startAt: progress.startAt, endAt: progress.endAt, pagination: completed.receiptPagination });
        (saved.run.reportCoverages ??= {})[prepared.point.invocationId] = coverage;
        delete saved.run.reportPageSecret![prepared.point.invocationId]; if (!Object.keys(saved.run.reportPageSecret!).length) delete saved.run.reportPageSecret;
      }
      saved.ledger.acknowledgeOutput(saved.machine, prepared.key, accepted, options.owner.epoch);
      saved.run.protectedInvocationSecret = saved.ledger.snapshot();
      appendExecutionEvent(state, saved.run, "node.protected_report_page_completed", { invocationId: prepared.point.invocationId, ordinal: prepared.ordinal,
        itemCount: confirmed.items.length, hasMore: confirmed.hasMore }, prepared.point.nodeId, prepared.point.invocationId);
      if (!confirmed.hasMore) options.advance(state, prepared.point, accepted, saved);
      else sealProtectedCursor(services, state, saved.run, saved.machine);
    });
    if (!confirmed.hasMore || options.oneBoundary) return;
  }
}
