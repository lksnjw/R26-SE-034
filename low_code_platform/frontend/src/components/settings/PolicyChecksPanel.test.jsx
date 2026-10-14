/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const update = jest.fn(), notify = jest.fn();
jest.unstable_mockModule("../../services/settings.service", () => ({ settingsService: { update } }));
jest.unstable_mockModule("../../context/NotificationContext", () => ({ useNotifications: () => ({ notify }) }));
const { default: Panel } = await import("./PolicyChecksPanel.jsx");
beforeEach(() => { update.mockReset(); notify.mockReset(); });
afterEach(cleanup);
const control = name => within(screen.getByRole("group", { name })).getByRole("switch");
test.each([
  [false, false, "Additional policy checks are off."], [true, false, "ERPBridge only."],
  [false, true, "Local JSON/model only"], [true, true, "ERPBridge first"],
])("independent mode remote=%s local=%s is readable without JSON", (enabled, localPolicyAgentEnabled, mode) => {
  const view = render(<Panel rbac={{ enabled, localPolicyAgentEnabled }} />);
  expect(control("ERPBridge policy checker")).toHaveAttribute("aria-checked", String(enabled));
  expect(control("Local JSON policy agent")).toHaveAttribute("aria-checked", String(localPolicyAgentEnabled));
  expect(screen.getByRole("status")).toHaveTextContent(mode); expect(view.container.querySelector("pre")).toBeNull();
  expect(screen.getByText(/A remote denial is never overridden/)).toBeTruthy();
});
test.each([["enabled", "ERPBridge policy checker"], ["localPolicyAgentEnabled", "Local JSON policy agent"]])("%s saves only its own flag and confirms refresh", async (field, title) => {
  update.mockResolvedValue({ rbac: { [field]: true } }); const reload = jest.fn(async () => ({}));
  render(<Panel rbac={{}} onChanged={reload} />); fireEvent.click(control(title));
  await waitFor(() => expect(notify).toHaveBeenCalledWith("Policy setting saved.", "success"));
  expect(update).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledWith({ rbac: { [field]: true } }); expect(reload).toHaveBeenCalledTimes(1);
});
test("pending save disables both switches and does not optimistically show on", async () => {
  let finish; update.mockImplementation(() => new Promise(resolve => { finish = resolve; })); render(<Panel rbac={{}} />);
  fireEvent.click(control("ERPBridge policy checker")); expect(control("ERPBridge policy checker")).toBeDisabled(); expect(control("Local JSON policy agent")).toBeDisabled();
  fireEvent.click(control("Local JSON policy agent")); expect(update).toHaveBeenCalledTimes(1);
  expect(control("ERPBridge policy checker")).toHaveAttribute("aria-checked", "false"); finish({ rbac: { enabled: true } });
  await waitFor(() => expect(control("ERPBridge policy checker")).not.toBeDisabled());
});
test.each(["failure", "invalid-ack", "refresh-failed"])("%s remains visible, never silently enables or retries", async kind => {
  if (kind === "failure") update.mockRejectedValue(new Error("Save failed.")); else update.mockResolvedValue(kind === "invalid-ack" ? {} : { rbac: { enabled: true } });
  render(<Panel rbac={{}} onChanged={async () => ({ error: new Error("refresh failed") })} />); fireEvent.click(control("ERPBridge policy checker"));
  await screen.findByRole("alert"); expect(control("ERPBridge policy checker")).toHaveAttribute("aria-checked", "false"); expect(update).toHaveBeenCalledTimes(1); expect(notify).not.toHaveBeenCalledWith("Policy setting saved.", "success");
});
