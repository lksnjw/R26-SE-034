import { resolve } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { hasRecurringCompositionCapability, inspectRecurringAutomationCandidate, recurringAutomationCandidateContext,
  recurringDeliveryRequest } from "../src/delivery/recurring-automation.js";
import { RegistryService } from "../src/registry/service.js";
import { analysisRequirement, recurringAnalysisTools, reportAnalysis } from "./fixtures/recurring-analysis-tools.js";
import { deliveryOutputReferences } from "../src/delivery/recurring-analysis.js";

const text = "Get invoice and order details and email the report to manager@example.test every day";

async function fixture() {
  const request = recurringDeliveryRequest(text)!;
  const registries = await RegistryService.load(resolve("tests/fixtures/recurring-tools.json"), resolve("tests/fixtures/rules.json"));
  const tools = registries.snapshot().tools;
  const unresolved = request.requirements.filter(item => !item.startsWith("Add exact reviewed ERP report") &&
    !item.startsWith("Add one exact reviewed ERP report") && !item.startsWith("Add one exact reviewed email"));
  const workflow: Record<string, any> = {
    name: "Daily invoice and order report",
    description: "Reads complete invoice and related order reports before proposing reviewed email delivery.",
    trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } },
      required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } },
    steps: [
      { id: "invoice_report", action: "erp.invoices.report", description: "Read complete invoices", parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
      { id: "order_report", action: "erp.orders.report", description: "Read every related order", parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}", orderIds: "{{invoice_report.structuredContent.orderIds}}" } },
      { id: "deliver_report", action: "erp.email.deliver", description: "Propose reviewed report delivery", parameters: { recipient: "manager@example.test", subject: "Daily invoice and order report", body: "Invoices: {{invoice_report.structuredContent.summary}}\nOrders: {{order_report.structuredContent.summary}}" } },
    ],
    metadata: { automation_request: recurringAutomationCandidateContext(request).automation_request, unresolved_requirements: unresolved },
  };
  return { request, tools, workflow, yaml: stringify(workflow).trim(), unresolved };
}

test("recurring intent preserves exact resources and exposes a bounded server context", async () => {
  const { request, tools } = await fixture();
  expect(request).toMatchObject({ cadence: "daily", requestedAddresses: ["manager@example.test"], requestedResources: ["invoices", "orders"], analysisRequested: false, scheduleActive: false });
  expect(recurringAutomationCandidateContext(request)).toMatchObject({ profile: "recurring-automation-candidate-context/v1",
    automation_request: { cadence: "daily", requested_resources: ["invoices", "orders"], schedule_active: false },
    workflow_report_window_inputs: { start: "reportStartAt", end: "reportEndAt" } });
  expect(hasRecurringCompositionCapability(request, tools, "Platform Admin")).toBe(true);
});

test("exact report relation and delivery bindings become readable mapped evidence but never readiness", async () => {
  const { request, tools, yaml, unresolved } = await fixture();
  const result = inspectRecurringAutomationCandidate(yaml, request, tools, "Platform Admin");
  expect(result).toMatchObject({ status: "CAPABILITIES_MAPPED", relatedRecords: { status: "MATCHED", relationName: "invoice-orders" },
    reportWindowBound: true, recipientBound: true, deliveryBodyBound: true, readyForPublication: false, scheduleActive: false,
    remainingRequirements: unresolved });
  expect(result.mappedSteps.map(step => [step.stepId, step.capability])).toEqual([
    ["invoice_report", "report"], ["order_report", "report"], ["deliver_report", "delivery"],
  ]);
});

test.each(["recipient", "relation", "window", "requirements"])("recurring candidate fails closed when %s evidence changes", async kind => {
  const { request, tools, workflow } = await fixture();
  if (kind === "recipient") workflow.steps[2]!.parameters.recipient = "invented@example.test";
  if (kind === "relation") workflow.steps[1]!.parameters.orderIds = ["order-1"];
  if (kind === "window") workflow.steps[0]!.parameters.startAt = "2026-01-01T00:00:00Z";
  if (kind === "requirements") workflow.metadata.unresolved_requirements = [];
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("Recurring automation candidate failed its server contract");
});

test("analysis remains an explicit blocker instead of being silently dropped", async () => {
  const request = recurringDeliveryRequest("Analyse invoice and order details and email the report to manager@example.test daily")!;
  const { tools, workflow } = await fixture();
  workflow.metadata.automation_request = recurringAutomationCandidateContext(request).automation_request;
  workflow.metadata.unresolved_requirements.push("Add a supported bounded analysis node or retain analysis as an unresolved requested outcome.");
  const result = inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin");
  expect(result.status).toBe("PARTIAL");
  expect(result.remainingRequirements).toContain("Add a supported bounded analysis node or retain analysis as an unresolved requested outcome.");
});

async function analysisFixture() {
  const source = await fixture(), request = recurringDeliveryRequest("Analyse invoice and order details and email the report to manager@example.test daily")!;
  const workflow = source.workflow;
  workflow.metadata.automation_request = recurringAutomationCandidateContext(request).automation_request;
  workflow.steps.splice(2, 0, reportAnalysis("invoice_analysis", "invoice_report"), reportAnalysis("order_analysis", "order_report"));
  workflow.steps[4].parameters.body = "Invoices: {{invoice_analysis.structuredContent.text}}\nOrders: {{order_analysis.structuredContent.text}}";
  return { ...source, request, workflow, tools: recurringAnalysisTools(source.tools) };
}

test("all requested per-resource analyses and joined delivery map without granting publication, egress or a schedule", async () => {
  const { request, workflow, tools } = await analysisFixture();
  expect(request.requirements).toContain(analysisRequirement);
  const result = inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin");
  expect(result).toMatchObject({ status: "CAPABILITIES_MAPPED", analysis: { status: "MAPPED" }, deliveryBodyBound: true, readyForPublication: false, scheduleActive: false });
  expect(result.remainingRequirements).not.toContain(analysisRequirement);
  expect(result.remainingRequirements.length).toBeGreaterThan(0);
  expect(result.mappedSteps.map(step => step.capability)).toEqual(["report", "report", "analysis", "analysis", "delivery"]);
  expect(result.mappedSteps[2]).toMatchObject({ resource: "invoices", sourceStepId: "invoice_report" });
});

test("partial analysis preserves its blocker and explicitly includes the remaining raw report", async () => {
  const { request, workflow, tools } = await analysisFixture();
  workflow.steps.splice(3, 1); workflow.steps[3].parameters.body = "{{invoice_analysis.structuredContent.text}} / {{order_report.structuredContent.summary}}";
  workflow.metadata.unresolved_requirements.push(analysisRequirement);
  const result = inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin");
  expect(result).toMatchObject({ status: "PARTIAL", analysis: { status: "UNRESOLVED" }, deliveryBodyBound: true });
  expect(result.remainingRequirements).toContain(analysisRequirement);
  workflow.metadata.unresolved_requirements = workflow.metadata.unresolved_requirements.filter((value: string) => value !== analysisRequirement);
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("Required unresolved outcome");
});

test.each(["omitted invoices", "omitted orders", "workflow input", "unknown output", "literal only", "malformed template"])("report delivery rejects %s instead of silently dropping requested content", async kind => {
  const { request, workflow, tools } = await fixture();
  const bodies: Record<string, string> = { "omitted invoices": "{{order_report.structuredContent.summary}}", "omitted orders": "{{invoice_report.structuredContent.summary}}",
    "workflow input": "{{input.reportStartAt}}", "unknown output": "{{unread.structuredContent.summary}}", "literal only": "Everything sent", "malformed template": "{{invoice_report.structuredContent.summary}} {{order_report.structuredContent.summary}} {{broken" };
  workflow.steps[2].parameters.body = bodies[kind];
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("delivery body must include every requested report");
});

test.each(["unrequested", "duplicate resource", "future input", "workflow input", "undeclared output", "missing contract", "missing schema", "oversized budget", "before all reads", "after delivery", "raw bypass", "missing analysis result"])("recurring analysis rejects %s before any run", async kind => {
  const data = await analysisFixture(), { workflow } = data;
  if (kind === "unrequested") { data.request = recurringDeliveryRequest(text)!; workflow.metadata.automation_request = recurringAutomationCandidateContext(data.request).automation_request; }
  if (kind === "duplicate resource") workflow.steps[3].input = "{{invoice_report.structuredContent.summary}}";
  if (kind === "future input") workflow.steps[2].input = "{{order_analysis.structuredContent.text}}";
  if (kind === "workflow input") workflow.steps[2].input = "{{input.reportStartAt}}";
  if (kind === "undeclared output") workflow.steps[2].input = "{{invoice_report.structuredContent.guessed}}";
  if (kind === "missing contract") data.tools[0]!.bridge_contract = undefined;
  if (kind === "missing schema") delete workflow.steps[2].output_schema;
  if (kind === "oversized budget") workflow.steps[2].max_output_tokens = 8193;
  if (kind === "before all reads") [workflow.steps[1], workflow.steps[2]] = [workflow.steps[2], workflow.steps[1]];
  if (kind === "after delivery") [workflow.steps[3], workflow.steps[4]] = [workflow.steps[4], workflow.steps[3]];
  if (kind === "raw bypass") workflow.steps[4].parameters.body = "{{invoice_report.structuredContent.summary}} {{order_report.structuredContent.summary}}";
  if (kind === "missing analysis result") workflow.steps[4].parameters.body = "{{order_analysis.structuredContent.text}}";
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), data.request, data.tools, "Platform Admin")).toThrow("Recurring automation candidate failed its server contract");
});

test("delivery reference extraction accepts literal framing, not malformed or excessive bindings", () => {
  expect(deliveryOutputReferences("Report {review}: {{a.structuredContent.text}}\n{{b.structuredContent.text}}")).toHaveLength(2);
  for (const value of ["{{a.structuredContent.text}} }}", "}} {{a.structuredContent.text}}", "{{a.structuredContent.text}} {{", "{{a + b}}", "{{a.structuredContent.text}}".repeat(17)])
    expect(deliveryOutputReferences(value)).toBeNull();
});

test("a named-person request may retain useful exact report steps but cannot invent a delivery recipient", async () => {
  const request = recurringDeliveryRequest("Get invoice and order details and email the report to my manager every day")!;
  const { tools, workflow } = await fixture();
  workflow.steps = workflow.steps.slice(0, 2);
  workflow.metadata.automation_request = recurringAutomationCandidateContext(request).automation_request;
  workflow.metadata.unresolved_requirements = request.requirements.filter((item: string) => !item.startsWith("Add exact reviewed ERP report") &&
    !item.startsWith("Add one exact reviewed ERP report"));
  const result = inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin");
  expect(result).toMatchObject({ status: "PARTIAL", recipientBound: false, deliveryBodyBound: false, scheduleActive: false });
  expect(result.mappedSteps.map(step => step.capability)).toEqual(["report", "report"]);
  expect(result.remainingRequirements).toContain("Resolve and confirm exactly one authorized recipient; do not guess a person's address.");
});

test("an authoritative directory resolution becomes the exact reviewed recipient candidate", async () => {
  const resolution = { profile: "recipient-directory-resolution/v1" as const, requestedLabel: "my manager", status: "RESOLVED" as const,
    source: "DIRECT_MANAGER" as const, userId: "manager", userName: "Maya Perera", email: "maya@example.test", reason: "Assigned active manager." };
  const request = recurringDeliveryRequest("Get invoice and order details and email the report to my manager every day", resolution)!;
  expect(request).toMatchObject({ requestedAddresses: ["maya@example.test"], recipientReference: "my manager", recipientResolution: resolution });
  expect(recurringAutomationCandidateContext(request).automation_request).toMatchObject({ requested_addresses: ["maya@example.test"], recipient_reference: "my manager",
    recipient_resolution: { source: "DIRECT_MANAGER", userId: "manager" } });
  expect(request.requirements).toContain("Confirm data-sharing permission for the exact recipient maya@example.test.");
});

test("a structurally valid report for the wrong business resource is rejected", async () => {
  const { request, tools, workflow } = await fixture();
  tools[0]!.report_coverage_contract!.business_resource = "customers";
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin"))
    .toThrow(/no exact reviewed requested business resource/);
});

test("composition requires the current role and a low or medium notification risk", async () => {
  const { request, tools, workflow } = await fixture();
  expect(hasRecurringCompositionCapability(request, tools, "Workflow Builder")).toBe(false);
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Workflow Builder"))
    .toThrow(/not granted to the current role/);
  const unsafeTools = tools.map(tool => ({ ...tool }));
  unsafeTools[2]!.risk_level = "high";
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, unsafeTools, "Platform Admin"))
    .toThrow(/not a reviewed report or email-delivery capability/);
});

test("weekly recurrence maps supported capabilities but retains an exact weekday requirement", async () => {
  const request = recurringDeliveryRequest("Get invoice and order details and email the report to manager@example.test every week")!;
  const { tools, workflow } = await fixture();
  workflow.metadata.automation_request = recurringAutomationCandidateContext(request).automation_request;
  workflow.metadata.unresolved_requirements.push("Confirm the exact local weekday for this weekly schedule; no weekday is inferred from the request.");
  const result = inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin");
  expect(result.status).toBe("CAPABILITIES_MAPPED");
  expect(result.remainingRequirements).toContain("Confirm the exact local weekday for this weekly schedule; no weekday is inferred from the request.");
});
