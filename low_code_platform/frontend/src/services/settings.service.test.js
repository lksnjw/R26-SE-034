/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { settingsService } from "./settings.service";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; localStorage.clear(); });

// Capture the adapter boundary after real Axios request transforms/interceptors.
// No HTTP method or transform is mocked, and no network request is made.
test.each([["activateProvider", "activate"], ["testProvider", "test"]])("%s sends actual JSON object bytes and an encoded provider ID", async (action, suffix) => {
  const adapter = jest.fn(async config => ({ status: 200, statusText: "OK", headers: {}, config,
    data: { success: true, data: { id: "selected", ok: true } } }));
  apiClient.defaults.adapter = adapter;
  const result = await settingsService[action]("provider /?#é");
  expect(adapter).toHaveBeenCalledTimes(1);
  const config = adapter.mock.calls[0][0];
  expect(config.method).toBe("post");
  expect(config.url).toBe(`/providers/${encodeURIComponent("provider /?#é")}/${suffix}`);
  expect(config.data).toBe("{}");
  expect(Array.from(new TextEncoder().encode(config.data))).toEqual([123, 125]);
  expect(config.headers.get("Content-Type")).toBe("application/json");
  expect(result).toEqual({ id: "selected", ok: true });
});
