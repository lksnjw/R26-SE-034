import { expect, test } from "@jest/globals";
import { createAppConfig, validateEndpoint } from "./endpoints";

test("local development retains same-origin API and ws routing", () => {
  expect(createAppConfig({ DEV: true }, "http://localhost:5173")).toMatchObject({ apiBaseUrl: "/api", wsBaseUrl: "ws://localhost:5173/ws", pipelineUploadEnabled: false });
  expect(createAppConfig({ DEV: true }, "http://127.0.0.1:5173")).toMatchObject({ apiBaseUrl: "/api", wsBaseUrl: "ws://127.0.0.1:5173/ws", pipelineUploadEnabled: false });
});
test("a separate HTTPS backend supplies the default event origin, not static Hosting", () => {
  expect(createAppConfig({ VITE_API_BASE_URL: "https://backend.example.test/api/", MODE: "hosting" }, "https://site.web.app")).toMatchObject({ apiBaseUrl: "https://backend.example.test/api", wsBaseUrl: "wss://backend.example.test/ws", pipelineUploadEnabled: false });
});
test("explicit event binding and HTTPS same-origin deployments are preserved", () => {
  expect(createAppConfig({ VITE_WS_BASE_URL: "wss://events.example.test/edge/ws/" }, "https://site.web.app").wsBaseUrl).toBe("wss://events.example.test/edge/ws");
  expect(createAppConfig({}, "https://site.web.app").apiBaseUrl).toBe("/api");
  expect(createAppConfig({ DEV: true, MODE: "development" }).pipelineUploadEnabled).toBe(false);
});
test.each(["", "//other.test/api", "https://user:secret@backend.test/api", "https://backend.test/api?token=private", "https://backend.test/api#token", "http://backend.test/api", "javascript:alert(1)", "https://*.test/api", "https://backend.test/a\\pi", " https://backend.test/api", "data:text/plain,test"])("invalid/private API binding fails without printing its value: %s", endpoint => {
  expect(() => validateEndpoint(endpoint, { kind: "API", origin: "https://site.web.app", allowRelative: true })).toThrow("Invalid API endpoint");
});
test.each(["https://backend.test/ws", "ws://backend.test/ws", "wss://user:secret@backend.test/ws", "/ws", "wss://backend.test/ws?token=private"])("invalid event binding fails: %s", endpoint => {
  expect(() => createAppConfig({ VITE_WS_BASE_URL: endpoint })).toThrow("Invalid WebSocket endpoint");
});
