import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { isSecretField } from "../redact/secrets.js";
import type { ToolDefinition } from "../registry/schemas.js";

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; required?: unknown; items?: unknown; writeOnly?: unknown };
type CoverageContract = NonNullable<ToolDefinition["report_coverage_contract"]>;

export type ReportCoverageReceipt = {
  profile: "schedule-report-coverage/v1";
  nodeId: string;
  toolId: string;
  contractHash: string;
  argumentHash: string;
  outputHash: string;
  startAt: string;
  endAt: string;
  itemCount: number;
  confirmedAt: string;
};

function schemaAt(root: unknown, path: readonly string[]): JsonSchema | undefined {
  let value = root as JsonSchema | undefined;
  for (const part of path) value = value?.type === "object" ? value.properties?.[part] : undefined;
  return value;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const part of path) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function requiredStringParameter(tool: ToolDefinition, name: string): boolean {
  const schema = tool.input_schema as JsonSchema;
  return schema.type === "object" && schema.properties?.[name]?.type === "string" && schema.properties[name]?.writeOnly !== true &&
    Array.isArray(schema.required) && schema.required.includes(name) && !isSecretField(name);
}

/** Validates a local contract at capability-review time. A connector may do
 * its own bounded pagination internally, but the application does not infer
 * that behavior from a `page` input or an arbitrary result shape. */
export function assertReportCoverageContract(tool: ToolDefinition): void {
  const contract = tool.report_coverage_contract;
  if (!contract) return;
  if (!tool.is_read_only || !tool.bridge_contract?.output_schema || !requiredStringParameter(tool, contract.start_parameter) ||
      !requiredStringParameter(tool, contract.end_parameter)) throw new Error("Report coverage requires distinct required non-sensitive string window parameters on a read tool");
  const output = tool.bridge_contract.output_schema;
  const selections: Array<[readonly string[], string]> = [
    [contract.covered_start_path, "string"], [contract.covered_end_path, "string"], [contract.complete_path, "boolean"],
    [contract.has_more_path, "boolean"], [contract.items_path, "array"], [contract.item_count_path, "integer"],
  ];
  if (selections.some(([path, type]) => path.some(isSecretField) || schemaAt(output, path)?.type !== type))
    throw new Error("Report coverage selectors must identify declared non-sensitive output fields of the required types");
}

export function reportCoverageParameters(tool: ToolDefinition): { start: string; end: string } | null {
  assertReportCoverageContract(tool);
  const contract = tool.report_coverage_contract;
  return contract ? { start: contract.start_parameter, end: contract.end_parameter } : null;
}

function confirmation(tool: ToolDefinition, args: Record<string, unknown>, output: Record<string, unknown>, startAt: string, endAt: string) {
  assertReportCoverageContract(tool);
  const contract = tool.report_coverage_contract as CoverageContract;
  if (output.isError === true || args[contract.start_parameter] !== startAt || args[contract.end_parameter] !== endAt)
    throw new Error("The report read did not use the exact scheduled window");
  const body = output.structuredContent;
  const coveredStart = valueAt(body, contract.covered_start_path), coveredEnd = valueAt(body, contract.covered_end_path);
  const complete = valueAt(body, contract.complete_path), hasMore = valueAt(body, contract.has_more_path);
  const items = valueAt(body, contract.items_path), itemCount = valueAt(body, contract.item_count_path);
  if (coveredStart !== startAt || coveredEnd !== endAt || complete !== true || hasMore !== false || !Array.isArray(items) ||
      !Number.isSafeInteger(itemCount) || itemCount !== items.length || items.length > 100_000)
    throw new Error("The ERP report result did not attest complete bounded coverage of the exact scheduled window");
  return { itemCount: itemCount as number };
}

export function confirmScheduledReportCoverage(input: { tool: ToolDefinition; nodeId: string; contractHash: string; args: Record<string, unknown>;
  output: Record<string, unknown>; startAt: string; endAt: string; confirmedAt?: string }): ReportCoverageReceipt {
  const result = confirmation(input.tool, input.args, input.output, input.startAt, input.endAt);
  return { profile: "schedule-report-coverage/v1", nodeId: input.nodeId, toolId: input.tool.tool_id, contractHash: input.contractHash,
    argumentHash: resolvedParameterHashBytes(canonicalJSONBytes(input.args)), outputHash: resolvedParameterHashBytes(canonicalJSONBytes(input.output)),
    startAt: input.startAt, endAt: input.endAt, itemCount: result.itemCount, confirmedAt: input.confirmedAt ?? new Date().toISOString() };
}

export function assertScheduledReportCoverageReceipt(receipt: ReportCoverageReceipt | undefined, input: { tool: ToolDefinition; nodeId: string;
  contractHash: string; args: Record<string, unknown>; output: Record<string, unknown>; startAt: string; endAt: string }): void {
  if (!receipt || receipt.profile !== "schedule-report-coverage/v1") throw new Error("Scheduled delivery requires confirmed report coverage before an effect");
  const fresh = confirmScheduledReportCoverage({ ...input, confirmedAt: receipt.confirmedAt });
  if (canonicalJSONBytes(receipt).compare(canonicalJSONBytes(fresh)) !== 0) throw new Error("Scheduled report coverage evidence changed before the effect");
}
