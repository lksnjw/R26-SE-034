import { canonicalJSONBytes } from "../core/canonical-json.js";
import { assertReadContinuation, type Execution, type RepositoryState } from "../repository/store.js";
import type { ExecutionCheckpoint } from "../repository/execution-transaction.js";

export type RuntimeRecord = { profile: "runtime-record/v1"; path: string[]; value: unknown };
export const recordKey = (path: string[]) => JSON.stringify(path);
const runtimeFields = ["executions", "readJobs", "readContinuations", "timelines", "executionLogs", "executionEvents", "auditLogs"] as const;
const outputFields = [["attempts", "readProgress", "attempts"], ["receipts", "iterationProgress", "receipts"], ["outputs", null, "stepOutputs"], ["values", null, "valueOutputs"], ["runtime-approvals", "runtimeApprovalSecret", "records"], ["operation-intents", "operationSecret", "intents"]] as const;
const arrayFields = [["timelines", "timeline-entry"], ["executionLogs", "log-entry"], ["executionEvents", "event-entry"]] as const;
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid normalized runtime object"); return value as Record<string, unknown>; };
const put = (target: Record<string, unknown>, key: string, value: unknown) => Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
const index = (value: string) => { if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid normalized runtime array position"); return Number(value); };
const length = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) throw new Error("Invalid normalized runtime array length"); return value as number; };
const cell = (path: string[], value: unknown): RuntimeRecord => ({ profile: "runtime-record/v1", path, value });

function executionCells(id: string, execution: Execution): RuntimeRecord[] {
  const meta = JSON.parse(JSON.stringify(execution)) as Execution, result: RuntimeRecord[] = [];
  if (meta.id !== id) throw new Error("Normalized execution identity differs from its key");
  for (const [section, parent, field] of outputFields) {
    const owner = parent ? meta[parent] : meta;
    if (owner && Object.hasOwn(owner, field)) {
      for (const [key, value] of Object.entries(object((owner as Record<string, unknown>)[field]))) result.push(cell([section, id, key], value));
      (owner as Record<string, unknown>)[field] = {};
    }
  }
  result.push(cell(["executions", id], meta)); return result;
}
function arrayCells(field: string, entries: string, id: string, values: unknown[]): RuntimeRecord[] {
  if (!Array.isArray(values) || values.length > 1_000_000) throw new Error("Invalid normalized runtime evidence array");
  return [cell([field, id], values.length), ...values.map((value, at) => cell([entries, id, String(at)], value))];
}
export function checkpointRecords(checkpoint: ExecutionCheckpoint): RuntimeRecord[] {
  const id = checkpoint.executionId, result = checkpoint.execution ? executionCells(id, checkpoint.execution) : [];
  if (checkpoint.job) { if (checkpoint.job.executionId !== id) throw new Error("Normalized job identity differs from its key"); result.push(cell(["readJobs", id], checkpoint.job)); }
  if (checkpoint.continuation) { assertReadContinuation(checkpoint.continuation, id); if (!checkpoint.execution) throw new Error("Orphan private read continuation"); result.push(cell(["readContinuations", id], checkpoint.continuation)); }
  for (const [field, entries, property] of [["timelines", "timeline-entry", "timeline"], ["executionLogs", "log-entry", "logs"], ["executionEvents", "event-entry", "events"]] as const)
    if (Object.hasOwn(checkpoint, property)) result.push(...arrayCells(field, entries, id, checkpoint[property]!));
  if (checkpoint.auditAppend.length) {
    result.push(cell(["auditLogs"], checkpoint.auditStart + checkpoint.auditAppend.length));
    checkpoint.auditAppend.forEach((value, at) => result.push(cell(["audit-entry", String(checkpoint.auditStart + at)], value)));
  }
  return result;
}
export function splitRuntimeState(state: RepositoryState): RuntimeRecord[] {
  if (state.version !== 1) throw new Error("Unsupported normalized repository version");
  const root = { ...state } as Record<string, unknown>; runtimeFields.forEach(field => { delete root[field]; });
  const result = [cell(["root"], root), cell(["auditLogs"], state.auditLogs.length)];
  for (const [id, execution] of Object.entries(object(state.executions))) result.push(...executionCells(id, execution as Execution));
  for (const [id, job] of Object.entries(object(state.readJobs))) { if (object(job).executionId !== id) throw new Error("Normalized job identity differs from its key"); result.push(cell(["readJobs", id], job)); }
  for (const [id, record] of Object.entries(object(state.readContinuations))) { assertReadContinuation(record, id); if (!Object.hasOwn(state.executions, id)) throw new Error("Orphan private read continuation"); result.push(cell(["readContinuations", id], record)); }
  for (const [field, entries] of arrayFields) for (const [id, values] of Object.entries(object(state[field]))) result.push(...arrayCells(field, entries, id, values as unknown[]));
  state.auditLogs.forEach((value, at) => result.push(cell(["audit-entry", String(at)], value))); return result;
}

/** Decode requires all declared positions and exact parent identity. No
 * missing row, unknown section or orphan output is silently discarded. */
export function assembleRuntimeState(records: Iterable<RuntimeRecord>): RepositoryState {
  const cells = new Map<string, RuntimeRecord>();
  for (const record of records) {
    if (record.profile !== "runtime-record/v1" || !Array.isArray(record.path) || !record.path.length || record.path.some(part => typeof part !== "string" || part.length > 4096)) throw new Error("Invalid normalized runtime record");
    const key = recordKey(record.path); if (cells.has(key)) throw new Error("Duplicate normalized runtime record"); cells.set(key, record);
  }
  const rootCell = cells.get(recordKey(["root"])); if (!rootCell) throw new Error("Normalized runtime root is missing");
  const state = { ...object(rootCell.value) } as unknown as RepositoryState;
  if (state.version !== 1 || runtimeFields.some(field => Object.hasOwn(state, field))) throw new Error("Invalid normalized runtime root");
  state.executions = {}; state.readJobs = {}; state.readContinuations = {}; state.timelines = {}; state.executionLogs = {}; state.executionEvents = {}; state.auditLogs = [];
  const arrays = new Map<string, { values: unknown[]; expected: number; written: Set<number> }>();
  const addArray = (path: string[], target: Record<string, unknown> | null, id?: string) => {
    const expected = length(cells.get(recordKey(path))!.value), values: unknown[] = [];
    arrays.set(recordKey(path), { values, expected, written: new Set() });
    if (target && id !== undefined) put(target, id, values); else state.auditLogs = values as Record<string, unknown>[];
  };
  if (!cells.has(recordKey(["auditLogs"]))) throw new Error("Normalized audit length is missing"); addArray(["auditLogs"], null);
  for (const { path, value } of cells.values()) {
    if (path[0] === "executions" && path.length === 2) { if (object(value).id !== path[1]) throw new Error("Normalized execution identity changed"); put(state.executions, path[1]!, structuredClone(value)); }
    if (path[0] === "readJobs" && path.length === 2) { if (object(value).executionId !== path[1]) throw new Error("Normalized job identity changed"); put(state.readJobs, path[1]!, value); }
    if (path[0] === "readContinuations" && path.length === 2) { assertReadContinuation(value, path[1]!); put(state.readContinuations, path[1]!, value); }
    for (const [field] of arrayFields) if (path[0] === field && path.length === 2) addArray(path, state[field], path[1]);
  }
  for (const { path, value } of cells.values()) {
    const [section, id, key] = path;
    if ((section === "root" || section === "auditLogs") && path.length === 1 || ["executions", "readJobs", "readContinuations", ...arrayFields.map(([field]) => field)].includes(section!) && path.length === 2) continue;
    const output = outputFields.find(([field]) => field === section);
    if (output && path.length === 3) {
      const execution = state.executions[id!]; if (!execution) throw new Error("Orphan normalized output");
      const owner = output[1] ? execution[output[1]] : execution;
      if (!owner || !Object.hasOwn(owner, output[2])) throw new Error("Normalized output parent is missing");
      put(object((owner as Record<string, unknown>)[output[2]]), key!, value); continue;
    }
    const arrayField = arrayFields.find(([, entry]) => entry === section)?.[0];
    const array = section === "audit-entry" && path.length === 2 ? arrays.get(recordKey(["auditLogs"]))
      : arrayField && path.length === 3 ? arrays.get(recordKey([arrayField, id!])) : undefined;
    if (!array) throw new Error("Unknown or orphan normalized runtime record");
    const at = index(section === "audit-entry" ? id! : key!);
    if (at >= array.expected || array.written.has(at)) throw new Error("Normalized runtime array position is outside its declared length");
    array.values[at] = value; array.written.add(at);
  }
  for (const array of arrays.values()) if (array.written.size !== array.expected) throw new Error("Normalized runtime array has missing entries");
  // Reject hidden duplicate representations in metadata instead of letting a
  // normalized leaf silently replace an embedded output/attempt/receipt.
  const expected = splitRuntimeState(state), actual = [...cells.values()];
  if (expected.length !== actual.length || expected.some(record => !canonicalJSONBytes(record).equals(canonicalJSONBytes(cells.get(recordKey(record.path)))))) throw new Error("Normalized runtime layout is not canonical");
  return state;
}

export function executionRecordScope(record: RuntimeRecord): string | null {
  return record.path[0] === "root" || record.path[0] === "auditLogs" || record.path[0] === "audit-entry" ? null : record.path[1] ?? null;
}
