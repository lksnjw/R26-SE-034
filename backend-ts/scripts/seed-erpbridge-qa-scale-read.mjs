// Registers a bounded large-catalog fixture on the isolated Docker ERPBridge.
// The 128 resources deliberately reuse ten safe MockERP GET endpoints while
// retaining distinct MCP identities, so discovery/policy/workflow scale is
// exercised without inventing business writes or editing ERPBridge source.
import assert from "node:assert/strict";
import { canonicalJSONBytes } from "../src/core/canonical-json.ts";
import { toolSchema } from "../src/registry/schemas.ts";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";
import { qaTenReadResources } from "./seed-erpbridge-qa-ten-read.mjs";

export const QA_SCALE_TOOL_COUNT = 128;
export const QA_SCALE_WORKFLOW_STEPS = 101;

export const qaScaleReadResources = Object.freeze(Array.from({ length: QA_SCALE_TOOL_COUNT }, (_, index) => {
  const ordinal = String(index + 1).padStart(3, "0"), base = qaTenReadResources[index % qaTenReadResources.length];
  return { id: `scale_${ordinal}`, name: `qa_scale_read_${ordinal}`, doctype: base.doctype,
    label: `Scale read ${ordinal} (${base.label})`, ordinal: index + 1 };
}));

export function qaScaleReadTool(resource) {
  return { apiVersion: "erpbridge.io/v1", kind: "MCPTool", metadata: { name: resource.name, version: "1.0.0", module: "local_qa_scale" }, spec: {
    description: { short: `LOCAL large-catalog ${resource.label}; MockERP GET only`, whenToUse: ["Isolated local catalog and workflow scale qualification"],
      whenNotToUse: ["Business execution, production qualification or cross-system compatibility claims"], examples: [] },
    annotations: { title: resource.label, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: { data: { type: "array", items: { type: "object" } } }, required: ["data"] },
    execution: { type: "http", method: "GET", endpoint: `/api/resource/${resource.doctype}` },
    security: { authType: "api-key", authHeader: "Authorization", credentialRef: "ERP_PRIMARY_KEY", credentialSource: "env", dataClass: "internal", allowedRoles: [] },
  } };
}

export function qaScaleReviewedDefinition(resource, expectedResource) {
  const expected = qaScaleReadTool(expectedResource), actual = structuredClone(resource?.spec);
  delete expected.spec.inputSchema.required; delete expected.spec.security.allowedRoles;
  expected.spec.execution.approvedOrigins = ["http://mock-erp:8081"];
  if (actual?.inputSchema?.required?.length === 0) delete actual.inputSchema.required;
  if (actual?.security?.allowedRoles?.length === 0) delete actual.security.allowedRoles;
  assert.equal(resource?.kind, expected.kind); assert.equal(resource?.apiVersion, expected.apiVersion);
  assert.equal(resource?.metadata?.name, expected.metadata.name); assert.equal(resource?.metadata?.version, "1.0.0");
  assert.match(resource?.metadata?.resourceDigest ?? "", /^[a-f0-9]{64}$/);
  assert(canonicalJSONBytes(actual).equals(canonicalJSONBytes(expected.spec)), `Remote ${expectedResource.name} contract changed`);
  return toolSchema.parse({ tool_id: `LOCAL-QA-SCALE-${String(expectedResource.ordinal).padStart(3, "0")}-READ`, name: expectedResource.name,
    display_name: expectedResource.label, module: "ERPBridge", status: "active_mcp_schema_present", connection_id: "erpbridge-default",
    mcp_tool_name: expectedResource.name, description: expected.spec.description.short, input_schema: expected.spec.inputSchema,
    required_parameters: [], allowed_roles: ["Platform Admin"], is_read_only: true, risk_level: "low", side_effects: [],
    semantic_search_keywords: ["scale", `catalog-${String(expectedResource.ordinal).padStart(3, "0")}`, expectedResource.doctype],
    semantic_search_description: `Synthetic large-catalog read number ${expectedResource.ordinal}`,
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: resource.metadata.resourceDigest,
      remote_roles: [], output_schema: expected.spec.outputSchema } });
}

async function exactResource(token, resource) {
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=${encodeURIComponent(resource.name)}&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `Could not inspect ${resource.name} (HTTP ${response.status})`); const values = await response.json();
  assert(Array.isArray(values) && values.length <= 1, `Ambiguous ${resource.name} resource`); return values[0];
}

async function registerOne(token, resource) {
  let stored = await exactResource(token, resource);
  if (!stored) {
    const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(qaScaleReadTool(resource)) });
    assert(response.ok, `Registration failed for ${resource.name} (HTTP ${response.status})`); await response.body?.cancel();
    stored = await exactResource(token, resource);
  }
  qaScaleReviewedDefinition(stored, resource);
}

export async function registerQaScaleReadTools() {
  const token = await readQaBridgeToken(), width = 1;
  for (let start = 0; start < qaScaleReadResources.length; start += width)
    await Promise.all(qaScaleReadResources.slice(start, start + width).map(resource => registerOne(token, resource)));
  console.log(`PASS: ${qaScaleReadResources.length} exact read-only large-catalog resources are registered and contract-checked; no ERP call or write was performed.`);
}

if (process.argv[1]?.endsWith("seed-erpbridge-qa-scale-read.mjs")) {
  try { assert.deepEqual(process.argv.slice(2), ["--apply"]); await registerQaScaleReadTools(); }
  catch (error) { console.error(`Scale registration failed safely: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; }
}
