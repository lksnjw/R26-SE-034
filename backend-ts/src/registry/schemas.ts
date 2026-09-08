import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../models/schemas.js";
import { operationReadbackSchema } from "./operation-readback-schema.js";

export const toolSchema = z.object({
  tool_id: z.string().default(""),
  name: z.string().default(""),
  display_name: z.string().default(""),
  erp_system: z.string().optional(),
  module: z.string().default(""),
  status: z.string().default(""),
  description: z.string().default(""),
  business_capability: z.string().default(""),
  bpi_process_alignment: z.array(z.string()).default([]),
  endpoint: z.string().default(""),
  http_method: z.string().default(""),
  mcp_tool_name: z.string().default(""),
  input_schema: jsonObjectSchema.default({}),
  // Optional additive admission record; no default changes frozen legacy hashes.
  bridge_contract: z.object({
    profile: z.literal("toolplane-v1"),
    resource_version: z.string().min(1).max(128).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/),
    resource_digest: z.string().regex(/^[a-f0-9]{64}$/),
    remote_roles: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(32).refine(roles => new Set(roles).size === roles.length),
    output_schema: jsonObjectSchema.optional(),
  }).strict().optional(),
  // Explicit local reviewed outcome contract, never inferred from a tool name
  // or MCP annotations. It does not promise upstream idempotency.
  operation_contract: z.object({
    profile: z.literal("operation-result/v1"),
    effect_class: z.enum(["write", "notification"]),
    retry_policy: z.literal("never"),
    confirmation: z.object({
      path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
      expected: z.union([z.string().min(1).max(256), z.number().finite(), z.boolean()]),
      meaning: z.enum(["operation-accepted", "operation-confirmed"]),
    }).strict(),
    readback: operationReadbackSchema.optional(),
  }).strict().optional(),
  // Optional, explicitly reviewed binding for turning an immutable chat email
  // draft into one notification operation. Parameter names are never inferred
  // from tool names, descriptions, model output or browser input.
  email_delivery_contract: z.object({
    profile: z.literal("email-delivery-input/v1"),
    recipient_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    subject_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    body_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  }).strict().refine(value => new Set([value.recipient_parameter, value.subject_parameter, value.body_parameter]).size === 3,
    "Email delivery parameters must be distinct").optional(),
  required_parameters: z.array(z.string()).default([]),
  optional_parameters: z.array(z.string()).default([]),
  allowed_roles: z.array(z.string()).default([]),
  risk_level: z.string().default(""),
  is_read_only: z.boolean(),
  side_effects: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  postconditions: z.array(z.string()).default([]),
  failure_modes: z.array(z.string()).default([]),
  validator_checks: z.array(z.string()).default([]),
  prompt_usage_guidance: z.string().default(""),
  semantic_search_keywords: z.array(z.string()).default([]),
  semantic_search_description: z.string().default(""),
  execution_notes: z.string().default(""),
  current_gaps: z.array(z.string()).default([]),
  source_file: z.string().optional(),
}).strict();
export type ToolDefinition = z.infer<typeof toolSchema>;

export const ruleConditionSchema = z.object({
  type: z.string().default(""),
  parameter: z.string().default(""),
  operator: z.string().default(""),
  value: jsonValueSchema.default(null),
}).strict();

export const ruleSchema = z.object({
  rule_id: z.string().default(""),
  rule_name: z.string().default(""),
  rule_type: z.string().default(""),
  erp_system: z.string().optional(),
  domain: z.string().default(""),
  description: z.string().default(""),
  applies_to_tools: z.array(z.string()).default([]),
  applies_to_roles: z.array(z.string()).default([]),
  condition: ruleConditionSchema.default({ type: "", parameter: "", operator: "", value: null }),
  enforcement_action: z.string().default(""),
  severity: z.string().default(""),
  validator_message: z.string().default(""),
  llm_prompt_instruction: z.string().default(""),
  healing_guidance: z.string().default(""),
  bpi_alignment: z.array(z.string()).default([]),
  audit_fields_required: z.array(z.string()).default([]),
  enabled: z.boolean().default(false),
  source_file: z.string().optional(),
}).strict();
export type RuleDefinition = z.infer<typeof ruleSchema>;

export const toolArraySchema = z.array(toolSchema);
export const ruleArraySchema = z.array(ruleSchema);
