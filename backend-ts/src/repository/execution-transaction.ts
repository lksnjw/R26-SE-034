import type { Execution, ExecutionEvent, ReadJob, RepositoryState, StoredRecord } from "./store.js";

export type ExecutionCheckpoint = {
  executionId: string; execution?: Execution; job?: ReadJob;
  timeline?: StoredRecord[]; logs?: StoredRecord[]; events?: ExecutionEvent[];
  auditStart: number; auditAppend: Record<string, unknown>[];
};

const deny = (): never => { throw new Error("Execution transaction cannot mutate unrelated state or existing audit history"); };

/** Read-only views are recursive and include descriptor access. Only the
 * selected run's copied records and newly appended audit entries are writable.
 * This is a server transaction boundary, not a client-controlled write mask. */
export function executionTransaction(state: RepositoryState, executionId: string) {
  if (typeof executionId !== "string" || !executionId.length || executionId.length > 256) throw new Error("Invalid execution transaction identity");
  const views = new WeakMap<object, object>();
  const readonly = <T>(value: T): T => {
    if (value === null || typeof value !== "object") return value;
    const existing = views.get(value); if (existing) return existing as T;
    const view = new Proxy(value, {
      get: (target, key, receiver) => readonly(Reflect.get(target, key, receiver)),
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return descriptor && "value" in descriptor ? { ...descriptor, value: readonly(descriptor.value) } : descriptor;
      },
      set: deny, deleteProperty: deny, defineProperty: deny, setPrototypeOf: deny, preventExtensions: deny,
    });
    views.set(value, view); return view;
  };
  const selected: Record<string, { present: boolean; value: unknown }> = {};
  const scopedMap = (field: "executions" | "readJobs" | "timelines" | "executionLogs" | "executionEvents") => {
    const source = state[field], present = Object.hasOwn(source, executionId), cell = selected[field] = { present, value: present ? structuredClone(source[executionId]) : undefined };
    return new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_, key) => key === executionId ? cell.value : readonly(Reflect.get(source, key)),
      has: (_, key) => key === executionId ? cell.present : Reflect.has(source, key),
      ownKeys: () => [...new Set([...Reflect.ownKeys(source).filter(key => key !== executionId), ...(cell.present ? [executionId] : [])])],
      getOwnPropertyDescriptor: (_, key) => key === executionId ? cell.present ? { configurable: true, enumerable: true, writable: true, value: cell.value } : undefined
        : Object.hasOwn(source, key) ? { configurable: true, enumerable: true, writable: false, value: readonly(Reflect.get(source, key)) } : undefined,
      set: (_, key, value) => { if (key !== executionId) deny(); cell.present = true; cell.value = value; return true; },
      deleteProperty: (_, key) => { if (key !== executionId) deny(); cell.present = false; cell.value = undefined; return true; },
      defineProperty: deny, setPrototypeOf: deny, preventExtensions: deny,
    });
  };
  const auditAppend: Record<string, unknown>[] = [], auditStart = state.auditLogs.length;
  const audits = new Proxy([] as Record<string, unknown>[], {
    get: (target, key, receiver) => {
      if (key === "length") return auditStart + auditAppend.length;
      if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) { const index = Number(key); return index < auditStart ? readonly(state.auditLogs[index]) : auditAppend[index - auditStart]; }
      return Reflect.get(target, key, receiver);
    },
    has: (_, key) => typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) < auditStart + auditAppend.length : key in [],
    ownKeys: () => [...Array.from({ length: auditStart + auditAppend.length }, (_, index) => String(index)), "length"],
    getOwnPropertyDescriptor: (_, key) => key === "length" ? { configurable: false, enumerable: false, writable: true, value: auditStart + auditAppend.length }
      : typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < auditStart + auditAppend.length
        ? { configurable: true, enumerable: true, writable: false, value: Number(key) < auditStart ? readonly(state.auditLogs[Number(key)]) : auditAppend[Number(key) - auditStart] } : undefined,
    set: (_, key, value) => {
      if (key === "length" && value === auditStart + auditAppend.length) return true;
      if (typeof key !== "string" || key !== String(auditStart + auditAppend.length)) deny();
      auditAppend.push(value); return true;
    },
    deleteProperty: deny, defineProperty: deny, setPrototypeOf: deny, preventExtensions: deny,
  });
  const writable = { executions: scopedMap("executions"), readJobs: scopedMap("readJobs"), timelines: scopedMap("timelines"), executionLogs: scopedMap("executionLogs"), executionEvents: scopedMap("executionEvents"), auditLogs: audits };
  const view = new Proxy(Object.create(null) as RepositoryState, {
    get: (_, key) => Object.hasOwn(writable, key) ? Reflect.get(writable, key) : readonly(Reflect.get(state, key)),
    has: (_, key) => Reflect.has(state, key), ownKeys: () => Reflect.ownKeys(state),
    getOwnPropertyDescriptor: (_, key) => Object.hasOwn(state, key) ? { configurable: true, enumerable: true, writable: false, value: Object.hasOwn(writable, key) ? Reflect.get(writable, key) : readonly(Reflect.get(state, key)) } : undefined,
    set: deny, deleteProperty: deny, defineProperty: deny, setPrototypeOf: deny, preventExtensions: deny,
  });
  const checkpoint = (): ExecutionCheckpoint => {
    const execution = selected.executions!;
    if (execution.present && (!execution.value || (execution.value as Execution).id !== executionId)) throw new Error("Execution transaction identity changed");
    const job = selected.readJobs!;
    if (job.present && (!job.value || (job.value as ReadJob).executionId !== executionId)) throw new Error("Execution job identity changed");
    for (const field of ["timelines", "executionLogs", "executionEvents"]) if (selected[field]!.present && !Array.isArray(selected[field]!.value)) throw new Error("Execution evidence must remain an array");
    return structuredClone({ executionId, ...(execution.present ? { execution: execution.value as Execution } : {}), ...(job.present ? { job: job.value as ReadJob } : {}),
      ...(selected.timelines!.present ? { timeline: selected.timelines!.value as StoredRecord[] } : {}), ...(selected.executionLogs!.present ? { logs: selected.executionLogs!.value as StoredRecord[] } : {}),
      ...(selected.executionEvents!.present ? { events: selected.executionEvents!.value as ExecutionEvent[] } : {}), auditStart, auditAppend });
  };
  return { view, checkpoint };
}

export function applyExecutionCheckpoint(state: RepositoryState, checkpoint: ExecutionCheckpoint): RepositoryState {
  const updated = { ...state };
  const fields = [["executions", "execution"], ["readJobs", "job"], ["timelines", "timeline"], ["executionLogs", "logs"], ["executionEvents", "events"]] as const;
  for (const [field, key] of fields) {
    const records = { ...state[field] };
    if (Object.hasOwn(checkpoint, key)) Object.defineProperty(records, checkpoint.executionId, { value: checkpoint[key], configurable: true, enumerable: true, writable: true });
    else delete records[checkpoint.executionId];
    updated[field] = records as never;
  }
  updated.auditLogs = [...state.auditLogs, ...checkpoint.auditAppend];
  return updated;
}
