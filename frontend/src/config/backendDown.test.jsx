/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import axios from "axios";
import { apiClient, isServerUnavailable } from "./axios";

const originalClientAdapter = apiClient.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
let queryClient;

function renderWithAuth(children) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><AuthProvider>{children}</AuthProvider></QueryClientProvider>);
}

function networkError(config) {
  const error = new Error("Network Error");
  error.config = config;
  error.request = {};
  return Promise.reject(error);
}
function ok(config, data) {
  return Promise.resolve({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
}

afterEach(() => {
  apiClient.defaults.adapter = originalClientAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
  localStorage.clear();
  cleanup();
  queryClient?.clear();
});

const { AuthProvider, useAuthContext } = await import("../context/AuthContext");
const { default: ServerUnreachableBanner } = await import("../components/shared/ServerUnreachableBanner");

function Probe() {
  const { isAuthenticated, serverUnreachable } = useAuthContext();
  return (
    <div>
      <span data-testid="authed">{String(isAuthenticated)}</span>
      <span data-testid="unreachable">{String(serverUnreachable)}</span>
      <ServerUnreachableBanner />
    </div>
  );
}

test("a connection error keeps the session and shows the unreachable banner, not the login screen", async () => {
  localStorage.setItem("workflow.authToken", "tok");
  localStorage.setItem("workflow.refreshToken", "ref");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "usr_1", name: "Admin" }));

  apiClient.defaults.adapter = networkError;
  axios.defaults.adapter = networkError;

  renderWithAuth(<Probe />);

  await waitFor(() => expect(screen.getByTestId("unreachable").textContent).toBe("true"));

  // Tokens intact — a transport failure is not an expiry.
  expect(localStorage.getItem("workflow.authToken")).toBe("tok");
  expect(localStorage.getItem("workflow.refreshToken")).toBe("ref");
  expect(localStorage.getItem("workflow.user")).not.toBeNull();
  // Still signed in, still on the app, with a banner and a Retry action.
  expect(screen.getByTestId("authed").textContent).toBe("true");
  const banner = screen.getByTestId("server-unreachable-banner");
  expect(banner.textContent).toMatch(/server is unreachable/i);
  expect(banner.textContent).toMatch(/Retry/);
  expect(screen.queryByText(/Welcome back/i)).toBeNull();
});

test("Retry restores the screen once the backend is back, with no re-authentication", async () => {
  localStorage.setItem("workflow.authToken", "tok");
  localStorage.setItem("workflow.refreshToken", "ref");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "usr_1", name: "Admin" }));

  apiClient.defaults.adapter = networkError;
  axios.defaults.adapter = networkError;

  renderWithAuth(<Probe />);
  await waitFor(() => expect(screen.getByTestId("unreachable").textContent).toBe("true"));

  // Backend comes back.
  apiClient.defaults.adapter = (config) => ok(config, { data: { id: "usr_1", name: "Admin" } });
  fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

  await waitFor(() => expect(screen.getByTestId("unreachable").textContent).toBe("false"));
  expect(screen.getByTestId("authed").textContent).toBe("true");
  expect(screen.queryByTestId("server-unreachable-banner")).toBeNull();
  expect(localStorage.getItem("workflow.authToken")).toBe("tok");
});

function structuredServiceUnavailable(config) {
  const error = new Error("Request failed with status code 503");
  error.config = config;
  error.request = {};
  error.response = {
    data: { success: false, message: "Persistence is temporarily unavailable." },
    status: 503,
    statusText: "503",
    headers: {},
    config,
    request: {},
  };
  return Promise.reject(error);
}

test("a structured 503 response does not trigger the unreachable banner", async () => {
  apiClient.defaults.adapter = structuredServiceUnavailable;
  const unreachable = jest.fn();
  window.addEventListener("auth:unreachable", unreachable);

  await expect(apiClient.get("/workflows")).rejects.toMatchObject({ response: { status: 503 } });

  expect(unreachable).not.toHaveBeenCalled();
  window.removeEventListener("auth:unreachable", unreachable);
});

test("isServerUnavailable covers no-response failures but not HTTP responses", () => {
  expect(isServerUnavailable({ request: {}, message: "Network Error" })).toBe(true);
  expect(isServerUnavailable({ response: { status: 500 } })).toBe(false);
  expect(isServerUnavailable({ response: { status: 503 } })).toBe(false);
  expect(isServerUnavailable({ response: { status: 401 } })).toBe(false);
  expect(isServerUnavailable({ response: { status: 403 } })).toBe(false);
});

test("aborting a progress poll during navigation is not a server outage or session expiry", async () => {
  localStorage.setItem("workflow.authToken", "tok"); localStorage.setItem("workflow.refreshToken", "ref");
  const unreachable = jest.fn(), expired = jest.fn(), controller = new AbortController();
  window.addEventListener("auth:unreachable", unreachable); window.addEventListener("auth:expired", expired);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  apiClient.defaults.adapter = config => new Promise((resolve, reject) => {
    config.signal.addEventListener("abort", () => reject(new axios.CanceledError("navigation", config, {})), { once: true }); entered();
  });
  const request = apiClient.get("/executions/original/events", { signal: controller.signal });
  const rejected = expect(request).rejects.toMatchObject({ code: "ERR_CANCELED" });
  try {
    await started; controller.abort(); await rejected;
    expect(unreachable).not.toHaveBeenCalled(); expect(expired).not.toHaveBeenCalled();
    expect(localStorage.getItem("workflow.authToken")).toBe("tok"); expect(localStorage.getItem("workflow.refreshToken")).toBe("ref");
  } finally { controller.abort(); window.removeEventListener("auth:unreachable", unreachable); window.removeEventListener("auth:expired", expired); }
});

test("Axios and DOM cancellation are excluded without hiding real timeout or network failures", () => {
  expect(isServerUnavailable(new axios.CanceledError("cancelled", {}, {}))).toBe(false);
  expect(isServerUnavailable({ code: "ERR_CANCELED", request: {} })).toBe(false);
  expect(isServerUnavailable({ name: "AbortError", request: {} })).toBe(false);
  expect(isServerUnavailable({ code: "ECONNABORTED", request: {} })).toBe(true);
  expect(isServerUnavailable({ code: "ERR_NETWORK", request: {} })).toBe(true);
});
