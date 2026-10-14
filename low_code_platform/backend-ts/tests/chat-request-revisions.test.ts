import { expect, test } from "vitest";
import { chatRequestSourceHash, effectiveChatContext, revisionPriorContext } from "../src/agent/chat-request-revisions.js";
import type { StoredRecord, ChatSessionRecord } from "../src/repository/store.js";

const message = (id: string, text: string, role = "user"): StoredRecord => ({ id, text, role });
const revise = (source: StoredRecord, id: string, text: string) => ({ ...message(id, text), requestRevision: { messageId: String(source.id), sourceHash: chatRequestSourceHash(source) } });
test("revisions select context before their exact source without changing saved historical answers", () => {
  const source = message("source", "Original request"), revision = revise(source, "revised", "Corrected request");
  const history = [message("before", "Earlier question"), message("before-answer", "Earlier answer", "assistant"), source,
    message("old-answer", "Historical tool result", "assistant"), message("old-followup", "Superseded follow-up"), revision, message("new-answer", "New answer", "assistant")];
  const before = structuredClone(history);
  expect(effectiveChatContext(history).map(item => item.id)).toEqual(["before", "before-answer", "revised", "new-answer"]);
  expect(history).toEqual(before);
  const chat = { messages: history } as ChatSessionRecord;
  expect(revisionPriorContext(chat, revision.requestRevision)).toEqual(["user: Earlier question", "assistant: Earlier answer"]);
});
test("revision of a revision and explicit return to an older source choose the correct branch", () => {
  const first = message("first", "First"), second = revise(first, "second", "Second"), third = revise(second, "third", "Third"), fourth = revise(first, "fourth", "Fourth");
  const history = [first, message("first-answer", "Answer one", "assistant"), second, message("second-answer", "Answer two", "assistant"), third, fourth];
  expect(effectiveChatContext(history)).toEqual([fourth]);
});
test("context remains a ten-message tail while old explicit source revisions are still available", () => {
  const history = Array.from({ length: 250 }, (_, index) => message(`request${index}`, `Text ${index}`));
  expect(effectiveChatContext(history)).toHaveLength(10);
  expect(effectiveChatContext([...history, revise(history[2]!, "revision", "New")]).map(item => item.id)).toEqual(["request0", "request1", "revision"]);
});
test.each([{ messageId: "missing", sourceHash: `sha256:${"a".repeat(64)}` }, { messageId: "missing", sourceHash: "bad" }])("missing or malformed lineage fails closed without selecting mixed history", requestRevision => {
  expect(() => effectiveChatContext([{ ...message("new", "New"), requestRevision }])).toThrow("needs repair");
});
