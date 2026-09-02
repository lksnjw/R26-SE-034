import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { chatService } from "./chat.service";

afterEach(() => jest.restoreAllMocks());

test("asynchronous admission forwards stable identity with a short acknowledgement timeout", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: { operation: { id: "job" } } } });
  await chatService.sendMessage("chat", "Read invoices", { delivery: "async-chat", idempotencyKey: "stable-identity-00001", model: "model-a" });
  expect(post).toHaveBeenCalledWith("/chat/sessions/chat/messages", { content: "Read invoices", delivery: "async-chat", idempotencyKey: "stable-identity-00001", model: "model-a" }, { timeout: 30000 });
});

test("progress reads carry the cursor and abort signal; cancellation uses its separate endpoint", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { data: {} } });
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: {} } }); const signal = new AbortController().signal;
  await chatService.operation("job", 4, { signal }); await chatService.cancelOperation("job");
  expect(get).toHaveBeenCalledWith("/chat/operations/job", { params: { after: 4 }, signal }); expect(post).toHaveBeenCalledWith("/chat/operations/job/cancel", {});
});

test("draft edits forward their revision-bound command without asserting delivery", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: { answer: "Not sent" } } });
  const command = { draftId: "draft", baseVersion: 1, baseHash: "sha256:fixture", commandId: "one", patch: { to: "a@example.test", subject: "Report", body: "Draft" } };
  await chatService.sendMessage("chat-1", "Save email draft changes", { emailDraftCommand: command });
  expect(post.mock.calls[0][1]).toEqual({ content: "Save email draft changes", emailDraftCommand: command });
});

test("sendMessage no longer sends the previously ignored workflowId option", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({
    data: { data: { answer: "ok" } },
  });

  await chatService.sendMessage("chat-1", "hello", {
    mode: "guided",
    model: "test-model",
    workflowId: "wf-ignored",
  });

  expect(post).toHaveBeenCalledWith(
    "/chat/sessions/chat-1/messages",
    {
      content: "hello",
      mode: "guided",
      model: "test-model",
    },
    { timeout: 300000 },
  );
});
