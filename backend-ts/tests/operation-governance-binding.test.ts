import { expect, test } from "vitest";
import { operationGovernanceBinding } from "../src/governance/service.js";
const original = { lastPrimaryPolicyVersion: "reviewed/v1", snapshot: { policyVersion: "reviewed/v1", rules: [], ruleVersion: "exact-rules",
  evidenceIds: ["reviewed-evidence"], source: "primary", fetchedAt: 1000, expiresAt: 2000 } };
test("operation policy identity preserves provenance but separates verified renewal deadline", () => {
  const renewed = { ...original, snapshot: { ...original.snapshot, fetchedAt: 1500, expiresAt: 2500 } };
  expect(operationGovernanceBinding(renewed).authority).toEqual(operationGovernanceBinding(original).authority);
  expect(operationGovernanceBinding(renewed).expiresAt).toBe(2500);
});
test.each([{ policyVersion: "other" }, { ruleVersion: "other" }, { source: "secondary" }, { evidenceIds: ["other"] }])("operation policy change remains bound %#", change => {
  expect(operationGovernanceBinding({ ...original, snapshot: { ...original.snapshot, ...change } }).authority).not.toEqual(operationGovernanceBinding(original).authority);
});
test("changed primary lineage, unknown fields, malformed state or inconsistent times never normalize away", () => {
  const expected = operationGovernanceBinding(original).authority;
  for (const value of [{ ...original, lastPrimaryPolicyVersion: "other" }, { ...original, bypass: true },
    { ...original, snapshot: { ...original.snapshot, expiresAt: 1 } }, { fixtureRevision: "other" }, null])
    expect(operationGovernanceBinding(value).authority).not.toEqual(expected);
});
