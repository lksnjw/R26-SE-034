/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationProvider } from "../../context/NotificationContext";
import { settingsService } from "../../services/settings.service";
import ModelsPage from "./ModelsPage";

afterEach(() => { cleanup(); jest.restoreAllMocks(); });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(<QueryClientProvider client={client}><NotificationProvider><ModelsPage /></NotificationProvider></QueryClientProvider>);
}

test("model administration shows and requires explicit runtime-analysis egress review", async () => {
  jest.spyOn(settingsService, "providers").mockResolvedValue([{ id: "one", name: "Reviewed provider", type: "openai_compatible",
    baseUrl: "https://models.example.test/v1", model: "model-a", egressPolicy: { runtimeAnalysisDataClasses: ["internal"] } }]);
  const create = jest.spyOn(settingsService, "createProvider").mockResolvedValue({ id: "two" });
  mount();
  expect(await screen.findByText("Runtime analysis: internal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New provider" } });
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://runtime.example.test/v1" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "model-b" } });
  fireEvent.change(screen.getByPlaceholderText("Write-only credential"), { target: { value: "fixture-secret" } });
  expect(screen.getByText("https://runtime.example.test")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("internal"));
  expect(screen.getByRole("button", { name: "Save provider" }).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Confirm runtime analysis egress"));
  expect(screen.getByRole("button", { name: "Save provider" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ egressPolicy: {
    approvedOrigin: "https://runtime.example.test", runtimeAnalysisDataClasses: ["internal"], confirmed: true,
  } })));
});
