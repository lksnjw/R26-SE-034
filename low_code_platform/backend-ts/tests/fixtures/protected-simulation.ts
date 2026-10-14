import { toolSchema } from "../../src/registry/schemas.js";

export const protectedSimulationRole = "Platform Admin";
export const protectedSimulationRead = toolSchema.parse({ tool_id: "protected-fixture-read", name: "hr.employee.read", mcp_tool_name: "hr.employee.read",
  is_read_only: true, risk_level: "low", allowed_roles: [protectedSimulationRole], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["admin"],
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  read_error_contract: { profile: "erpbridge-read-error/v1", remote_type: "not_found", business_error: "ERP_RESOURCE_NOT_FOUND" } });
export const fixtureSequence = (...nodes: any[]) => ({ kind: "sequence", nodes });
export const fixtureAction = (nodeId: string) => ({ kind: "action", nodeId });
export const fixtureRef = (nodeId: string, ...path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
export const fixtureOutput = (text: string) => ({ content: [], structuredContent: { text } });
export function protectedSimulationSource(): any {
  return { name: "Protected test data", description: "No real ERP, model or effect", trigger: { type: "manual" },
    steps: ["lookup", "body_next", "fallback", "after"].map(id => ({ id, action: protectedSimulationRead.name,
      parameters: { id: id === "fallback" ? "{{guard.error.code}}" : id === "after" ? "{{guard.value}}" : id } })),
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v4", root: fixtureSequence({ kind: "protect", id: "guard", onError: { code: "ERP_RESOURCE_NOT_FOUND" },
      body: fixtureSequence(fixtureAction("lookup"), fixtureAction("body_next")), handler: fixtureSequence(fixtureAction("fallback")),
      output: { schema: { type: "string" }, success: fixtureRef("body_next", "structuredContent", "text"), handled: fixtureRef("fallback", "structuredContent", "text") } },
      fixtureAction("after"), { kind: "return", id: "answer", output: { schema: { type: "string" }, value: fixtureRef("after", "structuredContent", "text") } }) } } };
}
