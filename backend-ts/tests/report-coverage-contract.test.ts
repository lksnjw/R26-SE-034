import { expect, test } from "vitest";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { toolSchema } from "../src/registry/schemas.js";
import { assertReportCoverageContract, completeCursorPaginatedReport, completePaginatedReport, confirmScheduledReportCoverage,
  confirmScheduledReportCursor, confirmScheduledReportPage, newReportCursorProgress, newReportPageProgress } from "../src/tools/report-coverage-contract.js";

const fixture = () => toolSchema.parse({
  tool_id: "report", name: "invoice.report", mcp_tool_name: "invoice.report", allowed_roles: ["Platform Admin"], risk_level: "low", is_read_only: true,
  input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" } }, required: ["startAt", "endAt"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: {
    type: "object", properties: { coveredStartAt: { type: "string" }, coveredEndAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
      items: { type: "array", items: { type: "object" } }, itemCount: { type: "integer" } },
    required: ["coveredStartAt", "coveredEndAt", "complete", "hasMore", "items", "itemCount"], additionalProperties: false } },
  report_coverage_contract: { profile: "report-coverage/v1", start_parameter: "startAt", end_parameter: "endAt", covered_start_path: ["coveredStartAt"],
    covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"] },
});

test("reviewed report coverage requires declared typed non-sensitive selectors", () => {
  expect(() => assertReportCoverageContract(fixture())).not.toThrow();
  const badOutput = fixture(); (badOutput.bridge_contract!.output_schema as { properties: Record<string, { type: string }> }).properties.complete!.type = "string";
  expect(() => assertReportCoverageContract(badOutput)).toThrow(/selectors/i);
  const secretInput = fixture(); secretInput.report_coverage_contract!.start_parameter = "apiToken";
  expect(() => assertReportCoverageContract(secretInput)).toThrow(/window parameters/i);
});

test("runtime confirmation binds exact interval, completion, exhaustion, items and count into a hashed receipt", () => {
  const tool = fixture(), startAt = "2026-10-06T00:00:00.000Z", endAt = "2026-10-07T00:00:00.000Z";
  const args = { startAt, endAt }, output = { structuredContent: { coveredStartAt: startAt, coveredEndAt: endAt, complete: true, hasMore: false, items: [{ id: "one" }], itemCount: 1 } };
  expect(confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool), args, output, startAt, endAt })).toMatchObject({
    profile: "schedule-report-coverage/v1", nodeId: "report", toolId: "report", startAt, endAt, itemCount: 1 });
  expect(() => confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool), args, output: {
    structuredContent: { ...output.structuredContent, hasMore: true } }, startAt, endAt })).toThrow(/complete bounded coverage/i);
  expect(() => confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool), args, output: {
    structuredContent: { ...output.structuredContent, itemCount: 2 } }, startAt, endAt })).toThrow(/complete bounded coverage/i);
  expect(() => confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool), args: { startAt: "wrong", endAt }, output,
    startAt, endAt })).toThrow(/exact scheduled window/i);
});

test("server-owned bounded page evidence aggregates only a contiguous exhausted sequence", () => {
  const base = fixture(), tool = toolSchema.parse({ ...base,
    input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" }, page: { type: "integer" } }, required: ["startAt", "endAt"], additionalProperties: false },
    report_coverage_contract: { ...base.report_coverage_contract!, pagination: { profile: "page-number/v1", page_parameter: "page", page_path: ["page"], snapshot_path: ["snapshotId"], total_count_path: ["totalAvailable"], first_page: 1, max_pages: 3, max_items: 10 } },
    bridge_contract: { ...base.bridge_contract!, output_schema: { ...base.bridge_contract!.output_schema!, properties: { ...(base.bridge_contract!.output_schema as any).properties,
      items: { type: "array", maxItems: 10, items: { type: "object" } }, page: { type: "integer" }, snapshotId: { type: "string" }, totalAvailable: { type: "integer" } },
      required: [...((base.bridge_contract!.output_schema as any).required as string[]), "page", "snapshotId", "totalAvailable"] } } });
  expect(() => assertReportCoverageContract(tool)).not.toThrow();
  const requiredPage = structuredClone(tool); (requiredPage.input_schema.required as string[]).push("page");
  expect(() => assertReportCoverageContract(requiredPage)).toThrow(/pagination|page/i);
  const undersizedItems = structuredClone(tool); ((undersizedItems.bridge_contract!.output_schema as any).properties.items as any).maxItems = 9;
  expect(() => assertReportCoverageContract(undersizedItems)).toThrow(/pagination|items output/i);
  const missingSnapshot = structuredClone(tool); ((missingSnapshot.bridge_contract!.output_schema as any).properties.snapshotId as any).type = "number";
  expect(() => assertReportCoverageContract(missingSnapshot)).toThrow(/snapshot|pagination/i);
  const startAt = "2026-10-06T00:00:00.000Z", endAt = "2026-10-07T00:00:00.000Z", progress = newReportPageProgress(tool, "report", capabilityContractHash(tool), startAt, endAt);
  for (const page of [1, 2]) {
    const hasMore = page === 1, args = { startAt, endAt, page }, output = { structuredContent: { coveredStartAt: startAt, coveredEndAt: endAt,
      complete: !hasMore, hasMore, items: [{ id: `item-${page}` }], itemCount: 1, page, snapshotId: "snapshot-report", totalAvailable: 2 } };
    const confirmed = confirmScheduledReportPage({ tool, args, output, startAt, endAt, page, confirmedAt: `2026-10-07T00:00:0${page}.000Z` });
    progress.snapshotValue ??= confirmed.snapshotValue; progress.totalCount ??= confirmed.totalCount; progress.pages.push(confirmed.evidence); progress.items.push(...confirmed.items); progress.lastOutput = output; progress.nextPage++;
  }
  const completed = completePaginatedReport(tool, progress);
  expect(completed.output.structuredContent).toMatchObject({ complete: true, hasMore: false, itemCount: 2, page: 2, items: [{ id: "item-1" }, { id: "item-2" }] });
  expect(confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool), args: { startAt, endAt }, output: completed.output,
    startAt, endAt, pagination: completed.receiptPagination })).toMatchObject({ itemCount: 2,
      pagination: { firstPage: 1, lastPage: 2, pageCount: 2, totalCount: 2, snapshotHash: expect.stringMatching(/^sha256:/) } });
  const gap = structuredClone(completed.receiptPagination); gap.pages[1]!.page = 3;
  expect(() => confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool), args: { startAt, endAt }, output: completed.output,
    startAt, endAt, pagination: gap })).toThrow(/incomplete or inconsistent/i);
});

test("server-owned opaque cursor evidence advances without exposing raw continuations", () => {
  const base = fixture(), tool = toolSchema.parse({ ...base,
    input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" }, cursor: { type: "string" } }, required: ["startAt", "endAt"], additionalProperties: false },
    report_coverage_contract: { ...base.report_coverage_contract!, pagination: { profile: "opaque-cursor/v1", cursor_parameter: "cursor", cursor_path: ["cursor"],
      next_cursor_path: ["nextCursor"], snapshot_path: ["snapshotId"], total_count_path: ["totalAvailable"], initial_cursor: "", max_pages: 3, max_items: 10 } },
    bridge_contract: { ...base.bridge_contract!, output_schema: { ...base.bridge_contract!.output_schema!, properties: { ...(base.bridge_contract!.output_schema as any).properties,
      items: { type: "array", maxItems: 10, items: { type: "object" } }, cursor: { type: "string" }, nextCursor: { type: "string" },
      snapshotId: { type: "string" }, totalAvailable: { type: "integer" } },
      required: [...((base.bridge_contract!.output_schema as any).required as string[]), "cursor", "nextCursor", "snapshotId", "totalAvailable"] } } });
  expect(() => assertReportCoverageContract(tool)).not.toThrow();
  const progress = newReportCursorProgress(tool, "report", capabilityContractHash(tool), "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z");
  for (const [index, cursor] of ["", "cursor-two"].entries()) {
    const hasMore = index === 0, nextCursor = hasMore ? "cursor-two" : "", args = { startAt: progress.startAt, endAt: progress.endAt, cursor };
    const output = { structuredContent: { coveredStartAt: progress.startAt, coveredEndAt: progress.endAt, complete: !hasMore, hasMore,
      items: [{ id: `item-${index + 1}` }], itemCount: 1, cursor, nextCursor, snapshotId: "snapshot-report", totalAvailable: 2 } };
    const confirmed = confirmScheduledReportCursor({ tool, args, output, startAt: progress.startAt, endAt: progress.endAt, cursor, ordinal: index + 1 });
    progress.snapshotValue ??= confirmed.snapshotValue; progress.totalCount ??= confirmed.totalCount; progress.pages.push(confirmed.evidence);
    progress.items.push(...confirmed.items); progress.lastOutput = output; progress.nextCursor = confirmed.nextCursor;
  }
  const completed = completeCursorPaginatedReport(tool, progress);
  expect(JSON.stringify(completed)).not.toContain("cursor-two");
  expect(completed.output.structuredContent).toMatchObject({ complete: true, hasMore: false, nextCursor: "", itemCount: 2,
    cursor: expect.stringMatching(/^sha256:/), items: [{ id: "item-1" }, { id: "item-2" }] });
  expect(confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool), args: { startAt: progress.startAt, endAt: progress.endAt },
    output: completed.output, startAt: progress.startAt, endAt: progress.endAt, pagination: completed.receiptPagination })).toMatchObject({ itemCount: 2,
      pagination: { profile: "report-cursor-evidence/v1", pageCount: 2, totalCount: 2, initialCursorHash: expect.stringMatching(/^sha256:/) } });
  const resolved = structuredClone(completed.receiptPagination);
  resolved.pages[1]!.resolution = { profile: "report-page-operator-evidence/v1", recordId: "resolution-1", actorId: "reviewer",
    referenceHash: `sha256:${"b".repeat(64)}`, observedAt: "2026-10-07T00:00:00.000Z", recordedAt: "2026-10-07T00:00:01.000Z" };
  expect(() => confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool),
    args: { startAt: progress.startAt, endAt: progress.endAt }, output: completed.output, startAt: progress.startAt, endAt: progress.endAt,
    pagination: resolved })).not.toThrow();
  resolved.pages[1]!.resolution!.actorId = "";
  expect(() => confirmScheduledReportCoverage({ tool, nodeId: "report", contractHash: capabilityContractHash(tool),
    args: { startAt: progress.startAt, endAt: progress.endAt }, output: completed.output, startAt: progress.startAt, endAt: progress.endAt,
    pagination: resolved })).toThrow(/incomplete or inconsistent/i);
  const repeated = { structuredContent: { coveredStartAt: progress.startAt, coveredEndAt: progress.endAt, complete: false, hasMore: true,
    items: [{ id: "bad" }], itemCount: 1, cursor: "repeat", nextCursor: "repeat", snapshotId: "snapshot-report", totalAvailable: 2 } };
  expect(() => confirmScheduledReportCursor({ tool, args: { startAt: progress.startAt, endAt: progress.endAt, cursor: "repeat" }, output: repeated,
    startAt: progress.startAt, endAt: progress.endAt, cursor: "repeat", ordinal: 1 })).toThrow(/did not advance/i);
});
