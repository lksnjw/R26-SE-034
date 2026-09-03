/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios.js";
import { mcpConnectionService } from "./mcp-connection.service.js";
afterEach(() => jest.restoreAllMocks());
test("old/malformed lifecycle response is not readiness; arbitrary command targets are rejected", async () => {
  jest.spyOn(apiClient, "get").mockResolvedValue({ data: { data: { status: "Connected" } } });
  await expect(mcpConnectionService.status()).rejects.toThrow(/unavailable/); await expect(mcpConnectionService.command("connect", "arbitrary-url", {})).rejects.toThrow(/Unsupported/);
});
test("typed lifecycle endpoints preserve exact request identity and revision", async () => {
  const value = { connections: [{ id: "erpbridge-default", revision: 2, initialized: false, supports: {} }], recentOperations: [] };
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { data: value } }); expect(await mcpConnectionService.status()).toEqual(value); expect(get).toHaveBeenCalledWith("/settings/mcp-connections");
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: {} } }); const body = { baseRevision: 2, requestId: "fixture_request_0001" };
  await mcpConnectionService.command("disconnect", "erpbridge-default", body); expect(post).toHaveBeenCalledWith("/settings/mcp-connections/erpbridge-default/disconnect", body);
});

test("unsafe or malformed notification status cannot become a ready-looking frontend status", async () => {
  const get = jest.spyOn(apiClient, "get");
  for (const notificationStream of [{ state: "raw-private-upstream-body", recoveryAttempts: 0 }, { state: "ACTIVE", recoveryAttempts: -1 }, { state: "FAILED", reason: "raw-error", recoveryAttempts: 1 }]) {
    get.mockResolvedValue({ data: { data: { connections: [{ id: "erpbridge-default", revision: 2, initialized: false, supports: {}, notificationStream }], recentOperations: [] } } });
    await expect(mcpConnectionService.status()).rejects.toThrow(/notification status/);
  }
});
