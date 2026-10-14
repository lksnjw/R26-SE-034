import { expect, test } from "vitest";
import { toolSchema } from "../src/registry/schemas.js";
import { capabilityContractHash, supportedOperation } from "../src/registry/capability-admission.js";
import { assertReadErrorContract, supportedRemoteReadError } from "../src/tools/read-business-error.js";

const contract = { profile: "erpbridge-read-error/v1", remote_type: "not_found", business_error: "ERP_RESOURCE_NOT_FOUND" };
const definition = { tool_id: "read-record", name: "hr.employee", is_read_only: true, risk_level: "low", allowed_roles: ["HR Manager"],
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [] } };

test("optional reviewed error contract preserves absent legacy definitions and changes exact review identity when added", () => {
  const legacy = toolSchema.parse(definition), reviewed = toolSchema.parse({ ...definition, read_error_contract: contract });
  expect(Object.hasOwn(legacy, "read_error_contract")).toBe(false);
  expect(capabilityContractHash(toolSchema.parse(legacy))).toBe(capabilityContractHash(legacy));
  expect(capabilityContractHash(reviewed)).not.toBe(capabilityContractHash(legacy));
  expect(() => assertReadErrorContract(reviewed)).not.toThrow();
});

test.each([
  { ...contract, remote_type: "permission_denied" }, { ...contract, business_error: "ANY_FAILURE" },
  { ...contract, retry: true }, { ...contract, profile: "erpbridge-read-error/v2" },
])("unsupported mapping %j cannot become a tool definition", read_error_contract => {
  expect(toolSchema.safeParse({ ...definition, read_error_contract }).success).toBe(false);
});

test.each([
  { is_read_only: false }, { risk_level: "medium" }, { side_effects: ["Sends message"] }, { bridge_contract: undefined },
  { allowed_roles: [] }, { name: "system.read_test" }, { mcp_tool_name: "system.check_policy" },
  { name: "check_policy" }, { mcp_tool_name: "policy-gate-evaluate" }, { name: "policy-gate-assist" },
  { operation_contract: { profile: "operation-result/v1", effect_class: "write", retry_policy: "never", confirmation: { path: ["ok"], expected: true, meaning: "operation-confirmed" } } },
])("business error review rejects non-business/unsafe contract %j", changes => {
  const tool = toolSchema.parse({ ...definition, read_error_contract: contract, ...changes });
  expect(() => assertReadErrorContract(tool)).toThrow();
  expect(() => supportedOperation(tool)).toThrow();
});

test.each([
  {}, { type: "not_found" }, { type: "not_found", retryable: true }, { type: "not_found", retryable: "false" },
  { type: "not_found", retryable: false, retryAfterMs: 0 }, { type: "not_found", retryable: false, retryAfterMs: -1 },
  { type: "not_found", retryable: false, authorize: true }, { type: "permission_denied", retryable: false },
  { type: "dependency_timeout", retryable: false }, { type: "invalid_input", retryable: false }, { type: "internal", retryable: false },
  { type: "conflict", retryable: false }, { type: "rate_limit", retryable: false },
])("remote metadata %j is not a supported business-error marker", hint => {
  expect(supportedRemoteReadError({ content: [], isError: true, _meta: { "com.erpbridge/error": hint } })).toBeUndefined();
});

test("only exact returned not-found metadata qualifies; success, text, structured flags and JSON-RPC errors do not", () => {
  const _meta = { "com.erpbridge/error": { type: "not_found", retryable: false } };
  expect(supportedRemoteReadError({ content: [], isError: true, _meta })).toBe("not_found");
  for (const value of [{ content: [], _meta }, { content: [], isError: false, _meta },
    { isError: true, content: [{ type: "text", text: "not_found" }], structuredContent: { business_error: "ERP_RESOURCE_NOT_FOUND" } },
    { error: { code: -32602, data: _meta } }]) expect(supportedRemoteReadError(value)).toBeUndefined();
});
