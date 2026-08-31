/** @jest-environment jsdom */
import React from "react";
import { expect, jest, test, afterEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
jest.unstable_mockModule("./ChatMessage", () => ({ default: () => null }));
jest.unstable_mockModule("../../services/settings.service", () => ({ settingsService: { providers: async () => [] } }));
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
