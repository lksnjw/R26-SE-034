import type { ReadRunProgress } from "../repository/store.js";
import type { ReadSequence } from "../workflows/read-control-flow.js";

/** Persistent structural history: a merge carries alternative report evidence,
 * not its displayed value. Shared prefixes remain shared; no boolean product. */
type ReportHistory = { kind: "empty" } | { kind: "report"; nodeId: string; previous: ReportHistory } |
  { kind: "choice"; conditionId: string; then: ReportHistory | null; else: ReportHistory | null };
export type ScheduledReportEvidence<T> = { kind: "reports"; reports: T[] } |
  { kind: "choice"; conditionId: string; then: ScheduledReportEvidence<T> | null; else: ScheduledReportEvidence<T> | null };

/** Caller must first validate structure/reachability and immutable capabilities.
 * Branch locals cross a calendar join only through an explicit typed merge. */
export function scheduledReportHistories(root: ReadSequence, reportIds: ReadonlySet<string>, effectIds: ReadonlySet<string>) {
  const result = new Map<string, ReportHistory>(), empty: ReportHistory = { kind: "empty" };
  let visits = 0;
  const visit = (block: ReadSequence, incoming: ReportHistory, depth: number): ReportHistory | null => {
    if (depth > 8) throw new Error("Calendar report history exceeds eight nested scopes");
    let history: ReportHistory | null = incoming;
    for (const node of block.nodes) {
      if (++visits > 2000) throw new Error("Calendar report history exceeds its structural visit budget");
      if (!history) throw new Error("Calendar work is unreachable after Return");
      if (node.kind === "action") {
        if (effectIds.has(node.nodeId)) result.set(node.nodeId, history);
        if (reportIds.has(node.nodeId)) history = { kind: "report", nodeId: node.nodeId, previous: history };
      } else if (node.kind === "return") history = null;
      else if (node.kind === "if") {
        const yes = visit(node.then, history, depth + 1), no = visit(node.else, history, depth + 1);
        if (!yes && !no) history = null;
        else if (node.merge) history = yes === no ? yes : { kind: "choice", conditionId: node.id, then: yes, else: no };
        // A decision without a merge retains only common outer evidence.
      } else throw new Error("Calendar report history does not support collections");
    }
    return history;
  };
  visit(root, empty, 0);
  return result;
}

/** Universally validate every continuing alternative. Memoization is by shared
 * history plus at most two following reports, not by combinations of choices.
 * The bounded report profile rejects a third report before expanding a prefix. */
export function compileScheduledReportEvidence<T>(history: ReportHistory, validate: (nodeIds: readonly string[]) => T[]): ScheduledReportEvidence<T> {
  const cache = new Map<ReportHistory, Map<string, ScheduledReportEvidence<T>>>();
  let visits = 0;
  const resolve = (current: ReportHistory, following: readonly string[]): ScheduledReportEvidence<T> => {
    const key = JSON.stringify(following), saved = cache.get(current)?.get(key);
    if (saved) return saved;
    if (++visits > 20_000) throw new Error("Calendar report alternatives exceed the evidence budget");
    let result: ScheduledReportEvidence<T>;
    if (current.kind === "empty") result = { kind: "reports", reports: validate(following) };
    else if (current.kind === "report") {
      if (following.length >= 2) throw new Error("Calendar report paths exceed the single/related-pair coverage profile");
      result = resolve(current.previous, [current.nodeId, ...following]);
    } else result = { kind: "choice", conditionId: current.conditionId,
      then: current.then ? resolve(current.then, following) : null,
      else: current.else ? resolve(current.else, following) : null };
    const entries = cache.get(current) ?? new Map(); entries.set(key, result); cache.set(current, entries);
    return result;
  };
  return resolve(history, []);
}

/** Denial-only selection from already acknowledged Decision/merge receipts.
 * The worker still validates the whole pinned control transition and each exact
 * complete report receipt. No value, approval, predicate or authority is created. */
export function selectScheduledReportEvidence<T>(evidence: ScheduledReportEvidence<T>, progress: Pick<ReadRunProgress, "decisions" | "values">): T[] {
  let current = evidence, visits = 0;
  while (current.kind === "choice") {
    if (++visits > 100) throw new Error("Calendar selected report evidence exceeds its decision bound");
    const decision = progress.decisions?.[current.conditionId], merge = progress.values?.[current.conditionId];
    if (decision?.status !== "DONE" || !["then", "else"].includes(decision.selected ?? "") || merge?.kind !== "merge" || merge.status !== "DONE")
      throw new Error("Calendar report join has no acknowledged selected Decision/merge evidence");
    const next = current[decision.selected as "then" | "else"];
    if (!next) throw new Error("A terminated calendar branch cannot reach a later effect");
    current = next;
  }
  return current.reports;
}
