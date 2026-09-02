import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { chatService } from "./chat.service";

afterEach(() => jest.restoreAllMocks());

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
