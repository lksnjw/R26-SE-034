import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { isSecretField } from "../redact/secrets.js";
import type { ToolDefinition } from "../registry/schemas.js";

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; required?: unknown; items?: unknown; writeOnly?: unknown; maxItems?: unknown };
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
  pagination?: { profile: "report-page-evidence/v1"; firstPage: number; lastPage: number; pageCount: number;
    pages: Array<{ page: number; argumentHash: string; outputHash: string; itemCount: number; hasMore: boolean; confirmedAt: string }> };
};
export type ReportPageEvidence = NonNullable<ReportCoverageReceipt["pagination"]>["pages"][number];
export type ReportPageProgress = { profile: "schedule-report-pages/v1"; nodeId: string; toolId: string; contractHash: string; startAt: string; endAt: string;
  firstPage: number; nextPage: number; maxPages: number; items: unknown[]; pages: ReportPageEvidence[]; lastOutput?: Record<string, unknown> };

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
function optionalIntegerParameter(tool: ToolDefinition, name: string): boolean {
  const schema = tool.input_schema as JsonSchema;
  return schema.type === "object" && schema.properties?.[name]?.type === "integer" && schema.properties[name]?.writeOnly !== true &&
    (!Array.isArray(schema.required) || !schema.required.includes(name)) && !tool.required_parameters.includes(name) && !isSecretField(name);
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
  if (contract.pagination && (!optionalIntegerParameter(tool, contract.pagination.page_parameter) || contract.pagination.page_path.some(isSecretField) ||
      schemaAt(output, contract.pagination.page_path)?.type !== "integer" || !Number.isInteger(schemaAt(output, contract.items_path)?.maxItems) ||
      Number(schemaAt(output, contract.items_path)?.maxItems) < contract.pagination.max_items))
    throw new Error("Report pagination requires one optional non-sensitive integer input and one declared integer output selector");
}

export function reportCoverageParameters(tool: ToolDefinition): { start: string; end: string } | null {
  assertReportCoverageContract(tool);
  const contract = tool.report_coverage_contract;
  return contract ? { start: contract.start_parameter, end: contract.end_parameter } : null;
}

export function reportPagination(tool: ToolDefinition): CoverageContract["pagination"] | null {
  assertReportCoverageContract(tool);
  return tool.report_coverage_contract?.pagination ?? null;
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
  output: Record<string, unknown>; startAt: string; endAt: string; confirmedAt?: string; pagination?: ReportCoverageReceipt["pagination"] }): ReportCoverageReceipt {
  const result = confirmation(input.tool, input.args, input.output, input.startAt, input.endAt);
  if (input.pagination) {
    const configured = reportPagination(input.tool), pages = input.pagination.pages;
    if (!configured || input.pagination.profile !== "report-page-evidence/v1" || pages.length < 1 || pages.length > configured.max_pages ||
        input.pagination.pageCount !== pages.length || input.pagination.firstPage !== configured.first_page ||
        input.pagination.lastPage !== configured.first_page + pages.length - 1 ||
        pages.some((page, index) => page.page !== configured.first_page + index || page.itemCount < 0 || page.hasMore !== (index < pages.length - 1) ||
          !/^sha256:[a-f0-9]{64}$/.test(page.argumentHash) || !/^sha256:[a-f0-9]{64}$/.test(page.outputHash) || !Number.isFinite(Date.parse(page.confirmedAt))) ||
        pages.reduce((sum, page) => sum + page.itemCount, 0) !== result.itemCount)
      throw new Error("Paginated report evidence is incomplete or inconsistent");
  } else if (reportPagination(input.tool)) throw new Error("Application-owned report pagination evidence is required");
  return { profile: "schedule-report-coverage/v1", nodeId: input.nodeId, toolId: input.tool.tool_id, contractHash: input.contractHash,
    argumentHash: resolvedParameterHashBytes(canonicalJSONBytes(input.args)), outputHash: resolvedParameterHashBytes(canonicalJSONBytes(input.output)),
    startAt: input.startAt, endAt: input.endAt, itemCount: result.itemCount, confirmedAt: input.confirmedAt ?? new Date().toISOString(),
    ...(input.pagination ? { pagination: structuredClone(input.pagination) } : {}) };
}

export function assertScheduledReportCoverageReceipt(receipt: ReportCoverageReceipt | undefined, input: { tool: ToolDefinition; nodeId: string;
  contractHash: string; args: Record<string, unknown>; output: Record<string, unknown>; startAt: string; endAt: string }): void {
  if (!receipt || receipt.profile !== "schedule-report-coverage/v1") throw new Error("Scheduled delivery requires confirmed report coverage before an effect");
  const fresh = confirmScheduledReportCoverage({ ...input, confirmedAt: receipt.confirmedAt, ...(receipt.pagination ? { pagination: receipt.pagination } : {}) });
  if (canonicalJSONBytes(receipt).compare(canonicalJSONBytes(fresh)) !== 0) throw new Error("Scheduled report coverage evidence changed before the effect");
}

export function newReportPageProgress(tool: ToolDefinition, nodeId: string, contractHash: string, startAt: string, endAt: string): ReportPageProgress {
  const pagination = reportPagination(tool);
  if (!pagination) throw new Error("This report contract has no application-owned pagination profile");
  return { profile: "schedule-report-pages/v1", nodeId, toolId: tool.tool_id, contractHash, startAt, endAt, firstPage: pagination.first_page,
    nextPage: pagination.first_page, maxPages: pagination.max_pages, items: [], pages: [] };
}

export function assertReportPageProgress(tool: ToolDefinition, progress: ReportPageProgress): void {
  const pagination = reportPagination(tool), pages = progress.pages;
  if (!pagination || progress.profile !== "schedule-report-pages/v1" || progress.toolId !== tool.tool_id || progress.firstPage !== pagination.first_page ||
      progress.maxPages !== pagination.max_pages || pages.length >= pagination.max_pages || progress.nextPage !== pagination.first_page + pages.length ||
      progress.items.length > pagination.max_items || canonicalJSONBytes(progress.items).length > 2_000_000 ||
      pages.some((page, index) => page.page !== pagination.first_page + index || page.hasMore !== true || page.itemCount < 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(page.argumentHash) || !/^sha256:[a-f0-9]{64}$/.test(page.outputHash) || !Number.isFinite(Date.parse(page.confirmedAt))) ||
      pages.reduce((sum, page) => sum + page.itemCount, 0) !== progress.items.length || Boolean(progress.lastOutput) !== Boolean(pages.length) ||
      progress.lastOutput && resolvedParameterHashBytes(canonicalJSONBytes(progress.lastOutput)) !== pages.at(-1)!.outputHash)
    throw new Error("Stored report page progress is inconsistent");
}

export function confirmScheduledReportPage(input: { tool: ToolDefinition; args: Record<string, unknown>; output: Record<string, unknown>; startAt: string;
  endAt: string; page: number; confirmedAt?: string }): { items: unknown[]; hasMore: boolean; evidence: ReportPageEvidence } {
  assertReportCoverageContract(input.tool);
  const contract = input.tool.report_coverage_contract!, pagination = contract.pagination;
  if (!pagination || input.args[pagination.page_parameter] !== input.page) throw new Error("The report page did not use the server-owned page number");
  if (input.output.isError === true) throw new Error("The ERP report page returned an error");
  const body = input.output.structuredContent, coveredStart = valueAt(body, contract.covered_start_path), coveredEnd = valueAt(body, contract.covered_end_path);
  const complete = valueAt(body, contract.complete_path), hasMore = valueAt(body, contract.has_more_path), pageValue = valueAt(body, pagination.page_path);
  const items = valueAt(body, contract.items_path), count = valueAt(body, contract.item_count_path);
  if (coveredStart !== input.startAt || coveredEnd !== input.endAt || pageValue !== input.page || typeof hasMore !== "boolean" || complete !== !hasMore ||
      !Array.isArray(items) || !Number.isSafeInteger(count) || count !== items.length || items.length > pagination.max_items)
    throw new Error("The ERP report page did not attest its exact page, interval, completeness and item count");
  return { items: structuredClone(items), hasMore, evidence: { page: input.page,
    argumentHash: resolvedParameterHashBytes(canonicalJSONBytes(input.args)), outputHash: resolvedParameterHashBytes(canonicalJSONBytes(input.output)),
    itemCount: count as number, hasMore, confirmedAt: input.confirmedAt ?? new Date().toISOString() } };
}

function setAt(root: unknown, path: readonly string[], value: unknown): void {
  let parent = root as Record<string, unknown>;
  for (const part of path.slice(0, -1)) {
    const child = parent[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("Report output selector parent is missing");
    parent = child as Record<string, unknown>;
  }
  parent[path.at(-1)!] = value;
}

export function completePaginatedReport(tool: ToolDefinition, progress: ReportPageProgress): { output: Record<string, unknown>; receiptPagination: NonNullable<ReportCoverageReceipt["pagination"]> } {
  const contract = tool.report_coverage_contract!, pagination = reportPagination(tool);
  if (!pagination || !progress.lastOutput || !progress.pages.length || progress.pages.at(-1)!.hasMore || progress.nextPage !== progress.pages.at(-1)!.page + 1)
    throw new Error("Paginated report is not complete");
  const output = structuredClone(progress.lastOutput);
  setAt(output.structuredContent, contract.items_path, structuredClone(progress.items)); setAt(output.structuredContent, contract.item_count_path, progress.items.length);
  setAt(output.structuredContent, contract.complete_path, true); setAt(output.structuredContent, contract.has_more_path, false);
  const lastPage = progress.pages.at(-1)!.page; setAt(output.structuredContent, pagination.page_path, lastPage);
  return { output, receiptPagination: { profile: "report-page-evidence/v1", firstPage: progress.firstPage, lastPage,
    pageCount: progress.pages.length, pages: structuredClone(progress.pages) } };
}
