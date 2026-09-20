import { effectiveStepKind, type WorkflowBlueprint } from "../models/schemas.js";
import type { ReadBinding } from "../workflows/compiled-read.js";
import { controlNodes, parseReadControlFlow, type ReadSequence } from "../workflows/read-control-flow.js";
import { compileScheduledReportEvidence, scheduledReportHistories, type ScheduledReportEvidence } from "../runner/scheduled-report-evidence.js";
import { modelInputSchema } from "../models/model-input.js";
import { deliveryOutputReferences, exactOutputReference, type RecurringAnalysisMapping } from "./recurring-analysis.js";
import type { RecurringAutomationComposition, RecurringRequestedResource } from "./recurring-automation.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { RecurringPathLogic } from "./recurring-path-logic.js";

type Report = { id: string; index: number; resource: RecurringRequestedResource; tool: ToolDefinition; parameters: Record<string, unknown> };
type Delivery = { id: string; tool: ToolDefinition; parameters: Record<string, unknown> };
type Source = { raw: number; analyses: Map<string, number> };
type Proof = Map<string, Source>;

/** Field-sensitive symbolic provenance, not a text/intent compiler. The caller
 * independently validates schemas, exact original request metadata, lexical
 * ownership, role/capability contracts, windows, recipients and unresolved gates.
 * A rendered merge value alone is never report coverage or analysed content. */
export function inspectRecurringJoinProvenance(blueprint: WorkflowBlueprint, reports: readonly Report[], deliveries: readonly Delivery[],
  resources: readonly RecurringRequestedResource[], analysisRequested: boolean) {
  const issues: string[] = [], mappings: RecurringAnalysisMapping[] = [];
  const root = parseReadControlFlow(blueprint.metadata!.controlFlow).root, conditions = controlNodes(root);
  const logic = new RecurringPathLogic(conditions.map(node => node.id)), available = new Map<string, number>();
  const merges = new Map(conditions.filter(node => node.merge).map(node => [node.id, node]));
  let visits = 0;
  const visit = (block: ReadSequence, entered: number, depth: number): number => {
    if (depth > 8) throw new Error("Recurring provenance exceeds eight nested scopes");
    let active = entered;
    for (const node of block.nodes) {
      if (++visits > 2000) throw new Error("Recurring provenance exceeds its structural visit budget");
      if (node.kind === "action") available.set(node.nodeId, active);
      else if (node.kind === "return") active = 0;
      else if (node.kind === "if") {
        const choice = logic.variable(node.id), yes = visit(node.then, logic.and(active, choice), depth + 1), no = visit(node.else, logic.and(active, logic.not(choice)), depth + 1);
        active = logic.or(yes, no); if (node.merge) available.set(node.id, active);
      } else throw new Error("Recurring provenance does not support collections");
    }
    return active;
  };
  visit(root, 1, 0);
  const byReport = new Map(reports.map(report => [report.id, report])), steps = new Map(blueprint.steps.map((step, index) => [step.id, { step, index }]));
  const combine = (proofs: readonly Proof[], guard = 1): Proof => {
    const combined: Proof = new Map();
    for (const proof of proofs) for (const [id, source] of proof) {
      const value = combined.get(id) ?? { raw: 0, analyses: new Map<string, number>() };
      value.raw = logic.or(value.raw, logic.and(guard, source.raw));
      for (const [analysisId, evidence] of source.analyses) value.analyses.set(analysisId, logic.or(value.analyses.get(analysisId) ?? 0, logic.and(guard, evidence)));
      combined.set(id, value);
    }
    return combined;
  };
  const memo = new Map<string, Proof>(), resolving = new Set<string>(), modelInputs = new Map<string, Proof>();
  let sourceVisits = 0;
  const binding = (value: ReadBinding, path: readonly string[] = []): Proof => {
    if (++sourceVisits > 20_000) throw new Error("Recurring provenance exceeds its source-resolution budget");
    if (value.kind === "ref") return value.source === "nodeOutput" && value.nodeId ? reference(value.nodeId, [...value.path, ...path]) : new Map();
    if (value.kind === "object") return path.length ? value.fields[path[0]!] ? binding(value.fields[path[0]!]!, path.slice(1)) : new Map() : combine(Object.values(value.fields).map(item => binding(item)));
    if (value.kind === "array") return path.length ? /^\d+$/.test(path[0]!) && value.items[Number(path[0])] ? binding(value.items[Number(path[0])]!, path.slice(1)) : new Map() : combine(value.items.map(item => binding(item)));
    if (value.kind === "template" && !path.length) return combine(value.parts.filter(part => typeof part !== "string").map(part => binding(part)));
    return new Map();
  };
  const reference = (id: string, path: readonly string[]): Proof => {
    const key = JSON.stringify([id, path]), saved = memo.get(key); if (saved) return saved;
    if (resolving.has(key) || resolving.size > 32) throw new Error("Recurring provenance has cyclic or over-deep sources");
    resolving.add(key); let result: Proof = new Map();
    const guard = available.get(id) ?? 0, merge = merges.get(id), model = steps.get(id);
    if (byReport.has(id) && path[0] === "structuredContent") result.set(id, { raw: guard, analyses: new Map() });
    else if (merge && path[0] === "value") {
      const choice = logic.variable(id);
      result = combine([combine([binding(merge.merge!.then, path.slice(1))], choice), combine([binding(merge.merge!.else, path.slice(1))], logic.not(choice))], guard);
    } else if (model && effectiveStepKind(model.step) === "analysis" && path[0] === "structuredContent") {
      const input = modelInput(model.step.id);
      for (const [reportId, source] of input) result.set(reportId, { raw: 0, analyses: new Map([[id, logic.and(guard, source.raw)]]) });
    }
    resolving.delete(key); memo.set(key, result); return result;
  };
  const modelInput = (id: string): Proof => {
    const saved = modelInputs.get(id); if (saved) return saved;
    const model = steps.get(id)!, parsed = modelInputSchema.safeParse(model.step.input), active = available.get(id) ?? 0;
    const inputs = parsed.success ? (typeof parsed.data === "string" ? [parsed.data] : Object.values(parsed.data)).map(exactOutputReference) : [];
    const proofs = inputs.map(input => input ? reference(input.root, input.path) : new Map<string, Source>());
    for (const proof of proofs) {
      const raw = [...proof.values()].reduce((value, source) => logic.or(value, source.raw), 0);
      if (!logic.implies(active, raw) || [...proof.values()].some(source => [...source.analyses.values()].some(value => logic.and(active, value) !== 0)))
        issues.push("Analysis " + id + " must consume declared confirmed report content on every continuing path, not literals or another analysis");
    }
    if (!inputs.length) issues.push("Analysis " + id + " has no exact report source");
    const result = combine(proofs, active); modelInputs.set(id, result); return result;
  };
  const analyses = blueprint.steps.filter(step => effectiveStepKind(step) === "analysis");
  if (analyses.length && !analysisRequested) issues.push("Analysis was added without a requested analysis outcome");
  const analysisGuards = new Map<RecurringRequestedResource, Map<string, number>>();
  for (const model of analyses) for (const [reportId, source] of modelInput(model.id)) {
    const report = byReport.get(reportId)!; if (source.raw === 0) continue;
    mappings.push({ index: steps.get(model.id)!.index, id: model.id, sourceStepId: reportId, resource: report.resource });
    const byId = analysisGuards.get(report.resource) ?? new Map<string, number>();
    for (const [otherId, guard] of byId) if (otherId !== model.id && logic.and(guard, source.raw) !== 0)
      issues.push("Requested resource " + report.resource + " has duplicate analysis nodes on a possible path");
    byId.set(model.id, logic.or(byId.get(model.id) ?? 0, source.raw)); analysisGuards.set(report.resource, byId);
  }
  const histories = scheduledReportHistories(root, new Set(byReport.keys()), new Set(deliveries.map(delivery => delivery.id)));
  let deliveryBodyBound = deliveries.length > 0, analysisBound = analysisRequested && deliveries.length > 0, relatedMatched = true, relationName: string | undefined;
  for (const delivery of deliveries) {
    const history = histories.get(delivery.id); if (!history) throw new Error("Recurring delivery has no reachable report history");
    const evidence = compileScheduledReportEvidence(history, ids => {
      const selected = ids.map(id => byReport.get(id)!);
      if (selected.length > 2 || resources.some(resource => selected.filter(report => report.resource === resource).length !== 1))
        issues.push("Delivery " + delivery.id + " requires exactly one preceding in-scope report for each requested resource on every continuing path");
      if (resources.includes("invoices") && resources.includes("orders")) {
        const primary = selected.find(report => report.resource === "invoices"), related = selected.find(report => report.resource === "orders");
        const projected = primary?.tool.report_coverage_contract?.key_projection, requested = related?.tool.report_coverage_contract?.requested_key_coverage;
        if (!projected || !requested || requested.relation_name !== projected.relation_name ||
            related!.parameters[requested.keys_parameter] !== "{{" + primary!.id + ".structuredContent." + projected.keys_path.join(".") + "}}" ||
            relationName && relationName !== requested.relation_name) relatedMatched = false;
        else relationName = requested.relation_name;
      }
      return selected;
    });
    const required = new Map<string, number>(), active = available.get(delivery.id) ?? 0;
    const collect = (current: ScheduledReportEvidence<Report>, guard: number) => {
      if (++sourceVisits > 20_000) throw new Error("Recurring provenance exceeds its source-resolution budget");
      if (current.kind === "reports") for (const report of current.reports) required.set(report.id, logic.or(required.get(report.id) ?? 0, guard));
      else {
        const choice = logic.variable(current.conditionId);
        if (current.then) collect(current.then, logic.and(guard, choice));
        if (current.else) collect(current.else, logic.and(guard, logic.not(choice)));
      }
    };
    collect(evidence, active);
    const body = deliveryOutputReferences(delivery.parameters[delivery.tool.email_delivery_contract!.body_parameter]);
    const proofs = body?.map(ref => reference(ref.root, ref.path)) ?? [];
    if (!body?.length || proofs.some(proof => !logic.implies(active, [...proof.values()].reduce((value, source) =>
      logic.or(value, [...source.analyses.values()].reduce((any, analysed) => logic.or(any, analysed), source.raw)), 0)))) deliveryBodyBound = false;
    const included = combine(proofs);
    for (const [id, guard] of required) {
      const source = included.get(id), analysed = [...(source?.analyses.values() ?? [])].reduce((value, part) => logic.or(value, part), 0);
      if (!logic.implies(guard, logic.or(source?.raw ?? 0, analysed))) deliveryBodyBound = false;
      if (!logic.implies(guard, analysed)) analysisBound = false;
    }
  }
  const relatedRecords: RecurringAutomationComposition["relatedRecords"] = !(resources.includes("invoices") && resources.includes("orders")) ? { status: "NOT_REQUESTED" } :
    relatedMatched && relationName ? { status: "MATCHED", relationName } : { status: "UNRESOLVED" };
  return { issues, analysis: { mappings, issues: [] as string[], bound: analysisBound }, deliveryBodyBound, relatedRecords };
}
