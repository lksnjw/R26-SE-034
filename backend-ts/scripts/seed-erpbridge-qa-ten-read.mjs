// Registers ten explicit read-only resources on the isolated Docker MockERP
// bridge. This file is backend QA only and never edits ERPBridge source.
import assert from "node:assert/strict";
import { canonicalJSONBytes } from "../src/core/canonical-json.ts";
import { toolSchema } from "../src/registry/schemas.ts";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";

export const qaTenReadResources = Object.freeze([
  ["accounts", "list_accounts_api_resource_account_get", "Account", "Accounts"],
  ["customers", "list_customers_api_resource_customer_get", "Customer", "Customers"],
  ["employees", "list_employees_api_resource_employee_get", "Employee", "Employees"],
  ["items", "list_items_api_resource_item_get", "Item", "Items"],
  ["departments", "list_organization_departments_api_resource_department_get", "Department", "Organization Departments"],
  ["purchase_invoices", "list_purchase_invoices_api_resource_purchase_invoice_get", "Purchase Invoice", "Purchase Invoices"],
  ["purchase_orders", "list_purchase_orders_api_resource_purchase_order_get", "Purchase Order", "Purchase Orders"],
  ["sales_orders", "list_sales_orders_api_resource_sales_order_get", "Sales Order", "Sales Orders"],
  ["suppliers", "list_suppliers_api_resource_supplier_get", "Supplier", "Suppliers"],
  ["warehouses", "list_warehouses_api_resource_warehouse_get", "Warehouse", "Warehouses"],
].map(([id, name, doctype, label]) => ({ id, name, doctype, label })));

export function qaTenReadTool(resource) {
  return { apiVersion: "erpbridge.io/v1", kind: "MCPTool", metadata: { name: resource.name, version: "1.0.0", module: "local_qa_ten" }, spec: {
    description: { short: `LOCAL MockERP ${resource.label} list only; never production ERP or email`, whenToUse: ["Isolated local ten-tool read qualification"], whenNotToUse: ["Business execution or production qualification"], examples: [] },
    annotations: { title: `Local ${resource.label} read`, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: { data: { type: "array", items: { type: "object" } } }, required: ["data"] },
    execution: { type: "http", method: "GET", endpoint: `/api/resource/${resource.doctype}` },
    security: { authType: "api-key", authHeader: "Authorization", credentialRef: "ERP_PRIMARY_KEY", credentialSource: "env", dataClass: "internal", allowedRoles: [] },
  } };
}

export function qaTenReviewedDefinition(resource, expectedResource) {
  const expected = qaTenReadTool(expectedResource), actual = structuredClone(resource?.spec);
  delete expected.spec.inputSchema.required; delete expected.spec.security.allowedRoles;
  expected.spec.execution.approvedOrigins = ["http://mock-erp:8081"];
  if (actual?.inputSchema?.required?.length === 0) delete actual.inputSchema.required;
  if (actual?.security?.allowedRoles?.length === 0) delete actual.security.allowedRoles;
  assert.equal(resource?.kind, expected.kind); assert.equal(resource?.apiVersion, expected.apiVersion);
  assert.equal(resource?.metadata?.name, expected.metadata.name); assert.equal(resource?.metadata?.version, "1.0.0");
  assert.match(resource?.metadata?.resourceDigest ?? "", /^[a-f0-9]{64}$/);
  assert(canonicalJSONBytes(actual).equals(canonicalJSONBytes(expected.spec)), `Remote ${expectedResource.name} contract changed`);
  return toolSchema.parse({ tool_id: `LOCAL-QA-TEN-${expectedResource.id.toUpperCase().replaceAll("_", "-")}-READ`, name: expectedResource.name,
    display_name: `Local ${expectedResource.label} read`, module: "ERPBridge", status: "active_mcp_schema_present",
    mcp_tool_name: expectedResource.name, description: expected.spec.description.short, input_schema: expected.spec.inputSchema,
    required_parameters: [], allowed_roles: ["Platform Admin"], is_read_only: true, risk_level: "low", side_effects: [],
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: resource.metadata.resourceDigest,
      remote_roles: [], output_schema: expected.spec.outputSchema } });
}

async function exactResource(token, resource) {
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=${encodeURIComponent(resource.name)}&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `Could not inspect ${resource.name}`); const values = await response.json();
  assert(Array.isArray(values) && values.length <= 1, `Ambiguous ${resource.name} resource`); return values[0];
}

export async function registerQaTenReadTools() {
  const token = await readQaBridgeToken();
  for (const resource of qaTenReadResources) {
    let stored = await exactResource(token, resource);
    if (!stored) {
      const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(qaTenReadTool(resource)) });
      assert(response.ok, `Registration failed for ${resource.name} (HTTP ${response.status})`); await response.body?.cancel();
      stored = await exactResource(token, resource);
    }
    qaTenReviewedDefinition(stored, resource);
  }
  console.log(`PASS: ${qaTenReadResources.length} exact read-only MockERP resources are registered and contract-checked; no ERP call or write was performed.`);
}

if (process.argv[1]?.endsWith("seed-erpbridge-qa-ten-read.mjs")) {
  try { assert.deepEqual(process.argv.slice(2), ["--apply"]); await registerQaTenReadTools(); }
  catch (error) { console.error(`Ten-tool registration failed safely: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; }
}
