import type { ToolDefinition } from "../registry/schemas.js";
import type { ReadAdmissionPin } from "../workflows/compiled-read.js";

export type ReviewedReadBusinessFailure = {
  profile: "reviewed-read-business-failure/v1";
  code: "ERP_RESOURCE_NOT_FOUND";
  toolId: string;
  contractHash: string;
  admissionPin: ReadAdmissionPin;
};

/** Only the raw acknowledged envelope can establish this marker. Parse before
 * informational metadata projection, which may discard malformed fields. */
export function supportedRemoteReadError(value: unknown): "not_found" | undefined {
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!record(value) || value.isError !== true || !record(value._meta)) return undefined;
  const hint = value._meta["com.erpbridge/error"];
  if (!record(hint) || hint.type !== "not_found" || hint.retryable !== false ||
      Object.keys(hint).length !== 2 || !Object.hasOwn(hint, "type") || !Object.hasOwn(hint, "retryable")) return undefined;
  return "not_found";
}

/** A reviewed mapping is limited to a low-risk business read. Write outcomes,
 * development tools and guard/policy/protocol calls cannot acquire it. */
export function assertReadErrorContract(tool: ToolDefinition): void {
  if (!tool.read_error_contract) return;
  const policyTools = new Set(["check_policy", "policy-gate-evaluate", "policy-gate-assist"]);
  if (!tool.is_read_only || tool.risk_level.toLowerCase() !== "low" || tool.side_effects.length || !tool.bridge_contract ||
      !tool.allowed_roles.length || tool.operation_contract || /^system\./i.test(tool.name) || /^system\./i.test(tool.mcp_tool_name) ||
      [tool.name, tool.mcp_tool_name].some(name => policyTools.has(name.trim().toLowerCase())))
    throw new Error("Business read-error classification requires an explicitly reviewed low-risk ERP read without effects");
}
