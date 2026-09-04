import { expect, test } from "vitest";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { toolSchema } from "../src/registry/schemas.js";
import { compileReadWorkflow, resolveReadBinding } from "../src/workflows/compiled-read.js";
import { stringify } from "yaml";
import type { WorkflowBlueprint } from "../src/models/schemas.js";

const role = "Platform Admin";
const output = { type: "object", properties: { count: { type: "integer" }, label: { type: "string" }, privateData: { type: "object", writeOnly: true, properties: { value: { type: "string" } } }, api_token: { type: "string" } }, required: ["count", "label"], additionalProperties: false };
const tool = toolSchema.parse({ tool_id: "READ", name: "local.read", mcp_tool_name: "exact_read", is_read_only: true, allowed_roles: [role], endpoint: "https://private.example.test", input_schema: { type: "object", properties: { count: { type: "integer", default: 999, examples: ["PRIVATE_EXAMPLE"], description: "PRIVATE_DESCRIPTION" } }, required: ["count"], additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["admin"], output_schema: output } });
const blueprint: WorkflowBlueprint = { name: "Read", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { limit: { type: "integer" }, credential: { type: "string", writeOnly: true } }, required: ["limit"], additionalProperties: false } } }, steps: [{ id: "first", action: "local.read", parameters: { count: "{{input.limit}}" } }, { id: "last", action: "exact_read", parameters: { count: "{{first.structuredContent.count}}" } }] };
const contract = (source = blueprint, tools = [tool], actorRole = role) => readAuthoringContract(source, tools, actorRole, "registry-test");

test("offline schema guidance is versioned, sanitized, role scoped and never a live readiness grant", () => {
  const value = contract();
  expect(value).toMatchObject({ profile: "read-authoring/v1", registryHash: "registry-test" });
  expect(value.nodes[0]).toMatchObject({ state: "LOCAL_CONTRACT", inputSchema: { properties: { count: { type: "integer" } } }, actions: ["local.read", "exact_read"] });
  expect(value.nodes[0]).toMatchObject({ outputSchema: { type: "object", properties: { count: { type: "integer" }, privateData: { writeOnly: true }, api_token: { writeOnly: true } } } });
  expect(JSON.stringify(value)).not.toMatch(/PRIVATE_|private.example|default|examples|description/);
  expect(contract(blueprint, [tool], "Other Role").nodes.every(node => node.state === "UNAVAILABLE" && !("inputSchema" in node) && !("outputSchema" in node))).toBe(true);
});

test("only declared workflow input and preceding structured outputs are suggested, never credential/writeOnly fields or whole sensitive objects", () => {
  const value = contract();
  expect(value.nodes[0]!.dataSources.map(source => source.expression)).toEqual(["{{input.limit}}"]);
  expect(value.nodes[1]!.dataSources.map(source => source.expression)).toEqual(["{{input.limit}}", "{{first.structuredContent.count}}", "{{first.structuredContent.label}}"]);
  expect(value.nodes.flatMap(node => node.dataSources).every(source => !source.expression.includes("last") && !/private|credential|token/.test(source.expression))).toBe(true);
});

test("suggested structured bindings round-trip through the authoritative compiler without scalar coercion", () => {
  const value = contract(), source = value.nodes[1]!.dataSources.find(item => item.schema.type === "integer" && item.binding.source === "nodeOutput")!;
  const plan = compileReadWorkflow(stringify(blueprint), [tool], role);
  expect(resolveReadBinding(source.binding, { first: { structuredContent: { count: 0 } } })).toBe(0);
  expect(plan.ir.root.nodes[1]!.inputs).toMatchObject({ kind: "object", fields: { count: source.binding } });
});

test.each([
  { ...blueprint.steps[0]!, condition: "{{input.enabled}}" },
  { id: "first", kind: "approval" },
  { ...blueprint.steps[0]!, action: "unknown" },
  { ...blueprint.steps[0]!, id: "input" },
])("unsupported predecessor scope never advertises its output as available: %j", first => {
  const value = contract({ ...blueprint, steps: [first, blueprint.steps[1]!] });
  expect(value.nodes[1]!.dataSources).toEqual([]);
});

test("unknown/ambiguous tools and unsupported schemas retain unavailable guidance rather than coercing source", () => {
  expect(contract(blueprint, [tool, tool]).nodes[0]!.state).toBe("UNAVAILABLE");
  expect(contract(blueprint, [{ ...tool, input_schema: { type: "object", oneOf: [] } }]).nodes[0]!.state).toBe("UNAVAILABLE");
  expect(blueprint.steps[0]!.parameters).toEqual({ count: "{{input.limit}}" });
});

test("arrays retain declared item types and sensitive containers propagate masking to nested fields", () => {
  const value = contract({ ...blueprint, steps: [blueprint.steps[0]!] }, [{ ...tool, input_schema: { type: "object", properties: { rows: { type: "array", items: { type: "integer" } }, api_key_data: { type: "object", properties: { value: { type: "string" } } } } } }]);
  expect(value.nodes[0]).toMatchObject({ inputSchema: { properties: { rows: { items: { type: "integer" } }, api_key_data: { writeOnly: true, properties: { value: { writeOnly: true } } } } } });
});

test("nonmanual/unknown trigger semantics have no suggested runtime data scope", () => {
  expect(contract({ ...blueprint, trigger: { type: "cron" } }).nodes.every(node => !node.dataSources.length)).toBe(true);
  expect(contract({ ...blueprint, trigger: { type: "manual", config: { unknown: true } } }).nodes.every(node => !node.dataSources.length)).toBe(true);
});

test("large and invalid schema guides are bounded without modifying the original draft", () => {
  const large = { type: "object", properties: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, { type: "string" }])) };
  const tools = [{ ...tool, input_schema: large, bridge_contract: { ...tool.bridge_contract!, output_schema: large } }];
  const source = { ...blueprint, steps: Array.from({ length: 200 }, (_, i) => ({ id: `node_${i}`, action: tool.name, parameters: {} })) };
  const before = JSON.stringify(source), result = contract(source, tools);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_000_000);
  expect(result.nodes.every(node => node.dataSources.length <= 32)).toBe(true); expect(JSON.stringify(source)).toBe(before);
  expect(contract(blueprint, [{ ...tool, input_schema: { type: "object", properties: JSON.parse('{"__proto__":{"type":"string"}}') } }]).nodes[0]!.state).toBe("UNAVAILABLE");
});
