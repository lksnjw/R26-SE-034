import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import { stringify } from "yaml";
import { operationTaskFixture } from "./operation-task.js";
import { configureWorkflowLifecycle } from "../../src/runner/workflow-lifecycle-host.js";
import { toolSchema } from "../../src/registry/schemas.js";
import { observeCapabilities, reviewCapability } from "../../src/registry/capability-admission.js";
import { bridgeTransportSchema, exactBridgeName } from "../../src/tools/erpbridge-contract.js";
import { canonicalJSONBytes } from "../../src/core/canonical-json.js";

export async function workflowLifecycleFixture(options: Parameters<typeof operationTaskFixture>[0] & { lifecycle?: boolean } = {}) {
  const s = await operationTaskFixture(options), { services, repository, sdk } = s, base = services.registries.snapshot();
  if (options.lifecycle !== false) configureWorkflowLifecycle(repository);
  const report = toolSchema.parse({ ...s.target, tool_id: "lifecycle-report", name: "demo.lifecycleReport", mcp_tool_name: "demo.lifecycleReport",
    input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" } }, required: ["startAt", "endAt"], additionalProperties: false },
    report_coverage_contract: { profile: "report-coverage/v1", start_parameter: "startAt", end_parameter: "endAt", covered_start_path: ["coveredStartAt"], covered_end_path: ["coveredEndAt"],
      complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"] },
    bridge_contract: { ...s.target.bridge_contract, resource_digest: "e".repeat(64), output_schema: { type: "object", properties: {
      coveredStartAt: { type: "string" }, coveredEndAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }, itemCount: { type: "integer" }, summary: { type: "string" } },
      required: ["coveredStartAt", "coveredEndAt", "complete", "hasMore", "items", "itemCount", "summary"], additionalProperties: false } } });
  const tools = [s.target, s.effect, report];
  vi.mocked(services.registries.snapshot).mockImplementation(() => ({ ...base, tools }));
  vi.mocked(services.registries.findTool).mockImplementation(name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name)));
  vi.mocked(services.registries.hash).mockImplementation(() => `sha256:${createHash("sha256").update(canonicalJSONBytes(tools)).digest("hex")}`);
  sdk.listTools.mockImplementation(async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract!.output_schema!,
    _meta: { "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } })));
  const actor = (await repository.effectiveUser("requester"))!;
  if (!(await repository.read(state => Object.values(state.capabilityRevisions).some(value => value.toolId === report.tool_id)))) {
  for (const observation of (await observeCapabilities({ repository, registries: services.registries, session: s.session, user: actor })).observations.filter(value => value.toolId === report.tool_id))
    await reviewCapability({ repository, registries: services.registries, session: s.session, user: actor, capabilityId: observation.capabilityId, body: {
      observationId: observation.id, contractHash: observation.contractHash, decisionKey: "lifecycle-report-review-0001", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Synthetic lifecycle report fixture" } });
  }
  sdk.callTool.mockImplementation(async (name, args) => name === exactBridgeName(report) ? { content: [], structuredContent: { coveredStartAt: args.startAt, coveredEndAt: args.endAt,
    complete: true, hasMore: false, items: [{ id: "synthetic-invoice" }], itemCount: 1, summary: "Reviewed synthetic report" } } : { content: [], structuredContent: { accepted: true } });
  const create = async (id = "scheduled") => {
    if (await repository.read(state => !!state.workflows[id])) return;
    await repository.mutate(state => {
      const source = state.workflows.bounded!, yaml = stringify({ name: "Calendar report fixture", description: "Synthetic complete report and exact independent effect review", trigger: { type: "manual", config: { inputSchema: {
        type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } }, required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps: [
        { id: "lookupReport", action: report.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
        { id: "send", action: s.effect.name, parameters: { value: "{{lookupReport.structuredContent.summary}}" } } ] });
      state.workflows[id] = { ...source, id, yaml, steps: 2, publishedVersion: 0, draftVersion: 1, canRun: false }; state.versions[id] = [];
    });
    const published = await s.request("POST", `/api/workflows/${id}/publish`, {}); expect(published.statusCode, published.body).toBe(200);
  };
  await create(); sdk.callTool.mockClear(); s.enqueue.mockClear();
  const command = async (id = "scheduled", overrides: Record<string, unknown> = {}) => {
    const state = await repository.snapshot(), workflow = state.workflows[id]!;
    return { profile: "workflow-daily-schedule-command/v1", baseRevision: state.schedules[`schedule-${id}`]?.revision ?? 0, workflowVersion: workflow.publishedVersion,
      workflowHash: `sha256:${createHash("sha256").update(workflow.yaml).digest("hex")}`, enabled: true, timezone: "Asia/Colombo", localTime: "09:00", reportingPeriod: "previous-calendar-day",
      misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "requester", input: {}, reportWindowBinding: { profile: "workflow-report-window-input-binding/v1", startAtInput: "reportStartAt", endAtInput: "reportEndAt" }, ...overrides };
  };
  const save = async (id = "scheduled", overrides: Record<string, unknown> = {}) => s.app.inject({ method: "PUT", url: `/api/workflows/${id}/schedule`, headers: s.headers, payload: await command(id, overrides) });
  return { ...s, report, create, command, save };
}
