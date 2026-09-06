/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { executionService } from "../services/execution.service";

let permissions = null;
afterEach(() => { cleanup(); permissions = null; jest.restoreAllMocks(); useExecution.mockClear(); });

const useExecution = jest.fn((executionId) => ({
  execution: {
    id: executionId,
    workflowName: "Deep-link workflow",
    status: "DONE",
    started: "2026-07-25 10:00",
    duration: "12ms",
    tokens: "0",
    cost: "$0.00",
  },
  logs: [],
  timeline: [],
  healingReport: null,
  loading: false,
  error: null,
  reload: jest.fn(),
}));

jest.unstable_mockModule("../hooks/useExecution", () => ({
  useExecution,
  default: useExecution,
}));

jest.unstable_mockModule("../hooks/usePermissions", () => ({
  default: () => ({ hasAny: required => permissions === null || required.some(key => permissions.has(key)) }),
}));

const { ProtectedScreen, protectedRouteDefinitions } = await import("./router.jsx");

test("routes.deeplink.test", async () => {
  const definition = protectedRouteDefinitions.find((route) => route.id === "executions.detail");

  render(
    <MemoryRouter initialEntries={["/executions/run-deep-link"]}>
      <Routes>
        <Route path={definition.path} element={<ProtectedScreen definition={definition} />} />
      </Routes>
    </MemoryRouter>
  );

  // Cold lazy-module transformation is not a product latency benchmark.
  expect(await screen.findByRole("heading", { name: "Deep-link workflow" }, { timeout: 5000 })).not.toBeNull();
  await waitFor(() => expect(useExecution).toHaveBeenCalledWith("run-deep-link"));
  cleanup();
});

test("review-only detail deep link redirects to scoped approval without opening the full-run hook", async () => {
  permissions = new Set(["execution:approve"]);
  const definition = protectedRouteDefinitions.find(route => route.id === "executions.detail");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const review = jest.spyOn(executionService, "getApproval").mockResolvedValue({ id: "run-review", workflowName: "Minimal review", status: "AWAITING_APPROVAL",
    runtimeApproval: { id: "review", version: 1, reviewHash: `sha256:${"a".repeat(64)}`, state: "PENDING", arguments: { recipient: "manager@example.test" }, toolName: "Fixture review", remoteToolName: "fixture.review", canDecide: true, canResume: false } });
  function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/executions/run-review"]}><Location /><Routes>
    <Route path={definition.path} element={<ProtectedScreen definition={definition} />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Review transaction" });
  expect(screen.getByText("/executions/run-review?view=approval")).toBeTruthy(); expect(review).toHaveBeenCalledWith("run-review");
  expect(useExecution).not.toHaveBeenCalled(); cleanup(); client.clear();
});
test("review-only authority does not open run history or logs", async () => {
  permissions = new Set(["execution:approve"]);
  for (const id of ["executions.history", "executions.live"]) {
    const definition = protectedRouteDefinitions.find(route => route.id === id);
    render(<ProtectedScreen definition={definition} />); await screen.findByText("Access denied"); cleanup();
  }
  expect(useExecution).not.toHaveBeenCalled();
});
