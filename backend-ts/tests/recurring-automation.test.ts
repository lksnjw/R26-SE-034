import { resolve } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { hasRecurringCompositionCapability, inspectRecurringAutomationCandidate, recurringAutomationCandidateContext,
  recurringDeliveryRequest } from "../src/delivery/recurring-automation.js";
import { RegistryService } from "../src/registry/service.js";
import { analysisRequirement, recurringAnalysisTools, reportAnalysis } from "./fixtures/recurring-analysis-tools.js";
import { deliveryOutputReferences } from "../src/delivery/recurring-analysis.js";
import { RECURRING_DECISION_REQUIREMENT } from "../src/delivery/recurring-decision-scopes.js";

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

test.each(["flat", "root reports", "branch-local"])("recurring %s can map one joint invoice/order analysis without dropping coverage", async placement => {
  const s = placement === "flat" ? await analysisFixture() : await conditionalFixture(true, placement === "branch-local");
  const joint = { ...s.workflow.steps[2], id: "joint_analysis", instruction: "Compare the confirmed invoice and related order evidence together; state limitations",
    input: { invoices: "{{invoice_report.structuredContent.summary}}", orders: "{{order_report.structuredContent.summary}}" } };
  s.workflow.steps.splice(2, 2, joint); s.workflow.steps[3].parameters.body = "{{joint_analysis.structuredContent.text}}";
  if (s.workflow.metadata.controlFlow) {
    const gate = s.workflow.metadata.controlFlow.root.nodes.find((node: any) => node.kind === "if");
    gate.then.nodes = s.workflow.steps.slice(placement === "branch-local" ? 0 : 2).map((step: any) => ({ kind: "action", nodeId: step.id }));
  }
  const result = inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin");
  expect(result).toMatchObject({ status: "CAPABILITIES_MAPPED", analysis: { status: "MAPPED" }, deliveryBodyBound: true, scheduleActive: false, readyForPublication: false });
  expect(result.mappedSteps.filter(value => value.capability === "analysis")).toEqual([
    { stepId: "joint_analysis", capability: "analysis", tool: "Bounded analysis", resource: "invoices", sourceStepId: "invoice_report" },
    { stepId: "joint_analysis", capability: "analysis", tool: "Bounded analysis", resource: "orders", sourceStepId: "order_report" },
  ]);
  const wrong = structuredClone(s.workflow); wrong.steps[2].input.orders = "{{invoice_report.structuredContent.summary}}";
  expect(() => inspectRecurringAutomationCandidate(stringify(wrong), s.request, s.tools, "Platform Admin")).toThrow(/Required unresolved outcome/);
});

test("joint recurring analysis does not permit overlapping per-resource analysis or unrelated model sources", async () => {
  const s = await analysisFixture();
  s.workflow.steps[2].input = { invoices: "{{invoice_report.structuredContent.summary}}", orders: "{{order_report.structuredContent.summary}}" };
  expect(() => inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toThrow(/duplicate analysis/);
  s.workflow.steps[2].input.orders = "{{order_analysis.structuredContent.text}}";
  expect(() => inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toThrow(/declared report output|forward/);
});

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

async function conditionalFixture(withAnalysis = false, branchReports = false, bothBranches = false) {
  const source = withAnalysis ? await analysisFixture() : await fixture();
  const original = `${withAnalysis ? "Analyse" : "Get"} invoice and order reports and email manager@example.test daily if the declared sendReport boolean workflow input is true; ${bothBranches ? "otherwise obtain the alternative invoice/order reports and email them to the same recipient" : "otherwise do not deliver"}.`;
  const request = recurringDeliveryRequest(original)!, workflow = source.workflow;
  workflow.metadata.automation_request = recurringAutomationCandidateContext(request).automation_request;
  workflow.metadata.unresolved_requirements.push(RECURRING_DECISION_REQUIREMENT);
  workflow.trigger.config.inputSchema.properties.sendReport = { type: "boolean" }; workflow.trigger.config.inputSchema.required.push("sendReport");
  const action = (nodeId: string) => ({ kind: "action", nodeId }), seq = (...nodes: any[]) => ({ kind: "sequence", nodes });
  for (const step of workflow.steps) if (step.kind === "analysis") step.data_class = "restricted";
  let root: any;
  if (branchReports) {
    const yes = workflow.steps, no = bothBranches ? structuredClone(yes).map((step: any) => {
      const old = step.id; step.id = `no_${old}`;
      if (step.input) step.input = step.input.replace(/\{\{([A-Za-z][A-Za-z0-9_-]*)\./g, "{{no_$1.");
      for (const key of Object.keys(step.parameters ?? {})) if (typeof step.parameters[key] === "string")
        step.parameters[key] = step.parameters[key].replace(/\{\{([A-Za-z][A-Za-z0-9_-]*)\./g, (match: string, id: string) => id === "input" ? match : `{{no_${id}.`);
      return step;
    }) : [];
    workflow.steps = [...yes, ...no]; root = seq({ kind: "if", id: "send_gate", predicate: { kind: "ref", source: "workflowInput", path: ["sendReport"] },
      then: seq(...yes.map((step: any) => action(step.id))), else: seq(...no.map((step: any) => action(step.id))) });
  } else {
    root = seq(...workflow.steps.slice(0, 2).map((step: any) => action(step.id)), { kind: "if", id: "send_gate",
      predicate: { kind: "ref", source: "workflowInput", path: ["sendReport"] }, then: seq(...workflow.steps.slice(2).map((step: any) => action(step.id))), else: seq() });
  }
  workflow.metadata.controlFlow = { schemaVersion: "read-control-flow/v1", root };
  return { ...source, request, workflow };
}

test.each([false, true].flatMap(analysis => [[analysis, false, false], [analysis, true, false], [analysis, true, true]] as const))(
  "conditional recurring draft analysis=%s branchReports=%s bothBranches=%s validates exact scopes without granting readiness", async (analysis, local, both) => {
    const { request, workflow, tools } = await conditionalFixture(analysis, local, both);
    const result = inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin");
    expect(result).toMatchObject({ status: "CAPABILITIES_MAPPED", relatedRecords: { status: "MATCHED" }, deliveryBodyBound: true, recipientBound: true,
      analysis: { status: analysis ? "MAPPED" : "NOT_REQUESTED" }, readyForPublication: false, scheduleActive: false });
    expect(result.remainingRequirements).toContain(RECURRING_DECISION_REQUIREMENT);
    expect(result.mappedSteps).toHaveLength((analysis ? 5 : 3) * (both ? 2 : 1));
    expect(recurringAutomationCandidateContext(request).automation_request).toMatchObject({ decision_request: { originalRequest: request.decisionRequest!.originalRequest }, schedule_active: false });
  });

test("conditional text without a tree remains partial and retains original intent instead of claiming unconditional equivalence", async () => {
  const { request, workflow, tools } = await conditionalFixture(); delete workflow.metadata.controlFlow;
  const result = inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin");
  expect(result.status).toBe("PARTIAL"); expect(result.remainingRequirements).toContain(RECURRING_DECISION_REQUIREMENT);
  workflow.metadata.unresolved_requirements = workflow.metadata.unresolved_requirements.filter((item: string) => item !== RECURRING_DECISION_REQUIREMENT);
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("Required unresolved outcome");
});

test.each(["literal predicate", "missing predicate", "sibling report", "parent after join", "one wrong recipient", "one wrong relation", "two deliveries", "forgotten request", "dropped review"])(
  "conditional recurring inspector rejects %s without borrowing another branch's mapping", async damage => {
    const { request, workflow, tools } = await conditionalFixture(true, true, true), gate = workflow.metadata.controlFlow.root.nodes[0];
    if (damage === "literal predicate") gate.predicate = { kind: "literal", value: true };
    if (damage === "missing predicate") gate.predicate.path = ["invented"];
    if (damage === "sibling report") workflow.steps[7].input = "{{invoice_report.structuredContent.summary}}";
    if (damage === "parent after join") {
      const send = workflow.steps.pop(); gate.else.nodes.pop(); workflow.metadata.controlFlow.root.nodes.push({ kind: "action", nodeId: send.id });
    }
    if (damage === "one wrong recipient") workflow.steps[9].parameters.recipient = "wrong@example.test";
    if (damage === "one wrong relation") workflow.steps[6].parameters.orderIds = ["invented-order"];
    if (damage === "two deliveries") {
      const second = { ...structuredClone(workflow.steps[4]), id: "duplicate_send" }; workflow.steps.splice(5, 0, second); gate.then.nodes.push({ kind: "action", nodeId: second.id });
    }
    if (damage === "forgotten request") delete workflow.metadata.automation_request.decision_request;
    if (damage === "dropped review") workflow.metadata.unresolved_requirements = workflow.metadata.unresolved_requirements.filter((item: string) => item !== RECURRING_DECISION_REQUIREMENT);
    expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("Recurring automation candidate failed its server contract");
  });

test("unrequested recurring decisions are not invented as a way to suppress delivery", async () => {
  const { workflow, tools } = await conditionalFixture(), request = recurringDeliveryRequest(text)!;
  workflow.metadata.automation_request = recurringAutomationCandidateContext(request).automation_request;
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("without a requested conditional outcome");
});

test("two sequential decisions cannot each send the same report on one possible path", async () => {
  const { request, workflow, tools } = await conditionalFixture();
  const duplicate = { ...structuredClone(workflow.steps[2]), id: "second_delivery" }; workflow.steps.push(duplicate);
  workflow.metadata.controlFlow.root.nodes.push({ kind: "if", id: "second_gate", predicate: { kind: "ref", source: "workflowInput", path: ["sendReport"] },
    then: { kind: "sequence", nodes: [{ kind: "action", nodeId: duplicate.id }] }, else: { kind: "sequence", nodes: [] } });
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("multiple delivery effects on one possible path");
});

test.each(["page", "cursor"])("recurring authoring cannot override server-owned %s traversal", async parameter => {
  const { request, workflow, tools } = await fixture();
  tools[0]!.report_coverage_contract!.pagination = (parameter === "page" ? { profile: "page-number/v1", page_parameter: parameter } :
    { profile: "opaque-cursor/v1", cursor_parameter: parameter }) as any;
  workflow.steps[0].parameters[parameter] = parameter === "page" ? 2 : "invented-cursor";
  expect(() => inspectRecurringAutomationCandidate(stringify(workflow), request, tools, "Platform Admin")).toThrow("may not override server-owned pagination");
});
