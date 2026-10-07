/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { registryService } from "./registry.service";
import { semanticService } from "./semantic.service";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; localStorage.clear(); });

// These actions are exposed by Registry Context, Registry and Data Feed pages.
// Inspect the real Axios serialization boundary: a JSON Content-Type with no
// bytes fails before the existing Functions/Fastify route can handle an action.
test.each([
  ["regenerate registry context", () => registryService.regenerateContext(), "/registry/context/regenerate"],
  ["rebuild the semantic index", () => semanticService.rebuild(), "/semantic-index/rebuild"],
])("%s submits an explicit JSON object", async (_label, invoke, path) => {
  const adapter = jest.fn(async config => ({ status: 200, statusText: "OK", headers: {}, config,
    data: { success: true, data: { accepted: true } } }));
  apiClient.defaults.adapter = adapter;
  const result = await invoke();
  expect(adapter).toHaveBeenCalledTimes(1);
  const config = adapter.mock.calls[0][0];
  expect(config.method).toBe("post");
  expect(config.url).toBe(path);
  expect(config.headers.get("Content-Type")).toBe("application/json");
  expect(config.data).toBe("{}");
  expect(Array.from(new TextEncoder().encode(config.data))).toEqual([123, 125]);
  expect(result).toEqual({ accepted: true });
});
