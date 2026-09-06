import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { RepositoryState } from "../repository/store.js";
import { splitRuntimeState, assembleRuntimeState, recordKey, executionRecordScope, type RuntimeRecord } from "./execution-record-layout.js";

type Kind = "map" | "array" | "scalar";
const cell = (path: string[], value: unknown): RuntimeRecord => ({ profile: "runtime-record/v1", path, value });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Firestore domain object");
  return value as Record<string, unknown>;
};
const put = (target: Record<string, unknown>, key: string, value: unknown) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
const position = (value: string) => {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= 1_000_000) throw new Error("Invalid Firestore array position");
  return Number(value);
};
const arrayLength = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) throw new Error("Invalid Firestore array length");
  return Number(value);
};
const executionSections = new Set(["executions", "readJobs", "readContinuations", "timelines", "executionLogs", "executionEvents", "attempts", "receipts", "outputs", "values", "timeline-entry", "log-entry", "event-entry"]);
/** Domain/chat/version records can share a run's ID without belonging to it.
 * Only known runtime sections participate in scoped checkpoint replacement. */
export function firestoreExecutionRecordScope(record: RuntimeRecord): string | null {
  return executionSections.has(record.path[0]!) ? executionRecordScope(record) : null;
}

/** Normalize every repository domain, not only run evidence. Chat messages,
 * versions and top-level histories do not grow inside a shared root document.
 * Logical paths are private; the physical store hashes their addresses. */
export function splitFirestoreState(state: RepositoryState): RuntimeRecord[] {
  const runtime = splitRuntimeState(state), root = object(runtime.find(record => record.path[0] === "root")!.value);
  const records = runtime.filter(record => record.path[0] !== "root"), kinds: Record<string, Kind> = {};
  for (const [field, value] of Object.entries(root)) {
    const kind: Kind = Array.isArray(value) ? "array" : value && typeof value === "object" ? "map" : "scalar";
    put(kinds, field, kind);
    if (kind === "scalar") records.push(cell(["domain", field], value));
    else if (kind === "array") {
      const values = value as unknown[]; arrayLength(values.length); records.push(cell(["domain", field], values.length));
      values.forEach((entry, index) => records.push(cell(["domain-item", field, String(index)], entry)));
    } else for (const [id, entry] of Object.entries(object(value))) {
      if (field === "chats") {
        const chat = object(entry); if (chat.id !== id) throw new Error("Firestore chat identity differs from its key");
        if (!Array.isArray(chat.messages)) throw new Error("Firestore chat has no ordered messages");
        arrayLength(chat.messages.length); records.push(cell(["domain", field, id], { ...chat, messages: [] }), cell(["chat-messages", id], chat.messages.length));
        chat.messages.forEach((message, index) => records.push(cell(["chat-message", id, String(index)], message)));
      } else if (field === "versions" || field === "chatOperationEvents") {
        if (!Array.isArray(entry)) throw new Error("Firestore workflow versions are not ordered");
        arrayLength(entry.length); records.push(cell(["domain", field, id], entry.length));
        entry.forEach((version, index) => records.push(cell([field === "versions" ? "workflow-version" : "chat-operation-event", id, String(index)], version)));
      } else records.push(cell(["domain", field, id], entry));
    }
  }
  records.push(cell(["domain-index"], kinds)); return records;
}

export function assembleFirestoreState(input: Iterable<RuntimeRecord>): RepositoryState {
  const records = [...input], cells = new Map<string, RuntimeRecord>();
  for (const record of records) {
    if (record.profile !== "runtime-record/v1" || !Array.isArray(record.path) || !record.path.length || record.path.some(part => typeof part !== "string" || part.length > 4096)) throw new Error("Invalid Firestore logical record");
    const key = recordKey(record.path); if (cells.has(key)) throw new Error("Duplicate Firestore logical record"); cells.set(key, record);
  }
  const descriptor = cells.get(recordKey(["domain-index"])); if (!descriptor) throw new Error("Firestore domain index is missing");
  const kinds = object(descriptor.value), root: Record<string, unknown> = {}, arrays = new Map<string, { values: unknown[]; length: number; written: Set<number> }>();
  const makeArray = (key: string, length: unknown, owner: Record<string, unknown>, field: string) => {
    const values: unknown[] = []; arrays.set(key, { values, length: arrayLength(length), written: new Set() }); put(owner, field, values);
  };
  for (const [field, kind] of Object.entries(kinds)) {
    if (kind === "map") put(root, field, {});
    else {
      const value = cells.get(recordKey(["domain", field])); if (!value) throw new Error("Firestore declared domain is missing");
      if (kind === "scalar") put(root, field, value.value);
      else if (kind === "array") makeArray(recordKey(["domain", field]), value.value, root, field);
      else throw new Error("Invalid Firestore domain kind");
    }
  }
  for (const { path, value } of records) if (path[0] === "domain" && path.length === 3) {
    const [, field, id] = path; if (!Object.hasOwn(kinds, field!) || kinds[field!] !== "map") throw new Error("Orphan Firestore domain entry");
    const owner = object(root[field!]);
    if (field === "versions" || field === "chatOperationEvents") makeArray(recordKey(["domain", field, id!]), value, owner, id!);
    else {
      put(owner, id!, structuredClone(value));
      if (field === "chats") {
        const count = cells.get(recordKey(["chat-messages", id!])); if (!count) throw new Error("Firestore message length is missing");
        const chat = object(owner[id!]); if (!Array.isArray(chat.messages) || chat.messages.length) throw new Error("Hidden Firestore messages in chat head");
        makeArray(recordKey(["chat-messages", id!]), count.value, chat, "messages");
      }
    }
  }
  for (const { path, value } of records) {
    let key: string | undefined;
    if (path[0] === "domain-item" && path.length === 3) key = recordKey(["domain", path[1]!]);
    if (path[0] === "chat-message" && path.length === 3) key = recordKey(["chat-messages", path[1]!]);
    if (path[0] === "workflow-version" && path.length === 3) key = recordKey(["domain", "versions", path[1]!]);
    if (path[0] === "chat-operation-event" && path.length === 3) key = recordKey(["domain", "chatOperationEvents", path[1]!]);
    if (key) {
      const array = arrays.get(key), index = position(path[2]!);
      if (!array || index >= array.length || array.written.has(index)) throw new Error("Orphan or duplicate Firestore ordered entry");
      array.values[index] = value; array.written.add(index);
    }
  }
  for (const array of arrays.values()) if (array.written.size !== array.length) throw new Error("Firestore ordered entries are incomplete");
  const domainSections = new Set(["domain-index", "domain", "domain-item", "chat-messages", "chat-message", "workflow-version", "chat-operation-event"]);
  const state = assembleRuntimeState([cell(["root"], root), ...records.filter(record => !domainSections.has(record.path[0]!))]);
  const expected = splitFirestoreState(state);
  if (expected.length !== records.length || expected.some(record => !canonicalJSONBytes(record).equals(canonicalJSONBytes(cells.get(recordKey(record.path)))))) throw new Error("Firestore logical layout is not canonical");
  return state;
}
