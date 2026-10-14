import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const bounded = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const distinctIds = values => Array.isArray(values) && values.length >= 1 && values.length <= 20 && values.every(bounded) && new Set(values).size === values.length;
export function validApprovalPolicy(policy, command = false) {
  const keys = ["profile", "enabled", "approverRoleIds", "ttlSeconds", "separationOfDuties", command ? "baseRevision" : "revision"];
  return policy && Object.keys(policy).length === keys.length && Object.keys(policy).every(key => keys.includes(key)) && policy.profile === "runtime-approval-policy/v1" && typeof policy.enabled === "boolean" && policy.separationOfDuties === true &&
    distinctIds(policy.approverRoleIds) && Number.isSafeInteger(policy.ttlSeconds) && policy.ttlSeconds >= 60 && policy.ttlSeconds <= 86400 &&
    Number.isSafeInteger(command ? policy.baseRevision : policy.revision) && (command ? policy.baseRevision >= 0 : policy.revision >= 1);
}
export function sameApprovalPolicy(a, b) {
  return validApprovalPolicy(a) && validApprovalPolicy(b) && a.revision === b.revision && a.enabled === b.enabled && a.ttlSeconds === b.ttlSeconds &&
    JSON.stringify(a.approverRoleIds) === JSON.stringify(b.approverRoleIds);
}
export function validateApprovalAdministration(value) {
  if (value?.profile !== "runtime-approval-administration/v1" || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      (value.policy === null ? value.revision !== 0 : !validApprovalPolicy(value.policy) || value.policy.revision !== value.revision) ||
      typeof value.canManage !== "boolean" || typeof value.memoryOnly !== "boolean" || value.canExecute !== false ||
      typeof value.asOf !== "string" || !Number.isFinite(Date.parse(value.asOf)) || !Array.isArray(value.roles) || value.roles.length > 1000 ||
      new Set(value.roles.map(role => role?.id)).size !== value.roles.length || value.roles.some(role => !bounded(role?.id) || !bounded(role?.name) || typeof role.eligible !== "boolean") ||
      value.policy?.approverRoleIds.some(id => !value.roles.some(role => role.id === id)))
    throw new Error("Approval settings are incomplete. Reload before configuring a policy.");
  return value;
}
export const approvalPolicyService = {
  async load(signal) { return validateApprovalAdministration(unwrap(await apiClient.get("/settings/runtime-approval-policy", { signal }))); },
  async save(command) {
    if (!validApprovalPolicy(command, true)) throw new Error("Review an exact bounded approval policy before saving.");
    const value = unwrap(await apiClient.patch("/settings/rbac", { runtimeApprovalPolicy: command }));
    const policy = value?.runtimeApprovalPolicy;
    if (!validApprovalPolicy(policy) || policy.revision !== command.baseRevision + 1 || policy.enabled !== command.enabled ||
        policy.ttlSeconds !== command.ttlSeconds || JSON.stringify(policy.approverRoleIds) !== JSON.stringify(command.approverRoleIds))
      throw new Error("The saved policy acknowledgement does not match. Reload authoritative settings; do not resend.");
    return policy;
  },
};
