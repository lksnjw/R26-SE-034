/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios.js";
import { capabilityService } from "./capability.service.js";
afterEach(() => jest.restoreAllMocks());
test("catalog denies older/malformed backend responses instead of inventing readiness", async () => {
  jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: { observations: [], admissions: [] } } });
  await expect(capabilityService.catalog()).rejects.toThrow(/supported capability/);
});
test("catalog paging and explicit mutation bodies use the dedicated admission API", async () => {
  const data = { capabilities: [], offset: 10, limit: 10, hasMoreCapabilities: false, persistence: "memory-only", connection: { discoveryAvailable: false } };
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { data } });
  expect(await capabilityService.catalog(10)).toEqual(data); expect(get).toHaveBeenCalledWith("/registry/capabilities", { params: { offset: 10, limit: 10 } });
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: {} } });
  await capabilityService.review("cap/fixture", { decisionKey: "stable-fixture" });
  expect(post).toHaveBeenCalledWith("/registry/capabilities/cap%2Ffixture/review", { decisionKey: "stable-fixture" });
  await capabilityService.disable("cap/fixture", { baseVersion: 3 }); expect(post).toHaveBeenCalledWith("/registry/capabilities/cap%2Ffixture/disable", { baseVersion: 3 });
});
