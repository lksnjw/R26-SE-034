import { expect, test } from "vitest";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { toolSchema } from "../src/registry/schemas.js";
import { assertReportCoverageContract, confirmScheduledReportCoverage } from "../src/tools/report-coverage-contract.js";

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
