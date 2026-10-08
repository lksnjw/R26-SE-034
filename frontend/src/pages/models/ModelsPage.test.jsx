/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationProvider, useNotifications } from "../../context/NotificationContext";
import { settingsService } from "../../services/settings.service";
import ModelsPage from "./ModelsPage";

afterEach(() => { cleanup(); jest.restoreAllMocks(); });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(<QueryClientProvider client={client}><NotificationProvider><ModelsPage /><NotificationState /></NotificationProvider></QueryClientProvider>);
}

function NotificationState() {
  const { notifications } = useNotifications();
  return <output aria-label="Notification state">{JSON.stringify(notifications)}</output>;
}

test("model administration shows and requires explicit purpose-bound model egress review", async () => {
  jest.spyOn(settingsService, "providers").mockResolvedValue([{ id: "one", name: "Reviewed provider", type: "openai_compatible",
    baseUrl: "https://models.example.test/v1", model: "model-a", egressPolicy: { runtimeAnalysisDataClasses: ["internal"], runtimeAgentDataClasses: ["internal"], interactiveDataClasses: ["restricted"] } }]);
  const create = jest.spyOn(settingsService, "createProvider").mockResolvedValue({ id: "two" });
  mount();
  expect(await screen.findByText("Runtime analysis: internal")).toBeTruthy();
  expect(screen.getByText("Runtime agent: internal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New provider" } });
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://runtime.example.test/v1" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "model-b" } });
  fireEvent.change(screen.getByPlaceholderText("Write-only credential"), { target: { value: "fixture-secret" } });
  expect(screen.getByText("https://runtime.example.test")).toBeTruthy();
  expect(screen.getByText("Interactive: restricted")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Runtime internal"));
  fireEvent.click(screen.getByLabelText("Runtime agent internal"));
  fireEvent.click(screen.getByLabelText("Interactive restricted"));
  expect(screen.getByRole("button", { name: "Save provider" }).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Confirm model egress"));
  expect(screen.getByRole("button", { name: "Save provider" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ egressPolicy: {
    approvedOrigin: "https://runtime.example.test", runtimeAnalysisDataClasses: ["internal"], runtimeAgentDataClasses: ["internal"], interactiveDataClasses: ["restricted"], confirmed: true,
  } })));
});

test("successful connection data without a message produces visible inline and notification feedback", async () => {
  jest.spyOn(settingsService, "providers").mockResolvedValue([{ id: "one", name: "Test provider", type: "openai_compatible", model: "pinned-model" }]);
  const probe = jest.spyOn(settingsService, "testProvider").mockResolvedValue({ ok: true, providerId: "one", measured: true });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(screen.getAllByText("Provider connection test succeeded.")).toHaveLength(2));
  expect(probe).toHaveBeenCalledTimes(1); expect(probe).toHaveBeenCalledWith("one");
  expect(JSON.parse(screen.getByLabelText("Notification state").textContent)[0]).toMatchObject({ message: "Provider connection test succeeded.", tone: "success" });
});

test.each([
  [{ ok: false, message: "The selected model denied the request." }, "The selected model denied the request.", "error"],
  [{ ok: true, message: "Provider replied successfully." }, "Provider replied successfully.", "success"],
  [{ ok: true, message: "   " }, "Provider connection test succeeded.", "success"],
  [{}, "Provider connection test failed.", "error"],
  [{ ok: "true" }, "Provider connection test failed.", "error"],
  [{ ok: 1 }, "Provider connection test failed.", "error"],
  [null, "Provider connection test failed.", "error"],
])("connection feedback preserves actual messages and requires boolean success: %j", async (result, message, tone) => {
  jest.spyOn(settingsService, "providers").mockResolvedValue([{ id: "one", name: "Test provider", type: "openai_compatible", model: "pinned-model" }]);
  jest.spyOn(settingsService, "testProvider").mockResolvedValue(result);
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(screen.getAllByText(message)).toHaveLength(2));
  expect(JSON.parse(screen.getByLabelText("Notification state").textContent)[0]).toMatchObject({ message, tone });
});
