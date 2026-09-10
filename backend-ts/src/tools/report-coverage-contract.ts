import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { isSecretField } from "../redact/secrets.js";
import type { ToolDefinition } from "../registry/schemas.js";

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; required?: unknown; items?: JsonSchema; writeOnly?: unknown; maxItems?: unknown };
type CoverageContract = NonNullable<ToolDefinition["report_coverage_contract"]>;

export type ReportOperatorResolution = { profile: "report-page-operator-evidence/v1"; recordId: string; actorId: string; referenceHash: string; observedAt: string; recordedAt: string };
export type ReportPageEvidence = { page: number; argumentHash: string; outputHash: string; snapshotHash: string; itemCount: number; totalCount: number; hasMore: boolean; confirmedAt: string; resolution?: ReportOperatorResolution };
export type ReportCursorEvidence = { ordinal: number; cursorHash: string; nextCursorHash: string; argumentHash: string; outputHash: string; snapshotHash: string;
  itemCount: number; totalCount: number; hasMore: boolean; confirmedAt: string; resolution?: ReportOperatorResolution };
export type ReportPageReceipt = { profile: "report-page-evidence/v1"; firstPage: number; lastPage: number; pageCount: number; totalCount: number; snapshotHash: string;
  pages: ReportPageEvidence[] };
export type ReportCursorReceipt = { profile: "report-cursor-evidence/v1"; pageCount: number; totalCount: number; snapshotHash: string; initialCursorHash: string;
  pages: ReportCursorEvidence[] };
export type ReportRelatedRecordEvidence = { profile: "report-related-record-evidence/v1"; relationName: string;
  mode: "PROJECTED" | "REQUESTED_MATCHED"; keyCount: number; keysHash: string };

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
  pagination?: ReportPageReceipt | ReportCursorReceipt;
  relatedRecords?: ReportRelatedRecordEvidence;
};
export type ReportPageProgress = { profile: "schedule-report-pages/v1"; nodeId: string; toolId: string; contractHash: string; startAt: string; endAt: string;
  firstPage: number; nextPage: number; maxPages: number; items: unknown[]; pages: ReportPageEvidence[]; snapshotValue?: string; totalCount?: number; lastOutput?: Record<string, unknown> };
export type ReportCursorProgress = { profile: "schedule-report-cursors/v1"; nodeId: string; toolId: string; contractHash: string; startAt: string; endAt: string;
  initialCursor: string; nextCursor: string; maxPages: number; items: unknown[]; pages: ReportCursorEvidence[]; snapshotValue?: string; totalCount?: number; lastOutput?: Record<string, unknown> };
export type ReportPaginationProgress = ReportPageProgress | ReportCursorProgress;

function validResolution(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>, keys = ["profile", "recordId", "actorId", "referenceHash", "observedAt", "recordedAt"];
  return Object.keys(record).length === keys.length && Object.keys(record).every(key => keys.includes(key)) &&
    record.profile === "report-page-operator-evidence/v1" && typeof record.recordId === "string" && record.recordId.length > 0 && record.recordId.length <= 256 &&
    typeof record.actorId === "string" && record.actorId.length > 0 && record.actorId.length <= 256 &&
    typeof record.referenceHash === "string" && /^sha256:[a-f0-9]{64}$/.test(record.referenceHash) &&
    typeof record.observedAt === "string" && Number.isFinite(Date.parse(record.observedAt)) &&
    typeof record.recordedAt === "string" && Number.isFinite(Date.parse(record.recordedAt)) && Date.parse(record.observedAt) <= Date.parse(record.recordedAt) + 30_000;
}

function schemaAt(root: unknown, path: readonly string[]): JsonSchema | undefined {
  let value = root as JsonSchema | undefined;
  for (const part of path) value = value?.type === "object" ? value.properties?.[part] : undefined;
  return value;
}

function requiredSchemaAt(root: unknown, path: readonly string[]): JsonSchema | undefined {
  let value = root as JsonSchema | undefined;
  for (const part of path) {
    if (value?.type !== "object" || !Array.isArray(value.required) || !value.required.includes(part)) return undefined;
    value = value.properties?.[part];
  }
  return value;
}

function itemSchemaAt(output: unknown, itemsPath: readonly string[], keyPath: readonly string[]): JsonSchema | undefined {
  let value = requiredSchemaAt(output, itemsPath);
  if (value?.type !== "array" || !value.items) return undefined;
  value = value.items;
  for (const part of keyPath) {
    if (value?.type !== "object" || !Array.isArray(value.required) || !value.required.includes(part)) return undefined;
    value = value.properties?.[part];
  }
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
function optionalStringParameter(tool: ToolDefinition, name: string): boolean {
  const schema = tool.input_schema as JsonSchema;
  return schema.type === "object" && schema.properties?.[name]?.type === "string" && schema.properties[name]?.writeOnly !== true &&
    (!Array.isArray(schema.required) || !schema.required.includes(name)) && !tool.required_parameters.includes(name) && !isSecretField(name);
}
function requiredKeyArrayParameter(tool: ToolDefinition, name: string): JsonSchema | undefined {
  const schema = tool.input_schema as JsonSchema, value = schema.properties?.[name];
  return schema.type === "object" && Array.isArray(schema.required) && schema.required.includes(name) && !isSecretField(name) &&
    value?.type === "array" && Number.isInteger(value.maxItems) && Number(value.maxItems) >= 1 && Number(value.maxItems) <= 100_000 &&
    ["string", "integer"].includes(String(value.items?.type)) && value.writeOnly !== true ? value.items : undefined;
}

function keyToken(value: unknown, type: unknown): string {
  if (type === "string" && typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 2_048) return `s:${value}`;
  if (type === "integer" && Number.isSafeInteger(value)) return `i:${value}`;
  throw new Error("Related-record keys must be non-empty bounded strings or safe integers matching the reviewed schema");
}
function itemKeyValues(items: unknown[], path: readonly string[], type: unknown): { values: Array<string | number>; tokens: string[] } {
  const values = items.map(item => valueAt(item, path)).map(value => { keyToken(value, type); return value as string | number; });
  return { values, tokens: values.map(value => keyToken(value, type)) };
}
function uniqueTokens(values: unknown[], type: unknown, label: string): string[] {
  const tokens = values.map(value => keyToken(value, type));
  if (new Set(tokens).size !== tokens.length) throw new Error(`${label} contains duplicate related-record keys`);
  return tokens;
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(), sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function relatedEvidence(tool: ToolDefinition, args: Record<string, unknown>, body: unknown, items: unknown[], requestedSubset: boolean): ReportRelatedRecordEvidence | undefined {
  const contract = tool.report_coverage_contract!;
  if (contract.key_projection) {
    const keySchema = itemSchemaAt(tool.bridge_contract!.output_schema, contract.items_path, contract.key_projection.item_key_path)!;
    const item = itemKeyValues(items, contract.key_projection.item_key_path, keySchema.type), projected = valueAt(body, contract.key_projection.keys_path);
    if (!Array.isArray(projected)) throw new Error("The report did not return its reviewed related-key projection");
    const projectedTokens = uniqueTokens(projected, keySchema.type, "Projected key list"), expected = [...new Set(item.tokens)];
    if (!sameSet(projectedTokens, expected)) throw new Error("The report related-key projection does not cover every returned primary record");
    const sorted = [...projectedTokens].sort();
    return { profile: "report-related-record-evidence/v1", relationName: contract.key_projection.relation_name,
      mode: "PROJECTED", keyCount: sorted.length, keysHash: resolvedParameterHashBytes(canonicalJSONBytes(sorted)) };
  }
  if (contract.requested_key_coverage) {
    const inputSchema = requiredKeyArrayParameter(tool, contract.requested_key_coverage.keys_parameter)!;
    const requested = args[contract.requested_key_coverage.keys_parameter];
    if (!Array.isArray(requested)) throw new Error("The related report did not receive its reviewed requested-key list");
    const requestedTokens = uniqueTokens(requested, inputSchema.type, "Requested key list"), requestedSet = new Set(requestedTokens);
    const item = itemKeyValues(items, contract.requested_key_coverage.item_key_path, inputSchema.type);
    if (new Set(item.tokens).size !== item.tokens.length) throw new Error("The related report returned duplicate related-record keys");
    if (item.tokens.some(value => !requestedSet.has(value)) || !requestedSubset && !sameSet(item.tokens, requestedTokens))
      throw new Error(requestedSubset ? "The related report returned a record outside the requested key set" : "The related report did not return exactly the requested related-record key set");
    const sorted = [...requestedTokens].sort();
    return { profile: "report-related-record-evidence/v1", relationName: contract.requested_key_coverage.relation_name,
      mode: "REQUESTED_MATCHED", keyCount: sorted.length, keysHash: resolvedParameterHashBytes(canonicalJSONBytes(sorted)) };
  }
  return undefined;
}

/** Checks an aggregate while paginated pages are still being collected. */
export function assertReportRelatedKeyProgress(tool: ToolDefinition, args: Record<string, unknown>, items: unknown[], hasMore: boolean): void {
  if (tool.report_coverage_contract?.requested_key_coverage)
    relatedEvidence(tool, args, { structuredContent: null }, items, hasMore);
  else if (tool.report_coverage_contract?.key_projection) {
    const contract = tool.report_coverage_contract.key_projection;
    const schema = itemSchemaAt(tool.bridge_contract!.output_schema, tool.report_coverage_contract.items_path, contract.item_key_path)!;
    itemKeyValues(items, contract.item_key_path, schema.type);
  }
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
  const pagination = contract.pagination;
  if (pagination && (!Number.isInteger(schemaAt(output, contract.items_path)?.maxItems) ||
      Number(schemaAt(output, contract.items_path)?.maxItems) < pagination.max_items ||
      pagination.snapshot_path.some(isSecretField) || schemaAt(output, pagination.snapshot_path)?.type !== "string" ||
      schemaAt(output, pagination.snapshot_path)?.writeOnly === true || pagination.total_count_path.some(isSecretField) ||
      schemaAt(output, pagination.total_count_path)?.type !== "integer"))
    throw new Error("Report pagination requires declared stable-snapshot and total-count output selectors within reviewed bounds");
  if (pagination?.profile === "page-number/v1" && (!optionalIntegerParameter(tool, pagination.page_parameter) || pagination.page_path.some(isSecretField) ||
      schemaAt(output, pagination.page_path)?.type !== "integer"))
    throw new Error("Numeric report pagination requires an optional integer input and declared page output selector");
  if (pagination?.profile === "opaque-cursor/v1" && (!optionalStringParameter(tool, pagination.cursor_parameter) || pagination.cursor_path.some(isSecretField) ||
      pagination.next_cursor_path.some(isSecretField) || schemaAt(output, pagination.cursor_path)?.type !== "string" ||
      schemaAt(output, pagination.next_cursor_path)?.type !== "string"))
    throw new Error("Cursor report pagination requires an optional string input plus declared current and next cursor output selectors");
  if (contract.key_projection) {
    const projected = requiredSchemaAt(output, contract.key_projection.keys_path), itemKey = itemSchemaAt(output, contract.items_path, contract.key_projection.item_key_path);
    if (contract.key_projection.keys_path.some(isSecretField) || contract.key_projection.item_key_path.some(isSecretField) ||
        !itemKey || !["string", "integer"].includes(String(itemKey.type)) || itemKey.writeOnly === true || projected?.type !== "array" ||
        projected.writeOnly === true || projected.items?.type !== itemKey.type || !Number.isInteger(projected.maxItems) ||
        Number(projected.maxItems) < 1 || Number(projected.maxItems) > 100_000)
      throw new Error("Related-key projection requires required non-sensitive scalar item keys and one bounded required output key list of the same type");
  }
  if (contract.requested_key_coverage) {
    const requested = requiredKeyArrayParameter(tool, contract.requested_key_coverage.keys_parameter), itemKey = itemSchemaAt(output, contract.items_path, contract.requested_key_coverage.item_key_path);
    if (!requested || contract.requested_key_coverage.item_key_path.some(isSecretField) || !itemKey || itemKey.type !== requested.type || itemKey.writeOnly === true)
      throw new Error("Requested related-key coverage requires a bounded required non-sensitive key-list input and required output item keys of the same scalar type");
  }
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
  return { itemCount: itemCount as number, relatedRecords: relatedEvidence(tool, args, body, items, false) };
}

export function confirmScheduledReportCoverage(input: { tool: ToolDefinition; nodeId: string; contractHash: string; args: Record<string, unknown>;
  output: Record<string, unknown>; startAt: string; endAt: string; confirmedAt?: string; pagination?: ReportCoverageReceipt["pagination"] }): ReportCoverageReceipt {
  const result = confirmation(input.tool, input.args, input.output, input.startAt, input.endAt);
  if (input.pagination) {
    const configured = reportPagination(input.tool), pages = input.pagination.pages;
    const commonInvalid = !configured || pages.length < 1 || pages.length > configured.max_pages ||
        !/^sha256:[a-f0-9]{64}$/.test(input.pagination.snapshotHash) ||
        valueAt(input.output.structuredContent, configured.snapshot_path) !== input.pagination.snapshotHash ||
        input.pagination.totalCount !== result.itemCount || valueAt(input.output.structuredContent, configured.total_count_path) !== input.pagination.totalCount ||
        input.pagination.pageCount !== pages.length || pages.some(page => page.itemCount < 0 || !validResolution(page.resolution) ||
          page.snapshotHash !== input.pagination!.snapshotHash || page.totalCount !== input.pagination!.totalCount ||
          !/^sha256:[a-f0-9]{64}$/.test(page.argumentHash) || !/^sha256:[a-f0-9]{64}$/.test(page.outputHash) || !Number.isFinite(Date.parse(page.confirmedAt))) ||
        pages.reduce((sum, page) => sum + page.itemCount, 0) !== result.itemCount;
    const pageInvalid = configured?.profile === "page-number/v1" && input.pagination.profile === "report-page-evidence/v1" ?
      input.pagination.firstPage !== configured.first_page || input.pagination.lastPage !== configured.first_page + pages.length - 1 ||
      input.pagination.pages.some((page, index) => page.page !== configured.first_page + index || page.hasMore !== (index < pages.length - 1)) :
      configured?.profile === "page-number/v1" || input.pagination.profile === "report-page-evidence/v1";
    const cursorReceipt = input.pagination.profile === "report-cursor-evidence/v1" ? input.pagination : undefined;
    const cursorInvalid = configured?.profile === "opaque-cursor/v1" && cursorReceipt ?
      cursorReceipt.initialCursorHash !== resolvedParameterHashBytes(canonicalJSONBytes(configured.initial_cursor)) ||
      valueAt(input.output.structuredContent, configured.cursor_path) !== cursorReceipt.pages.at(-1)!.cursorHash ||
      valueAt(input.output.structuredContent, configured.next_cursor_path) !== "" ||
      cursorReceipt.pages.some((page, index) => page.ordinal !== index + 1 || page.hasMore !== (index < pages.length - 1) ||
        (index === 0 ? page.cursorHash !== cursorReceipt.initialCursorHash : page.cursorHash !== cursorReceipt.pages[index - 1]!.nextCursorHash) ||
        !/^sha256:[a-f0-9]{64}$/.test(page.cursorHash) || !/^sha256:[a-f0-9]{64}$/.test(page.nextCursorHash)) :
      configured?.profile === "opaque-cursor/v1" || input.pagination.profile === "report-cursor-evidence/v1";
    if (commonInvalid || pageInvalid || cursorInvalid)
      throw new Error("Paginated report evidence is incomplete or inconsistent");
  } else if (reportPagination(input.tool)) throw new Error("Application-owned report pagination evidence is required");
  return { profile: "schedule-report-coverage/v1", nodeId: input.nodeId, toolId: input.tool.tool_id, contractHash: input.contractHash,
    argumentHash: resolvedParameterHashBytes(canonicalJSONBytes(input.args)), outputHash: resolvedParameterHashBytes(canonicalJSONBytes(input.output)),
    startAt: input.startAt, endAt: input.endAt, itemCount: result.itemCount, confirmedAt: input.confirmedAt ?? new Date().toISOString(),
    ...(input.pagination ? { pagination: structuredClone(input.pagination) } : {}), ...(result.relatedRecords ? { relatedRecords: result.relatedRecords } : {}) };
}

export function assertScheduledReportCoverageReceipt(receipt: ReportCoverageReceipt | undefined, input: { tool: ToolDefinition; nodeId: string;
  contractHash: string; args: Record<string, unknown>; output: Record<string, unknown>; startAt: string; endAt: string }): void {
  if (!receipt || receipt.profile !== "schedule-report-coverage/v1") throw new Error("Scheduled delivery requires confirmed report coverage before an effect");
  const fresh = confirmScheduledReportCoverage({ ...input, confirmedAt: receipt.confirmedAt, ...(receipt.pagination ? { pagination: receipt.pagination } : {}) });
  if (canonicalJSONBytes(receipt).compare(canonicalJSONBytes(fresh)) !== 0) throw new Error("Scheduled report coverage evidence changed before the effect");
}

export function newReportPageProgress(tool: ToolDefinition, nodeId: string, contractHash: string, startAt: string, endAt: string): ReportPageProgress {
  const pagination = reportPagination(tool);
  if (!pagination || pagination.profile !== "page-number/v1") throw new Error("This report contract has no numeric-page pagination profile");
  return { profile: "schedule-report-pages/v1", nodeId, toolId: tool.tool_id, contractHash, startAt, endAt, firstPage: pagination.first_page,
    nextPage: pagination.first_page, maxPages: pagination.max_pages, items: [], pages: [] };
}

export function assertReportPageProgress(tool: ToolDefinition, progress: ReportPageProgress): void {
  const pagination = reportPagination(tool), pages = progress.pages;
  if (!pagination || pagination.profile !== "page-number/v1" || progress.profile !== "schedule-report-pages/v1" || progress.toolId !== tool.tool_id || progress.firstPage !== pagination.first_page ||
      progress.maxPages !== pagination.max_pages || pages.length >= pagination.max_pages || progress.nextPage !== pagination.first_page + pages.length ||
      progress.items.length > pagination.max_items || canonicalJSONBytes(progress.items).length > 2_000_000 ||
      pages.some((page, index) => page.page !== pagination.first_page + index || page.hasMore !== true || page.itemCount < 0 || !validResolution(page.resolution) ||
        page.snapshotHash !== (progress.snapshotValue === undefined ? "" : resolvedParameterHashBytes(canonicalJSONBytes(progress.snapshotValue))) ||
        page.totalCount !== progress.totalCount ||
        !/^sha256:[a-f0-9]{64}$/.test(page.argumentHash) || !/^sha256:[a-f0-9]{64}$/.test(page.outputHash) || !Number.isFinite(Date.parse(page.confirmedAt))) ||
      pages.reduce((sum, page) => sum + page.itemCount, 0) !== progress.items.length || Boolean(progress.lastOutput) !== Boolean(pages.length) ||
      Boolean(progress.snapshotValue) !== Boolean(pages.length) || Boolean(progress.totalCount !== undefined) !== Boolean(pages.length) ||
      (progress.totalCount !== undefined && (!Number.isSafeInteger(progress.totalCount) || progress.totalCount < progress.items.length || progress.totalCount > pagination.max_items)) ||
      (progress.snapshotValue !== undefined && Buffer.byteLength(progress.snapshotValue) > 2_048) ||
      progress.lastOutput && resolvedParameterHashBytes(canonicalJSONBytes(progress.lastOutput)) !== pages.at(-1)!.outputHash)
    throw new Error("Stored report page progress is inconsistent");
}

export function confirmScheduledReportPage(input: { tool: ToolDefinition; args: Record<string, unknown>; output: Record<string, unknown>; startAt: string;
  endAt: string; page: number; confirmedAt?: string }): { items: unknown[]; hasMore: boolean; snapshotValue: string; totalCount: number; evidence: ReportPageEvidence } {
  assertReportCoverageContract(input.tool);
  const contract = input.tool.report_coverage_contract!, pagination = contract.pagination;
  if (!pagination || pagination.profile !== "page-number/v1" || input.args[pagination.page_parameter] !== input.page) throw new Error("The report page did not use the server-owned page number");
  if (input.output.isError === true) throw new Error("The ERP report page returned an error");
  const body = input.output.structuredContent, coveredStart = valueAt(body, contract.covered_start_path), coveredEnd = valueAt(body, contract.covered_end_path);
  const complete = valueAt(body, contract.complete_path), hasMore = valueAt(body, contract.has_more_path), pageValue = valueAt(body, pagination.page_path);
  const items = valueAt(body, contract.items_path), count = valueAt(body, contract.item_count_path), snapshotValue = valueAt(body, pagination.snapshot_path);
  const totalCount = valueAt(body, pagination.total_count_path);
  if (coveredStart !== input.startAt || coveredEnd !== input.endAt || pageValue !== input.page || typeof hasMore !== "boolean" || complete !== !hasMore ||
      !Array.isArray(items) || !Number.isSafeInteger(count) || count !== items.length || items.length > pagination.max_items ||
      !Number.isSafeInteger(totalCount) || (totalCount as number) < items.length || (totalCount as number) > pagination.max_items ||
      typeof snapshotValue !== "string" || snapshotValue.length === 0 || Buffer.byteLength(snapshotValue) > 2_048)
    throw new Error("The ERP report page did not attest its exact page, interval, stable snapshot, total count, completeness and item count");
  relatedEvidence(input.tool, input.args, body, items, Boolean(contract.requested_key_coverage));
  const snapshotHash = resolvedParameterHashBytes(canonicalJSONBytes(snapshotValue));
  return { items: structuredClone(items), hasMore, snapshotValue, totalCount: totalCount as number, evidence: { page: input.page,
    argumentHash: resolvedParameterHashBytes(canonicalJSONBytes(input.args)), outputHash: resolvedParameterHashBytes(canonicalJSONBytes(input.output)),
    snapshotHash, itemCount: count as number, totalCount: totalCount as number, hasMore, confirmedAt: input.confirmedAt ?? new Date().toISOString() } };
}

export function newReportCursorProgress(tool: ToolDefinition, nodeId: string, contractHash: string, startAt: string, endAt: string): ReportCursorProgress {
  const pagination = reportPagination(tool);
  if (!pagination || pagination.profile !== "opaque-cursor/v1") throw new Error("This report contract has no opaque-cursor pagination profile");
  return { profile: "schedule-report-cursors/v1", nodeId, toolId: tool.tool_id, contractHash, startAt, endAt, initialCursor: pagination.initial_cursor,
    nextCursor: pagination.initial_cursor, maxPages: pagination.max_pages, items: [], pages: [] };
}

export function assertReportCursorProgress(tool: ToolDefinition, progress: ReportCursorProgress): void {
  const pagination = reportPagination(tool), pages = progress.pages;
  const snapshotHash = progress.snapshotValue === undefined ? "" : resolvedParameterHashBytes(canonicalJSONBytes(progress.snapshotValue));
  const initialCursorHash = resolvedParameterHashBytes(canonicalJSONBytes(progress.initialCursor));
  if (!pagination || pagination.profile !== "opaque-cursor/v1" || progress.profile !== "schedule-report-cursors/v1" || progress.toolId !== tool.tool_id ||
      progress.initialCursor !== pagination.initial_cursor || progress.maxPages !== pagination.max_pages || pages.length >= pagination.max_pages ||
      Buffer.byteLength(progress.nextCursor) > 2_048 || progress.items.length > pagination.max_items || canonicalJSONBytes(progress.items).length > 2_000_000 ||
      pages.some((page, index) => page.ordinal !== index + 1 || page.hasMore !== true || page.itemCount < 0 || !validResolution(page.resolution) || page.snapshotHash !== snapshotHash ||
        page.totalCount !== progress.totalCount || page.cursorHash !== (index === 0 ? initialCursorHash : pages[index - 1]!.nextCursorHash) ||
        !/^sha256:[a-f0-9]{64}$/.test(page.nextCursorHash) || !/^sha256:[a-f0-9]{64}$/.test(page.argumentHash) ||
        !/^sha256:[a-f0-9]{64}$/.test(page.outputHash) || !Number.isFinite(Date.parse(page.confirmedAt))) ||
      (pages.length ? pages.at(-1)!.nextCursorHash !== resolvedParameterHashBytes(canonicalJSONBytes(progress.nextCursor)) : progress.nextCursor !== progress.initialCursor) ||
      new Set([initialCursorHash, ...pages.map(page => page.nextCursorHash)]).size !== pages.length + 1 ||
      pages.reduce((sum, page) => sum + page.itemCount, 0) !== progress.items.length || Boolean(progress.lastOutput) !== Boolean(pages.length) ||
      Boolean(progress.snapshotValue) !== Boolean(pages.length) || Boolean(progress.totalCount !== undefined) !== Boolean(pages.length) ||
      (progress.totalCount !== undefined && (!Number.isSafeInteger(progress.totalCount) || progress.totalCount < progress.items.length || progress.totalCount > pagination.max_items)) ||
      (progress.snapshotValue !== undefined && Buffer.byteLength(progress.snapshotValue) > 2_048) ||
      progress.lastOutput && resolvedParameterHashBytes(canonicalJSONBytes(progress.lastOutput)) !== pages.at(-1)!.outputHash)
    throw new Error("Stored report cursor progress is inconsistent");
}

export function confirmScheduledReportCursor(input: { tool: ToolDefinition; args: Record<string, unknown>; output: Record<string, unknown>; startAt: string;
  endAt: string; cursor: string; ordinal: number; confirmedAt?: string }): { items: unknown[]; hasMore: boolean; snapshotValue: string; totalCount: number;
    nextCursor: string; evidence: ReportCursorEvidence } {
  assertReportCoverageContract(input.tool);
  const contract = input.tool.report_coverage_contract!, pagination = contract.pagination;
  if (!pagination || pagination.profile !== "opaque-cursor/v1" || input.args[pagination.cursor_parameter] !== input.cursor)
    throw new Error("The report page did not use the server-owned opaque cursor");
  if (input.output.isError === true) throw new Error("The ERP report cursor page returned an error");
  const body = input.output.structuredContent, coveredStart = valueAt(body, contract.covered_start_path), coveredEnd = valueAt(body, contract.covered_end_path);
  const complete = valueAt(body, contract.complete_path), hasMore = valueAt(body, contract.has_more_path), cursorValue = valueAt(body, pagination.cursor_path);
  const nextCursor = valueAt(body, pagination.next_cursor_path), items = valueAt(body, contract.items_path), count = valueAt(body, contract.item_count_path);
  const snapshotValue = valueAt(body, pagination.snapshot_path), totalCount = valueAt(body, pagination.total_count_path);
  if (coveredStart !== input.startAt || coveredEnd !== input.endAt || cursorValue !== input.cursor || typeof nextCursor !== "string" ||
      Buffer.byteLength(nextCursor) > 2_048 || typeof hasMore !== "boolean" || complete !== !hasMore || hasMore !== (nextCursor.length > 0) ||
      !Array.isArray(items) || !Number.isSafeInteger(count) || count !== items.length || items.length > pagination.max_items ||
      !Number.isSafeInteger(totalCount) || (totalCount as number) < items.length || (totalCount as number) > pagination.max_items ||
      typeof snapshotValue !== "string" || snapshotValue.length === 0 || Buffer.byteLength(snapshotValue) > 2_048)
    throw new Error("The ERP report cursor page did not attest its exact cursor, interval, next cursor, stable snapshot, total count, completeness and item count");
  relatedEvidence(input.tool, input.args, body, items, Boolean(contract.requested_key_coverage));
  const cursorHash = resolvedParameterHashBytes(canonicalJSONBytes(input.cursor));
  const nextCursorHash = resolvedParameterHashBytes(canonicalJSONBytes(nextCursor));
  if (hasMore && nextCursorHash === cursorHash) throw new Error("The ERP report cursor did not advance");
  return { items: structuredClone(items), hasMore, snapshotValue, totalCount: totalCount as number, nextCursor, evidence: { ordinal: input.ordinal,
    cursorHash, nextCursorHash, argumentHash: resolvedParameterHashBytes(canonicalJSONBytes(input.args)), outputHash: resolvedParameterHashBytes(canonicalJSONBytes(input.output)),
    snapshotHash: resolvedParameterHashBytes(canonicalJSONBytes(snapshotValue)), itemCount: count as number, totalCount: totalCount as number,
    hasMore, confirmedAt: input.confirmedAt ?? new Date().toISOString() } };
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

function setAggregateProjectedKeys(tool: ToolDefinition, output: Record<string, unknown>, items: unknown[]): void {
  const coverage = tool.report_coverage_contract, projection = coverage?.key_projection;
  if (!coverage || !projection) return;
  const schema = itemSchemaAt(tool.bridge_contract!.output_schema, coverage.items_path, projection.item_key_path)!;
  const keys = itemKeyValues(items, projection.item_key_path, schema.type), seen = new Set<string>(), values: Array<string | number> = [];
  keys.tokens.forEach((token, index) => { if (!seen.has(token)) { seen.add(token); values.push(keys.values[index]!); } });
  setAt(output.structuredContent, projection.keys_path, values);
}

export function protectedReportPageOutput(tool: ToolDefinition, output: Record<string, unknown>, replacement = "[protected snapshot marker]"): Record<string, unknown> {
  const safe = structuredClone(output), pagination = tool.report_coverage_contract?.pagination;
  if (pagination && safe.structuredContent && typeof safe.structuredContent === "object" && !Array.isArray(safe.structuredContent)) {
    try { setAt(safe.structuredContent, pagination.snapshot_path, replacement); } catch { /* malformed failure output remains bounded but has no trusted selector */ }
    if (pagination.profile === "opaque-cursor/v1") {
      try { setAt(safe.structuredContent, pagination.cursor_path, "[protected cursor]"); } catch { /* no trusted selector */ }
      try { setAt(safe.structuredContent, pagination.next_cursor_path, "[protected cursor]"); } catch { /* no trusted selector */ }
    }
  }
  return safe;
}

export function completePaginatedReport(tool: ToolDefinition, progress: ReportPageProgress): { output: Record<string, unknown>; receiptPagination: ReportPageReceipt } {
  const contract = tool.report_coverage_contract!, pagination = reportPagination(tool);
  if (!pagination || pagination.profile !== "page-number/v1" || !progress.lastOutput || !progress.pages.length || progress.pages.at(-1)!.hasMore || progress.nextPage !== progress.pages.at(-1)!.page + 1 ||
      progress.totalCount === undefined || progress.items.length !== progress.totalCount)
    throw new Error("Paginated report is not complete");
  const output = structuredClone(progress.lastOutput);
  setAt(output.structuredContent, contract.items_path, structuredClone(progress.items)); setAt(output.structuredContent, contract.item_count_path, progress.items.length);
  setAggregateProjectedKeys(tool, output, progress.items);
  setAt(output.structuredContent, pagination.total_count_path, progress.totalCount);
  setAt(output.structuredContent, contract.complete_path, true); setAt(output.structuredContent, contract.has_more_path, false);
  const lastPage = progress.pages.at(-1)!.page; setAt(output.structuredContent, pagination.page_path, lastPage);
  if (!progress.snapshotValue) throw new Error("Paginated report has no stable snapshot evidence");
  const snapshotHash = resolvedParameterHashBytes(canonicalJSONBytes(progress.snapshotValue)); setAt(output.structuredContent, pagination.snapshot_path, snapshotHash);
  return { output, receiptPagination: { profile: "report-page-evidence/v1", firstPage: progress.firstPage, lastPage, totalCount: progress.totalCount, snapshotHash,
    pageCount: progress.pages.length, pages: structuredClone(progress.pages) } };
}

export function completeCursorPaginatedReport(tool: ToolDefinition, progress: ReportCursorProgress): { output: Record<string, unknown>; receiptPagination: ReportCursorReceipt } {
  const contract = tool.report_coverage_contract!, pagination = reportPagination(tool);
  if (!pagination || pagination.profile !== "opaque-cursor/v1" || !progress.lastOutput || !progress.pages.length || progress.pages.at(-1)!.hasMore ||
      progress.nextCursor !== "" || progress.totalCount === undefined || progress.items.length !== progress.totalCount)
    throw new Error("Cursor-paginated report is not complete");
  const output = structuredClone(progress.lastOutput), last = progress.pages.at(-1)!;
  setAt(output.structuredContent, contract.items_path, structuredClone(progress.items)); setAt(output.structuredContent, contract.item_count_path, progress.items.length);
  setAggregateProjectedKeys(tool, output, progress.items);
  setAt(output.structuredContent, pagination.total_count_path, progress.totalCount); setAt(output.structuredContent, contract.complete_path, true);
  setAt(output.structuredContent, contract.has_more_path, false); setAt(output.structuredContent, pagination.cursor_path, last.cursorHash);
  setAt(output.structuredContent, pagination.next_cursor_path, "");
  if (!progress.snapshotValue) throw new Error("Cursor-paginated report has no stable snapshot evidence");
  const snapshotHash = resolvedParameterHashBytes(canonicalJSONBytes(progress.snapshotValue)); setAt(output.structuredContent, pagination.snapshot_path, snapshotHash);
  return { output, receiptPagination: { profile: "report-cursor-evidence/v1", pageCount: progress.pages.length, totalCount: progress.totalCount, snapshotHash,
    initialCursorHash: resolvedParameterHashBytes(canonicalJSONBytes(progress.initialCursor)), pages: structuredClone(progress.pages) } };
}
