import { expect, test } from "vitest";
import { initialState, type RepositoryState } from "../src/repository/store.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { recordKey } from "../src/storage/execution-record-layout.js";

function fixture() {
  const state = initialState();
  state.chats.chat = { id: "chat", ownerId: "owner", title: "Saved conversation", createdAt: "now", updatedAt: "now", messageCount: 3, messages: [{ answer: false }, { answer: 0 }, { answer: null }] };
  state.versions.workflow = [{ version: 1 }, { version: 2 }];
  state.chatOperationEvents.operation = [{ version: 1, operationId: "operation", sessionId: "chat", sequence: 1, timestamp: "now", stage: "ANSWERED", type: "done" }];
  state.settings.private = { secret: "preserved but not a public projection" }; state.importHistory = [{ id: "import" }];
  state.governancePolicy = null; state.auditLogs = [{ id: "audit" }]; return state;
}
test("all domains round-trip; messages, versions, events and histories have separate ordered records", () => {
  const state = fixture(), records = splitFirestoreState(state), before = structuredClone(records);
  expect(assembleFirestoreState(records)).toEqual(state); expect(records).toEqual(before);
  expect(records.some(record => record.path[0] === "root")).toBe(false);
  expect(records.find(record => recordKey(record.path) === recordKey(["domain", "chats", "chat"]))!.value).toMatchObject({ messages: [] });
  expect(records.filter(record => record.path[0] === "chat-message")).toHaveLength(3);
  expect(records.filter(record => record.path[0] === "workflow-version")).toHaveLength(2);
  expect(records.filter(record => record.path[0] === "chat-operation-event")).toHaveLength(1);
});
test.each(["missing-index", "missing-message", "orphan-message", "missing-version", "missing-event", "missing-domain", "hidden-message", "extra-record", "duplicate", "bad-length", "bad-position", "bad-kind", "extra-path", "missing-audit"])("damaged %s layout fails closed", damage => {
  let records = structuredClone(splitFirestoreState(fixture()));
  if (damage === "missing-index") records = records.filter(record => record.path[0] !== "domain-index");
  if (damage === "missing-message") records = records.filter(record => record.path[0] !== "chat-message" || record.path[2] !== "1");
  if (damage === "orphan-message") records.push({ profile: "runtime-record/v1", path: ["chat-message", "missing", "0"], value: false });
  if (damage === "missing-version") records = records.filter(record => record.path[0] !== "workflow-version" || record.path[2] !== "0");
  if (damage === "missing-event") records = records.filter(record => record.path[0] !== "chat-operation-event");
  if (damage === "missing-domain") records = records.filter(record => recordKey(record.path) !== recordKey(["domain", "counter"]));
  if (damage === "hidden-message") (records.find(record => recordKey(record.path) === recordKey(["domain", "chats", "chat"]))!.value as any).messages.push({ hidden: true });
  if (damage === "extra-record") records.push({ profile: "runtime-record/v1", path: ["unknown"], value: false });
  if (damage === "duplicate") records.push(records[0]!);
  if (damage === "bad-length") records.find(record => record.path[0] === "chat-messages")!.value = 1_000_001;
  if (damage === "bad-position") records.find(record => record.path[0] === "chat-message")!.path[2] = "00";
  if (damage === "bad-kind") (records.find(record => record.path[0] === "domain-index")!.value as any).chats = "unknown";
  if (damage === "extra-path") records.find(record => record.path[0] === "domain-index")!.path.push("hidden");
  if (damage === "missing-audit") records = records.filter(record => record.path[0] !== "audit-entry");
  expect(() => assembleFirestoreState(records)).toThrow();
});
test("prototype-like keys and path separators preserve identity without prototype mutation", () => {
  const state = fixture(); Object.defineProperty(state, "__proto__", { value: { harmless: false }, enumerable: true });
  state.settings = JSON.parse('{"__proto__":null,"constructor":false,"a/b":0}');
  Object.defineProperty(state.chats, "__proto__", { value: { ...state.chats.chat, id: "__proto__" }, enumerable: true });
  expect(assembleFirestoreState(splitFirestoreState(state))).toEqual(state);
  expect(Object.prototype).not.toHaveProperty("harmless");
});
test("empty arrays and records remain explicit; malformed legacy chat shapes require migration", () => {
  const state = initialState(); expect(assembleFirestoreState(splitFirestoreState(state))).toEqual(state);
  (state as unknown as RepositoryState).chats.invalid = { id: "invalid", messages: null } as any;
  expect(() => splitFirestoreState(state)).toThrow("Firestore chat has no ordered messages");
});
test("chat document identity cannot be substituted for a different chat", () => {
  const state = fixture(); state.chats.chat!.id = "other";
  expect(() => splitFirestoreState(state)).toThrow("Firestore chat identity differs from its key");
});
