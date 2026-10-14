import { toolSchema, type ToolDefinition } from "../../src/registry/schemas.js";

/** Synthetic declared outputs only; not a claim about a deployed ERP catalog. */
export function recurringAnalysisTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool, index) => toolSchema.parse({ ...tool, bridge_contract: {
    profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: String(index + 1).repeat(64), remote_roles: [],
    output_schema: tool.is_read_only ? { type: "object", properties: {
      summary: { type: "string" }, orderIds: { type: "array", maxItems: 100, items: { type: "string" } },
    }, required: ["summary", "orderIds"], additionalProperties: false } : {
      type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false,
    },
  } }));
}

export const analysisRequirement = "Add a supported bounded analysis node or retain analysis as an unresolved requested outcome.";
export function reportAnalysis(id: string, source: string) {
  return { id, kind: "analysis", description: "Analyse this requested report", instruction: "Summarize only the confirmed report; never invent missing facts.",
    input: `{{${source}.structuredContent.summary}}`, data_class: "restricted", max_input_items: 100, max_input_chars: 10000, max_output_tokens: 512,
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } };
}
