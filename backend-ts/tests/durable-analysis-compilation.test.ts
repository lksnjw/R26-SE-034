import { stringify } from "yaml";
import { expect, test } from "vitest";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { toolSchema } from "../src/registry/schemas.js";
import { compileOperationWorkflow, type ReadAdmissionPin } from "../src/workflows/compiled-read.js";

const role = "Platform Admin";
const read = toolSchema.parse({ tool_id: "analysis-read", name: "report.read", mcp_tool_name: "report.read", is_read_only: true, risk_level: "low",
  allowed_roles: [role], side_effects: [], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: {
    type: "object", properties: { rows: { type: "array", maxItems: 20, items: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"], additionalProperties: false } } },
    required: ["rows"], additionalProperties: false } } });
const write = toolSchema.parse({ ...read, tool_id: "analysis-write", name: "email.send", mcp_tool_name: "email.send", is_read_only: false,
  side_effects: ["Synthetic notification"], input_schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
  operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
  bridge_contract: { ...read.bridge_contract!, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } });
const pin = (tool: typeof read): ReadAdmissionPin => ({ connectionId: "erp", capabilityId: `cap-${tool.tool_id}`, revisionId: `rev-${tool.tool_id}`,
  admissionVersion: 1, contractHash: capabilityContractHash(tool) });
const pins = new Map([[read.tool_id, pin(read)], [write.tool_id, pin(write)]]);
const workflow = (analysis: Record<string, unknown>) => stringify({ name: "Durable analysis", description: "Compile one bounded structured model node.", trigger: { type: "manual" }, steps: [
  { id: "report", action: read.name, parameters: { id: "daily" } },
  { id: "summary", kind: "analysis", instruction: "Summarize totals.", input: "{{report.structuredContent.rows}}", data_class: "internal", max_input_items: 20,
    max_input_chars: 10_000, max_output_tokens: 512, output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, ...analysis },
  { id: "deliver", action: write.name, parameters: { body: "{{summary.structuredContent.text}}" } },
] });

test("operation compiler emits a v2 analysis node between pinned tool nodes", () => {
  const plan = compileOperationWorkflow(workflow({ model: "model-2026-10" }), [read, write], role, pins);
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-operation-ir/v2", compilerVersion: "operation-compiler/v2" });
  expect(plan.ir.root.nodes.map(node => [node.id, node.kind])).toEqual([["report", "action"], ["summary", "analysis"], ["deliver", "action"]]);
  expect(plan.ir.root.nodes[1]).toMatchObject({ kind: "analysis", dataClass: "internal", model: "model-2026-10", maxInputItems: 20, maxInputChars: 10_000, maxOutputTokens: 512,
    input: { kind: "ref", source: "nodeOutput", nodeId: "report", path: ["structuredContent", "rows"] } });
});

test.each([
  ["missing data class", { data_class: undefined }],
  ["missing output schema", { output_schema: undefined }],
  ["undeclared output path", { input: "{{report.structuredContent.missing}}" }],
  ["workflow input", { input: "{{input.rows}}" }],
  ["floating model", { model: "model:latest" }],
  ["unbounded items", { max_input_items: 10001 }],
  ["unbounded output", { max_output_tokens: 8193 }],
])("operation compiler rejects %s before runtime", (_label, patch) => {
  expect(() => compileOperationWorkflow(workflow(patch), [read, write], role, pins)).toThrow(/Operation compilation failed/);
});
