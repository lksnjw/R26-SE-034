/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const sendMessage = jest.fn();
const useAuth = jest.fn(() => ({ user: { id: "owner" } }));
jest.unstable_mockModule("../../services/chat.service", () => ({ chatService: { sendMessage } }));
jest.unstable_mockModule("../../hooks/useAuth", () => ({ useAuth }));
const { default: EmailDraftPreview } = await import("./EmailDraftPreview");
const draft = { profile: "email-draft-v1", id: "draft-1", sessionId: "chat-1", ownerId: "owner", version: 1, contentHash: "sha256:" + "a".repeat(64),
  to: "manager@example.test", subject: "Invoice report", body: "Confirmed fixture report for review.", state: "DRAFT_NOT_SENT", reportStatus: "PREPARED_FOR_REVIEW", recurring: false,
  sourceEvidence: [{ toolName: "read", outputDigest: "sha256:fixture", index: 0 }], requirements: ["Confirm sharing permission before sending."] };
afterEach(() => { cleanup(); sendMessage.mockReset(); useAuth.mockReturnValue({ user: { id: "owner" } }); });

test("readable recipient/subject/body and not-sent state never offer Send or raw JSON", () => {
  render(<EmailDraftPreview draft={draft} />);
  expect(screen.getByLabelText("Recipient email").value).toBe("manager@example.test");
  expect(screen.getByLabelText("Message draft").value).toBe(draft.body);
  expect(screen.getByText("Not sent · revision 1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^send/i })).toBeNull();
  expect(screen.queryByText(/sha256:/)).toBeNull();
  fireEvent.click(screen.getByText("Before sending · 1 confirmed reads"));
  expect(screen.getByText("Confirm sharing permission before sending.")).toBeTruthy();
});
test("a confirmed save updates revision, retains not-sent state, and carries only a bound edit", async () => {
  const saved = { ...draft, version: 2, body: "Reviewed facts", reportStatus: "USER_EDITED" };
  sendMessage.mockResolvedValue({ assistantMessage: { artifacts: { emailDraft: saved } } });
  render(<EmailDraftPreview draft={draft} />);
  fireEvent.change(screen.getByLabelText("Message draft"), { target: { value: "Reviewed facts" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Draft changes saved. Nothing sent or approved."));
  expect(screen.getByText("Not sent · revision 2")).toBeTruthy();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0][0]).toBe("chat-1");
  expect(sendMessage.mock.calls[0][2].emailDraftCommand).toMatchObject({ draftId: draft.id, baseVersion: 1, baseHash: draft.contentHash, patch: { to: draft.to, subject: draft.subject, body: "Reviewed facts" } });
  expect(sendMessage.mock.calls[0][2].emailDraftCommand.commandId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
});
test.each(["conflict", "network", "server", "bad-confirmation"])("%s keeps the user's edit and locks uncertain/stale saving until reload", async (scenario) => {
  if (scenario === "bad-confirmation") sendMessage.mockResolvedValue({ assistantMessage: { artifacts: { emailDraft: { ...draft, state: "SENT", version: 2 } } } });
  else sendMessage.mockRejectedValue(scenario === "network" ? new Error("timeout") : { response: { status: scenario === "conflict" ? 409 : 503 } });
  render(<EmailDraftPreview draft={draft} />);
  fireEvent.change(screen.getByLabelText("Message draft"), { target: { value: "My unsaved changes" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Reload/));
  expect(screen.getByLabelText("Message draft").value).toBe("My unsaved changes");
  expect(screen.getByRole("button", { name: "Save draft changes" }).disabled).toBe(true);
  expect(screen.getByText("Not sent · revision 1")).toBeTruthy();
});
test("other-account viewer gets no editor actions", () => {
  useAuth.mockReturnValue({ user: { id: "other" } });
  render(<EmailDraftPreview draft={draft} />);
  expect(screen.queryByRole("button", { name: "Save draft changes" })).toBeNull(); expect(screen.getByLabelText("Recipient email").disabled).toBe(true);
});
test("superseded history is read-only even for the owner", () => {
  render(<EmailDraftPreview draft={draft} superseded />);
  expect(screen.queryByRole("button", { name: "Save draft changes" })).toBeNull();
  expect(screen.getByText(/Historical draft/)).toBeTruthy();
});
test("confirmed save followed by failed refresh is not mislabeled as failed persistence", async () => {
  sendMessage.mockResolvedValue({ assistantMessage: { artifacts: { emailDraft: { ...draft, version: 2 } } } });
  render(<EmailDraftPreview draft={draft} onSaved={async () => { throw new Error("refresh failed"); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Conversation refresh failed"));
  expect(screen.getByText("Not sent · revision 2")).toBeTruthy();
});
test("offline recurring draft explains missing reads and never implies an active schedule", () => {
  render(<EmailDraftPreview draft={{ ...draft, reportStatus: "NOT_PREPARED", body: "", recurring: true, sourceEvidence: [] }} reportReason="ERPBRIDGE_NOT_CONNECTED" />);
  expect(screen.getByText("ERPBridge is not connected. No report was retrieved.")).toBeTruthy();
  expect(screen.getByText("Report not prepared · no schedule active")).toBeTruthy();
});
