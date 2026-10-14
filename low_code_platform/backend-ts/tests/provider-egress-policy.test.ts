import { expect, test } from "vitest";
import { assertModelEgress, assertRuntimeAgentEgress, assertRuntimeAnalysisEgress, normalizeModelEgressPolicy, providerOrigin } from "../src/providers/egress-policy.js";

test("runtime analysis egress is deny-by-default and requires an exact reviewed origin and data class", () => {
  const baseURL = "https://models.example.test/v1";
  const denied = normalizeModelEgressPolicy(undefined, baseURL);
  expect(denied).toEqual({ profile: "model-egress-policy/v1", approvedOrigin: "https://models.example.test",
    runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [], interactiveDataClasses: [], reviewedAt: null, reviewedBy: null });
  expect(() => assertRuntimeAnalysisEgress(denied, baseURL, "internal")).toThrow(/not approved/);

  const allowed = normalizeModelEgressPolicy({ ...denied, runtimeAnalysisDataClasses: ["internal"], reviewedAt: "2026-10-07T00:00:00.000Z",
    reviewedBy: { id: "admin", name: "Admin" } }, baseURL);
  expect(() => assertRuntimeAnalysisEgress(allowed, baseURL, "internal")).not.toThrow();
  expect(() => assertRuntimeAnalysisEgress(allowed, baseURL, "confidential")).toThrow(/not approved/);
  expect(() => normalizeModelEgressPolicy({ ...allowed, approvedOrigin: "https://other.example.test" }, baseURL)).toThrow(/does not match/);
});

test("runtime agent egress is independently reviewed and legacy policies deny it", () => {
  const baseURL = "https://models.example.test/v1";
  const legacy = normalizeModelEgressPolicy({ profile: "model-egress-policy/v1", approvedOrigin: "https://models.example.test",
    runtimeAnalysisDataClasses: ["internal"], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-07T00:00:00.000Z",
    reviewedBy: { id: "admin", name: "Admin" } }, baseURL);
  expect(legacy.runtimeAgentDataClasses).toEqual([]);
  expect(() => assertRuntimeAgentEgress(legacy, baseURL, "internal")).toThrow(/Runtime agent traffic/);
  const allowed = normalizeModelEgressPolicy({ ...legacy, runtimeAgentDataClasses: ["internal"] }, baseURL);
  expect(() => assertRuntimeAgentEgress(allowed, baseURL, "internal")).not.toThrow();
  expect(() => assertRuntimeAgentEgress(allowed, baseURL, "restricted")).toThrow(/not approved/);
});

test("interactive model traffic is independently reviewed and legacy policies deny it", () => {
  const baseURL = "https://models.example.test/v1";
  const legacy = normalizeModelEgressPolicy({ profile: "model-egress-policy/v1", approvedOrigin: "https://models.example.test",
    runtimeAnalysisDataClasses: ["internal"], reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "admin", name: "Admin" } }, baseURL);
  expect(legacy.interactiveDataClasses).toEqual([]);
  expect(() => assertModelEgress(legacy, baseURL, { purpose: "interactive", dataClass: "restricted" })).toThrow(/Interactive model traffic/);
  const allowed = normalizeModelEgressPolicy({ ...legacy, interactiveDataClasses: ["restricted"] }, baseURL);
  expect(() => assertModelEgress(allowed, baseURL, { purpose: "interactive", dataClass: "restricted" })).not.toThrow();
  expect(() => assertModelEgress(allowed, baseURL, { purpose: "interactive", dataClass: "confidential" })).toThrow(/not approved/);
});

test("provider destinations require HTTPS except for explicit loopback development", () => {
  expect(providerOrigin("https://models.example.test/v1")).toBe("https://models.example.test");
  expect(providerOrigin("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
  expect(() => providerOrigin("http://models.example.test/v1")).toThrow(/HTTPS/);
  expect(() => providerOrigin("https://user:secret@models.example.test/v1")).toThrow(/embedded credentials/);
});
