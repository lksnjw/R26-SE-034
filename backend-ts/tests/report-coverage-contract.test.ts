import { expect, test } from "vitest";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { toolSchema } from "../src/registry/schemas.js";
import { assertReportCoverageContract, completeCursorPaginatedReport, completePaginatedReport, confirmScheduledReportCoverage,
  confirmScheduledReportCursor, confirmScheduledReportPage, newReportCursorProgress, newReportPageProgress,
  assertReportRelatedKeyProgress } from "../src/tools/report-coverage-contract.js";

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

function relatedFixtures() {
  const primaryBase = fixture();
  const primaryOutput = primaryBase.bridge_contract!.output_schema as any;
  const primary = toolSchema.parse({
    ...primaryBase,
    bridge_contract: {
      ...primaryBase.bridge_contract!,
      output_schema: {
        ...primaryOutput,
        properties: {
          ...primaryOutput.properties,
          items: { type: "array", items: { type: "object", properties: { invoiceId: { type: "string" }, orderId: { type: "string" } },
            required: ["invoiceId", "orderId"], additionalProperties: false } },
          orderIds: { type: "array", maxItems: 100, items: { type: "string" } },
        },
        required: [...primaryOutput.required, "orderIds"],
      },
    },
    report_coverage_contract: { ...primaryBase.report_coverage_contract!, key_projection: { profile: "report-key-projection/v1",
      relation_name: "invoice-orders", item_key_path: ["orderId"], keys_path: ["orderIds"] } },
  });
  const relatedBase = fixture();
  const relatedOutput = relatedBase.bridge_contract!.output_schema as any;
  const related = toolSchema.parse({
    ...relatedBase,
    tool_id: "order-report", name: "order.report", mcp_tool_name: "order.report",
    input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" },
      orderIds: { type: "array", maxItems: 100_000, items: { type: "string" } } }, required: ["startAt", "endAt", "orderIds"], additionalProperties: false },
    bridge_contract: {
      ...relatedBase.bridge_contract!,
      output_schema: {
        ...relatedOutput,
        properties: {
          ...relatedOutput.properties,
          items: { type: "array", items: { type: "object", properties: { orderId: { type: "string" }, total: { type: "integer" } },
            required: ["orderId", "total"], additionalProperties: false } },
        },
      },
    },
    report_coverage_contract: { ...relatedBase.report_coverage_contract!, requested_key_coverage: { profile: "report-requested-key-coverage/v1",
      relation_name: "invoice-orders", keys_parameter: "orderIds", item_key_path: ["orderId"] } },
  });
  return { primary, related };
}

test("reviewed report coverage requires declared typed non-sensitive selectors", () => {
  expect(() => assertReportCoverageContract(fixture())).not.toThrow();
  const badOutput = fixture(); (badOutput.bridge_contract!.output_schema as { properties: Record<string, { type: string }> }).properties.complete!.type = "string";
  expect(() => assertReportCoverageContract(badOutput)).toThrow(/selectors/i);
  const secretInput = fixture(); secretInput.report_coverage_contract!.start_parameter = "apiToken";
  expect(() => assertReportCoverageContract(secretInput)).toThrow(/window parameters/i);
});

test("reviewed report business identity is strict and contract-hash bound", () => {
  const base = fixture();
  const invoices = toolSchema.parse({ ...base, report_coverage_contract: { ...base.report_coverage_contract!, business_resource: "invoices" } });
  const orders = toolSchema.parse({ ...base, report_coverage_contract: { ...base.report_coverage_contract!, business_resource: "orders" } });
  expect(invoices.report_coverage_contract?.business_resource).toBe("invoices");
  expect(capabilityContractHash(invoices)).not.toBe(capabilityContractHash(orders));
  expect(() => toolSchema.parse({ ...base, report_coverage_contract: { ...base.report_coverage_contract!, business_resource: "Invoice Details" } })).toThrow();
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

test("related report evidence proves the projected invoice order keys were requested and returned exactly", () => {
  const { primary, related } = relatedFixtures(), startAt = "2026-10-06T00:00:00.000Z", endAt = "2026-10-07T00:00:00.000Z";
  expect(() => assertReportCoverageContract(primary)).not.toThrow();
  expect(() => assertReportCoverageContract(related)).not.toThrow();
  const primaryOutput = { structuredContent: { coveredStartAt: startAt, coveredEndAt: endAt, complete: true, hasMore: false,
    items: [{ invoiceId: "INV-1", orderId: "ORD-1" }, { invoiceId: "INV-2", orderId: "ORD-2" }], itemCount: 2,
    orderIds: ["ORD-2", "ORD-1"] } };
  const projected = confirmScheduledReportCoverage({ tool: primary, nodeId: "invoices", contractHash: capabilityContractHash(primary),
    args: { startAt, endAt }, output: primaryOutput, startAt, endAt });
  const relatedArgs = { startAt, endAt, orderIds: ["ORD-1", "ORD-2"] };
  const relatedOutput = { structuredContent: { coveredStartAt: startAt, coveredEndAt: endAt, complete: true, hasMore: false,
    items: [{ orderId: "ORD-2", total: 20 }, { orderId: "ORD-1", total: 10 }], itemCount: 2 } };
  const matched = confirmScheduledReportCoverage({ tool: related, nodeId: "orders", contractHash: capabilityContractHash(related),
    args: relatedArgs, output: relatedOutput, startAt, endAt });
  expect(projected.relatedRecords).toMatchObject({ mode: "PROJECTED", relationName: "invoice-orders", keyCount: 2, keysHash: expect.stringMatching(/^sha256:/) });
  expect(matched.relatedRecords).toMatchObject({ mode: "REQUESTED_MATCHED", relationName: "invoice-orders", keyCount: 2,
    keysHash: projected.relatedRecords!.keysHash });

  expect(() => confirmScheduledReportCoverage({ tool: primary, nodeId: "invoices", contractHash: capabilityContractHash(primary),
    args: { startAt, endAt }, output: { structuredContent: { ...primaryOutput.structuredContent, orderIds: ["ORD-1"] } }, startAt, endAt })).toThrow(/projection/i);
  for (const items of [[{ orderId: "ORD-1", total: 10 }], [{ orderId: "ORD-1", total: 10 }, { orderId: "ORD-3", total: 30 }],
    [{ orderId: "ORD-1", total: 10 }, { orderId: "ORD-1", total: 10 }]]) {
    expect(() => confirmScheduledReportCoverage({ tool: related, nodeId: "orders", contractHash: capabilityContractHash(related), args: relatedArgs,
      output: { structuredContent: { ...relatedOutput.structuredContent, items, itemCount: items.length } }, startAt, endAt })).toThrow(/related-record|duplicate/i);
  }
});

test("paginated related-key progress allows only requested subsets and requires the exact final set", () => {
  const { related } = relatedFixtures(), args = { startAt: "2026-10-06T00:00:00.000Z", endAt: "2026-10-07T00:00:00.000Z", orderIds: ["ORD-1", "ORD-2"] };
  expect(() => assertReportRelatedKeyProgress(related, args, [{ orderId: "ORD-1", total: 10 }], true)).not.toThrow();
  expect(() => assertReportRelatedKeyProgress(related, args, [{ orderId: "ORD-1", total: 10 }], false)).toThrow(/exactly/i);
  expect(() => assertReportRelatedKeyProgress(related, args, [{ orderId: "ORD-3", total: 30 }], true)).toThrow(/outside/i);
  expect(() => assertReportRelatedKeyProgress(related, args, [{ orderId: "ORD-1", total: 10 }, { orderId: "ORD-1", total: 10 }], true)).toThrow(/duplicate/i);
});

test("large reviewed related-key sets use bounded set membership rather than repeated linear scans", () => {
  const { related } = relatedFixtures(), startAt = "2026-10-06T00:00:00.000Z", endAt = "2026-10-07T00:00:00.000Z";
  const orderIds = Array.from({ length: 10_000 }, (_, index) => `ORD-${index}`), items = [...orderIds].reverse().map((orderId, index) => ({ orderId, total: index }));
  expect(() => confirmScheduledReportCoverage({ tool: related, nodeId: "orders", contractHash: capabilityContractHash(related),
    args: { startAt, endAt, orderIds }, output: { structuredContent: { coveredStartAt: startAt, coveredEndAt: endAt, complete: true, hasMore: false,
      items, itemCount: items.length } }, startAt, endAt })).not.toThrow();
});

test("related-key contracts fail review when key fields are optional or differently typed", () => {
  const { primary, related } = relatedFixtures();
  const optionalProjection = structuredClone(primary);
  (optionalProjection.bridge_contract!.output_schema as any).required = (optionalProjection.bridge_contract!.output_schema as any).required.filter((name: string) => name !== "orderIds");
  expect(() => assertReportCoverageContract(optionalProjection)).toThrow(/projection/i);
  const mismatched = structuredClone(related);
  (mismatched.bridge_contract!.output_schema as any).properties.items.items.properties.orderId.type = "integer";
  expect(() => assertReportCoverageContract(mismatched)).toThrow(/related-key coverage/i);
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
