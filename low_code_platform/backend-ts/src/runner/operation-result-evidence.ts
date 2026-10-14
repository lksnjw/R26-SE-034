import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import type { Execution, RepositoryState } from "../repository/store.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { validateValue } from "../structured-output/validate.js";
import { toolSchema } from "../registry/schemas.js";
import { assertScheduledReportCoverageReceipt } from "../tools/report-coverage-contract.js";
import { resolveReadBinding, type CompiledOperationPlan } from "../workflows/compiled-read.js";
import { operationValueState } from "./operation-merge-checkpoints.js";

const equal = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));

/** Restart evidence only. A DONE label or pointer is not a saved call result.
 * No provider/SDK entry, retry, publication or approval is available here. */
export function assertConfirmedOperationResults(state: RepositoryState, run: Execution, plan: CompiledOperationPlan): void {
  const attempts = run.readProgress!.attempts, journal = run.operationSecret!;
  if (Object.keys(run.stepOutputs ?? {}).some(id => attempts[id]?.status !== "DONE")) throw new Error("Orphaned operation result");
  for (const attempt of Object.values(attempts)) {
    if (attempt.status !== "DONE") continue;
    const node = plan.ir.root.nodes[attempt.stepIndex], rawOutput = run.stepOutputs?.[attempt.nodeId];
    const output = rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput) ? rawOutput as Record<string, unknown> : undefined;
    const timeline = state.timelines[run.id]?.filter(entry => entry.nodeId === attempt.nodeId && entry.attemptId === attempt.id);
    const type = node?.kind === "analysis" ? "node.analysis_completed" : node?.kind === "agent" ? "node.agent_completed" : "node.completed";
    const events = state.executionEvents[run.id]?.filter(event => event.type === type && event.nodeId === attempt.nodeId && event.attemptId === attempt.id);
    if (!node || node.id !== attempt.nodeId || !output || !attempt.completedAt || !Number.isFinite(Date.parse(attempt.completedAt)) ||
        timeline?.length !== 1 || timeline[0]!.status !== "DONE" || timeline[0]!.completedAt !== attempt.completedAt ||
        !equal(timeline[0]!.output, withoutSecretFields(output)) || events?.length !== 1 || events[0]!.payload.outcome !== timeline[0]!.outcome)
      throw new Error("Saved operation result is detached from its completed attempt, timeline or event");
    const event = events[0]!, intents = Object.values(journal.intents).filter(intent => intent.nodeId === node.id);
    if (!intents.length || intents.some(intent => intent.state !== "ACKNOWLEDGED" || !intent.completedAt)) throw new Error("Completed node lacks acknowledged calls");
    if (node.kind === "agent") {
      const rounds = event.payload.rounds, final = journal.intents[`${node.id}:model:${Number(rounds) - 1}`];
      if (!Number.isSafeInteger(rounds) || Number(rounds) < 1 || Number(rounds) > node.maxRounds ||
          !final || final.evidenceMeaning !== "agent-structured-output" || final.dispatchKind !== "agent-model" ||
          timeline[0]!.outcome !== "AGENT_STRUCTURED_OUTPUT" || validateValue(node.outputSchema, output.structuredContent).length)
        throw new Error("Agent completion lacks the exact acknowledged final turn");
      let value: unknown = output.structuredContent;
      for (const part of node.completionPredicate.path) value = value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
      if (!Object.is(value, node.completionPredicate.equals)) throw new Error("Saved agent completion predicate is not satisfied");
      continue;
    }
    const intent = intents.filter(intent => intent.id === event.payload.intentId);
    if (intent.length !== 1 || intent[0]!.completedAt !== attempt.completedAt) throw new Error("Completion event lacks its exact acknowledged intent");
    const acknowledged = intent[0]!;
    if (node.kind === "analysis") {
      const provider = journal.analysisProvider, input = resolveReadBinding(node.input, operationValueState(run, plan.ir.flow, node.id));
      if (!provider || acknowledged !== journal.intents[node.id] || acknowledged.invocationId !== attempt.id ||
          acknowledged.evidenceMeaning !== "analysis-structured-output" || timeline[0]!.outcome !== "ANALYSIS_STRUCTURED_OUTPUT" ||
          validateValue(node.outputSchema, output.structuredContent).length || acknowledged.argumentHash !== digest({ input, instruction: node.instruction,
            outputSchema: node.outputSchema, dataClass: node.dataClass, model: node.model || provider.configuration.model,
            maxOutputTokens: node.maxOutputTokens, configurationRevision: provider.configurationRevision })) throw new Error("Saved analysis result lacks exact input/turn evidence");
      continue;
    }
    const pin = node.capability.admission!, tool = toolSchema.parse(state.capabilityRevisions[pin.revisionId]!.definition);
    const args = resolveReadBinding(node.inputs, operationValueState(run, plan.ir.flow, node.id)) as Record<string, unknown>;
    const coverage = run.reportCoverages?.[node.id] ?? (run.reportCoverage?.nodeId === node.id ? run.reportCoverage : undefined);
    if (coverage?.pagination) {
      if (!run.scheduleSource || !tool.report_coverage_contract || timeline[0]!.outcome !== "REPORT_COVERAGE_CONFIRMED") throw new Error("Saved paginated result lacks scheduled coverage");
      assertScheduledReportCoverageReceipt(coverage, { tool, nodeId: node.id, contractHash: node.capability.contractHash, args, output,
        startAt: run.scheduleSource.reportWindow.startAt, endAt: run.scheduleSource.reportWindow.endAt });
    } else if (acknowledged !== journal.intents[node.id] || acknowledged.invocationId !== attempt.id || acknowledged.argumentHash !== digest(args))
      throw new Error("Saved tool result lacks its exact invocation and arguments");
    if (node.effectClass === "read") {
      if (acknowledged.evidenceMeaning === "read-tool-error" || !["READ_CONFIRMED", "REPORT_COVERAGE_CONFIRMED"].includes(String(timeline[0]!.outcome))) throw new Error("Failed read cannot become a completed result");
    } else {
      const approval = acknowledged.approvalId && run.runtimeApprovalSecret?.records[acknowledged.approvalId];
      if (!approval || approval.state !== "CONSUMED" || approval.consumption?.intentId !== acknowledged.id || approval.binding.nodeId !== node.id ||
          approval.binding.operationKey !== acknowledged.operationKey || approval.binding.argumentHash !== acknowledged.argumentHash ||
          !tool.operation_contract || acknowledged.evidenceMeaning !== tool.operation_contract.confirmation.meaning || timeline[0]!.outcome !== acknowledged.evidenceMeaning)
        throw new Error("Saved effect lacks its historical exact consumed approval and result meaning");
    }
  }
}
