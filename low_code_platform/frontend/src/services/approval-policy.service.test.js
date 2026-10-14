import { afterEach, expect, jest, test } from "@jest/globals";
const get = jest.fn(), patch = jest.fn();
jest.unstable_mockModule("../config/axios", () => ({ apiClient: { get, patch } }));
const { approvalPolicyService: service, validateApprovalAdministration, validApprovalPolicy, sameApprovalPolicy } = await import("./approval-policy.service");
const policy = { profile: "runtime-approval-policy/v1", enabled: true, approverRoleIds: ["reviewer"], ttlSeconds: 300, separationOfDuties: true, revision: 1 };
const view = () => ({ profile: "runtime-approval-administration/v1", policy, revision: 1, roles: [{ id: "reviewer", name: "Independent reviewer", eligible: true }], canManage: true, memoryOnly: true, asOf: "2026-10-06T12:00:00.000Z", canExecute: false });
const envelope = data => ({ data: { success: true, data } });
afterEach(() => { get.mockReset(); patch.mockReset(); });
test("loads only the scoped policy metadata and propagates cancellation", async () => {
  get.mockResolvedValue(envelope(view())); const signal = new AbortController().signal;
  expect(await service.load(signal)).toEqual(view()); expect(get).toHaveBeenCalledWith("/settings/runtime-approval-policy", { signal }); expect(patch).not.toHaveBeenCalled();
});
test("unconfigured and ineligible selected roles remain truthful, not fake saved defaults", () => {
  expect(validateApprovalAdministration({ ...view(), policy: null, revision: 0 }).policy).toBeNull();
  expect(validateApprovalAdministration({ ...view(), roles: [{ ...view().roles[0], eligible: false }] }).roles[0].eligible).toBe(false);
});
test.each([
  value => ({ ...value, canExecute: true }), value => ({ ...value, revision: 2 }), value => ({ ...value, policy: { ...policy, separationOfDuties: false } }),
  value => ({ ...value, policy: { ...policy, ttlSeconds: 59 } }), value => ({ ...value, roles: [] }), value => ({ ...value, roles: [value.roles[0], value.roles[0]] }),
  value => ({ ...value, asOf: "unconfirmed" }), value => ({ ...value, policy: { ...policy, credentials: "forged" } }),
])("rejects incomplete or inconsistent administration response %#", change => {
  expect(() => validateApprovalAdministration(change(view()))).toThrow(/incomplete/);
});
test("saves only the protected revision-bound command and verifies exact acknowledged policy", async () => {
  const { revision: _revision, ...configuration } = policy; const command = { ...configuration, baseRevision: 1, ttlSeconds: 600 };
  patch.mockResolvedValue(envelope({ enabled: false, runtimeApprovalPolicy: { ...policy, ttlSeconds: 600, revision: 2 } }));
  expect((await service.save(command)).revision).toBe(2); expect(patch).toHaveBeenCalledWith("/settings/rbac", { runtimeApprovalPolicy: command });
});
test.each(["revision", "roles", "ttl", "enabled", "separation"])("a mismatching %s acknowledgement never becomes success", async scenario => {
  const { revision: _revision, ...configuration } = policy; const command = { ...configuration, baseRevision: 1 };
  const response = { ...policy, revision: 2 };
  if (scenario === "revision") response.revision = 3;
  if (scenario === "roles") response.approverRoleIds = ["another"];
  if (scenario === "ttl") response.ttlSeconds = 600;
  if (scenario === "enabled") response.enabled = false;
  if (scenario === "separation") response.separationOfDuties = false;
  patch.mockResolvedValue(envelope({ runtimeApprovalPolicy: response })); await expect(service.save(command)).rejects.toThrow(/acknowledgement/); expect(patch).toHaveBeenCalledTimes(1);
});
test("unsafe commands do not dispatch and policy comparison is independent of object field order", async () => {
  expect(validApprovalPolicy({ ...policy, approverRoleIds: ["reviewer", "reviewer"] })).toBeFalsy();
  await expect(service.save({ profile: "runtime-approval-policy/v1", separationOfDuties: false })).rejects.toThrow(/bounded/); expect(patch).not.toHaveBeenCalled();
  expect(sameApprovalPolicy(policy, { revision: 1, separationOfDuties: true, ttlSeconds: 300, approverRoleIds: ["reviewer"], enabled: true, profile: policy.profile })).toBe(true);
});
