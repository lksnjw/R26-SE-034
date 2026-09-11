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
  const data = { capabilities: [], offset: 10, limit: 10, hasMoreCapabilities: false, persistence: "memory-only", connection: { id: "finance", discoveryAvailable: false },
    connections: [{ id: "finance", primary: true, dispatchSupported: true }, { id: "hr", primary: false, dispatchSupported: false }] };
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { data } });
  expect(await capabilityService.catalog(10, "finance")).toEqual(data); expect(get).toHaveBeenCalledWith("/registry/capabilities", { params: { offset: 10, limit: 10, connectionId: "finance" } });
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { data: {} } });
  await capabilityService.discover("finance"); expect(post).toHaveBeenCalledWith("/registry/capabilities/discovery", {}, { params: { connectionId: "finance" } });
  await capabilityService.review("cap/fixture", { decisionKey: "stable-fixture" }, "finance");
  expect(post).toHaveBeenCalledWith("/registry/capabilities/cap%2Ffixture/review", { decisionKey: "stable-fixture" }, { params: { connectionId: "finance" } });
  await capabilityService.disable("cap/fixture", { baseVersion: 3 }, "finance");
  expect(post).toHaveBeenCalledWith("/registry/capabilities/cap%2Ffixture/disable", { baseVersion: 3 }, { params: { connectionId: "finance" } });
});

test("catalog rejects cross-connection evidence and unsafe connection selectors", async () => {
  await expect(capabilityService.catalog(0, "../hr")).rejects.toThrow(/Unsupported/);
  const data = { capabilities: [{ capabilityId: "cap", effectiveState: "AVAILABLE", reviewEligible: false,
    observation: { connectionId: "hr", definition: {} } }], offset: 0, limit: 10, hasMoreCapabilities: false, persistence: "durable-single-writer",
    connection: { id: "finance", discoveryAvailable: true }, connections: [{ id: "finance", primary: true, dispatchSupported: true }] };
  jest.spyOn(apiClient, "get").mockResolvedValue({ data: { data } });
  await expect(capabilityService.catalog(0, "finance")).rejects.toThrow(/Invalid capability/);
});
