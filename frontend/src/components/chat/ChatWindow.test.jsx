/** @jest-environment jsdom */
import React from "react";
import { expect, jest, test, afterEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
jest.unstable_mockModule("./ChatMessage", () => ({ default: () => null }));
const loadModels = jest.fn().mockResolvedValue({ configured: true, binding: { model: "model-a" }, models: ["model-a", "model-b"] });
jest.unstable_mockModule("../../services/chat.service", () => ({ chatService: { models: loadModels } }));
jest.unstable_mockModule("../../utils/workflowCanvas.utils", () => ({ peekWorkflowForChatEdit: () => null, clearWorkflowForChatEdit: () => {} }));
const { default: ChatWindow } = await import("./ChatWindow");
afterEach(() => { cleanup(); sessionStorage.clear(); });

test("keeps unsent draft across leaving and returning to workspace", () => {
  const view = render(<ChatWindow messages={[]} draftStorageKey="draft.account.session" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft report" } });
  view.unmount();
  render(<ChatWindow messages={[]} draftStorageKey="draft.account.session" />);
  expect(screen.getByRole("textbox").value).toBe("Draft report");
  expect(screen.queryByText("Ready")).toBeNull();
});

test("failed request keeps draft and successful send clears it", async () => {
  const onSend = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ assistantMessage: {} });
  render(<ChatWindow messages={[]} onSend={onSend} draftStorageKey="draft.account.session" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Report" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("textbox").value).toBe("Report");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getByRole("textbox").value).toBe(""));
  expect(sessionStorage.getItem("draft.account.session")).toBe("");
});

test("session model restores and applies to selected-node chat; unavailable selection is not silently replaced", async () => {
  const onSend = jest.fn().mockResolvedValue({});
  render(<ChatWindow messages={[]} savedModel="model-b" nodeContext={{ nodeId: "read", label: "Read", version: 1 }} onSend={onSend} draftStorageKey="account.chat" />);
  const picker = await screen.findByRole("combobox", { name: "Requested model" });
  await waitFor(() => expect(picker.value).toBe("model-b"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edit read" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("Edit read", { model: "model-b" }));
  cleanup();
  render(<ChatWindow messages={[]} savedModel="removed-model" draftStorageKey="other.chat" />);
  await screen.findByText("removed-model · unavailable");
  expect(screen.getByRole("combobox").value).toBe("removed-model");
});

test("catalog errors are visible and retry does not discard the draft", async () => {
  loadModels.mockRejectedValueOnce(new Error("Forbidden"));
  render(<ChatWindow messages={[]} draftStorageKey="account.error" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this" } });
  await screen.findByText(/Could not load configured models/);
  fireEvent.click(screen.getByRole("button", { name: "Reload models" }));
  await screen.findByRole("combobox", { name: "Requested model" });
  expect(screen.getByRole("textbox").value).toBe("Keep this");
});

test("catalog refresh does not overwrite an unsent model choice with the last server selection", async () => {
  render(<ChatWindow messages={[]} savedModel="model-a" draftStorageKey="account.choice" />);
  const picker = await screen.findByRole("combobox", { name: "Requested model" });
  await waitFor(() => expect(picker.value).toBe("model-a"));
  fireEvent.change(picker, { target: { value: "model-b" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh configured models" }));
  await waitFor(() => expect(picker.value).toBe("model-b"));
});
