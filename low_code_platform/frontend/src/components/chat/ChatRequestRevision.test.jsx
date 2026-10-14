/** @jest-environment jsdom */
import React from "react";
import { test, expect, jest, afterEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ChatRequestRevision from "./ChatRequestRevision";
const source = { messageId: "old", sourceHash: `sha256:${"a".repeat(64)}`, nodeContext: null };
const message = { id: "old", role: "user", text: "Original request", revisionSource: source };
afterEach(() => { cleanup(); sessionStorage.clear(); });
test("starting/cancelling a revision has no network effect and sends only on explicit submission", async () => {
  const onRevise = jest.fn().mockResolvedValue({ operation: { id: "new" } });
  render(<ChatRequestRevision message={message} onRevise={onRevise} draftStorageKey="owner.chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Revise request" }));
  expect(screen.getByRole("textbox", { name: "Revise request" }).value).toBe("Original request");
  expect(onRevise).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Corrected request" } });
  fireEvent.click(screen.getByRole("button", { name: "Send revision" }));
  await waitFor(() => expect(onRevise).toHaveBeenCalledWith(message, "Corrected request"));
  await screen.findByRole("button", { name: "Revise request" });
  expect(sessionStorage.getItem("owner.chat.revision.old")).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Revise request" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel revision" }));
  expect(onRevise).toHaveBeenCalledTimes(1);
});
test("unacknowledged revision keeps edited text across remount and retains the exact source", async () => {
  const onRevise = jest.fn().mockResolvedValue(null), view = render(<ChatRequestRevision message={message} onRevise={onRevise} draftStorageKey="owner.chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Revise request" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this revision" } });
  fireEvent.click(screen.getByRole("button", { name: "Send revision" }));
  await screen.findByRole("alert"); expect(screen.getByRole("textbox").value).toBe("Keep this revision");
  view.unmount(); render(<ChatRequestRevision message={message} onRevise={onRevise} draftStorageKey="owner.chat" />);
  expect(screen.getByRole("textbox").value).toBe("Keep this revision");
  fireEvent.click(screen.getByRole("button", { name: "Send revision" }));
  await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(2));
  expect(onRevise.mock.calls[1][0].revisionSource).toEqual(source);
});
test("revision shows the original node scope, not a new canvas selection", () => {
  render(<ChatRequestRevision message={{ ...message, revisionSource: { ...source, nodeContext: { nodeId: "original", baseVersion: 3 } } }} onRevise={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Revise request" }));
  expect(screen.getByText(/Original node · original · draft v3/)).toBeTruthy();
  expect(screen.getByRole("textbox").maxLength).toBe(4000);
});
test("unsupported/read-only historical messages offer no revision action and active requests disable it", () => {
  const view = render(<ChatRequestRevision message={{ id: "legacy", text: "Old" }} onRevise={jest.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<ChatRequestRevision message={message} onRevise={jest.fn()} busy />);
  expect(screen.getByRole("button", { name: "Revise request" }).disabled).toBe(true);
});
