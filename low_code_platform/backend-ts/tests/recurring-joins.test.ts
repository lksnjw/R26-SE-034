import { resolve } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { inspectRecurringAutomationCandidate, recurringDeliveryRequest, recurringAutomationCandidateContext } from "../src/delivery/recurring-automation.js";
import { RECURRING_DECISION_REQUIREMENT } from "../src/delivery/recurring-decision-scopes.js";
import { RecurringPathLogic } from "../src/delivery/recurring-path-logic.js";
import { recurringAnalysisTools, analysisRequirement } from "./fixtures/recurring-analysis-tools.js";
import { recurringCrossJoinWorkflow, recurringJoinWorkflow, type RecurringJoinMode } from "./fixtures/recurring-join-workflow.js";
import { applyWorkflowCommand, selectedNodePatchCommand, selectedNodePatchSchema } from "../src/workflows/commands.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";

async function fixture(mode: RecurringJoinMode = "reports") {
  const registry = await RegistryService.load(resolve("tests/fixtures/recurring-tools.json"), resolve("tests/fixtures/rules.json"));
  const tools = recurringAnalysisTools(registry.snapshot().tools);
  return { tools, ...recurringJoinWorkflow(tools, mode) };
}
async function crossJoinFixture() {
  const { tools } = await fixture();
  return { tools, ...recurringCrossJoinWorkflow(tools) };
}
test("recurring related report may follow exact selected primary keys across the join without readiness or effect authority", async () => {
  const s = await crossJoinFixture();
  expect(inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toMatchObject({
    status: "CAPABILITIES_MAPPED", relatedRecords: { status: "MATCHED", relationName: "invoice-orders" }, deliveryBodyBound: true, readyForPublication: false, scheduleActive: false,
  });
});

test("selected-condition typed-output repair preserves the complete cross-join request and exact key provenance", async () => {
  const s = await crossJoinFixture(), original = structuredClone(s.workflow), selected = s.workflow.metadata.controlFlow.root.nodes[0], merge = selected.merge;
  delete selected.merge;
  const patch = selectedNodePatchSchema(selected).parse({ merge }), command = selectedNodePatchCommand(selected, patch);
  const yaml = applyWorkflowCommand(stringify(s.workflow), command), next = parseWorkflowYAMLStrict(yaml);
  expect(next.steps).toEqual(original.steps); expect(next.metadata!.controlFlow).toEqual(original.metadata.controlFlow);
  expect(inspectRecurringAutomationCandidate(yaml, s.request, s.tools, "Platform Admin")).toMatchObject({ status: "CAPABILITIES_MAPPED", readyForPublication: false, scheduleActive: false });
});
test.each(["literal", "sibling", "wrong path", "model"])("selected-condition patch schema does not authorize counterfeit cross-join %s keys", async damage => {
  const s = await crossJoinFixture(), node = s.workflow.metadata.controlFlow.root.nodes[0], merge = structuredClone(node.merge), fields = merge.else.fields;
  if (damage === "literal") fields.orderIds = { kind: "array", items: [{ kind: "literal", value: "invented-order" }] };
  if (damage === "sibling") fields.orderIds.nodeId = "yes_invoices";
  if (damage === "wrong path") fields.orderIds.path = ["structuredContent", "items"];
  if (damage === "model") fields.orderIds.nodeId = "invented_analysis";
  const patch = selectedNodePatchSchema(node).parse({ merge }), yaml = applyWorkflowCommand(stringify(s.workflow), selectedNodePatchCommand(node, patch));
  // JSON shape acceptance is deliberately not semantic or business proof.
  expect(() => inspectRecurringAutomationCandidate(yaml, s.request, s.tools, "Platform Admin")).toThrow("Recurring automation candidate failed its server contract");
  expect(s.workflow.metadata.controlFlow.root.nodes[0]).toEqual(node);
});
test.each(["literal", "sibling", "wrong path", "model"])("recurring joined key proposal denies unselected %s lineage", async damage => {
  const s = await crossJoinFixture(), fields = s.workflow.metadata.controlFlow.root.nodes[0].merge.else.fields;
  if (damage === "literal") fields.orderIds = { kind: "array", items: ["order-1"].map(value => ({ kind: "literal", value })) };
  if (damage === "sibling") fields.orderIds.nodeId = "yes_invoices";
  if (damage === "wrong path") fields.orderIds.path = ["structuredContent", "items"];
  if (damage === "model") fields.orderIds.nodeId = "invented_analysis";
  expect(() => inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toThrow("Recurring automation candidate failed its server contract");
});

test.each(["reports", "branch-analysis", "joined-analysis"] as const)("recurring joined %s proves every alternative without authorizing publication, schedule or delivery", async mode => {
  const s = await fixture(mode), result = inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin");
  expect(result).toMatchObject({ status: "CAPABILITIES_MAPPED", deliveryBodyBound: true, recipientBound: true, relatedRecords: { status: "MATCHED", relationName: "invoice-orders" },
    analysis: { status: mode === "reports" ? "NOT_REQUESTED" : "MAPPED" }, readyForPublication: false, scheduleActive: false });
  expect(result.remainingRequirements).toContain(RECURRING_DECISION_REQUIREMENT);
  if (mode !== "reports") expect(result.mappedSteps.filter(step => step.capability === "analysis")).toHaveLength(4);
});
test.each(["missing No report", "wrong No relation", "wrong No window", "literal No invoice", "resource swap", "omitted invoice body", "wrong recipient", "direct branch escape", "wrong original intent", "dropped review"])(
  "recurring joined proposal rejects %s, including unselected-path failures", async damage => {
    const s = await fixture(), gate = s.workflow.metadata.controlFlow.root.nodes[0], email = s.workflow.steps.at(-1);
    if (damage === "missing No report") { s.workflow.steps = s.workflow.steps.filter((step: any) => step.id !== "no_invoices"); gate.else.nodes.shift(); gate.merge.else.fields.invoices = { kind: "literal", value: "Not a report" }; s.workflow.steps.find((step: any) => step.id === "no_orders").parameters.orderIds = ["invented"]; }
    if (damage === "wrong No relation") s.workflow.steps.find((step: any) => step.id === "no_orders").parameters.orderIds = ["invented"];
    if (damage === "wrong No window") s.workflow.steps.find((step: any) => step.id === "no_invoices").parameters.startAt = "2026-01-01T00:00:00Z";
    if (damage === "literal No invoice") gate.merge.else.fields.invoices = { kind: "literal", value: "Looks like a confirmed invoice report" };
    if (damage === "resource swap") gate.merge.else.fields.invoices = structuredClone(gate.merge.else.fields.orders);
    if (damage === "omitted invoice body") email.parameters.body = "{{gate.value.orders}}";
    if (damage === "wrong recipient") email.parameters.recipient = "invented@example.test";
    if (damage === "direct branch escape") email.parameters.body = "{{yes_invoices.structuredContent.summary}} {{yes_orders.structuredContent.summary}}";
    if (damage === "wrong original intent") s.workflow.metadata.automation_request.decision_request.originalRequest = "Send every day regardless";
    if (damage === "dropped review") s.workflow.metadata.unresolved_requirements = s.workflow.metadata.unresolved_requirements.filter((item: string) => item !== RECURRING_DECISION_REQUIREMENT);
    expect(() => inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toThrow("Recurring automation candidate failed its server contract");
  });
test.each(["raw bypass", "wrong field", "literal alternative", "duplicate analysis", "analysis of analysis"])("joined analysis rejects %s instead of claiming all requested resources were analysed", async damage => {
  const s = await fixture("joined-analysis"), gate = s.workflow.metadata.controlFlow.root.nodes[0], analysis = s.workflow.steps.find((step: any) => step.kind === "analysis");
  if (damage === "raw bypass") s.workflow.steps.at(-1).parameters.body = "{{gate.value.invoices}} {{gate.value.orders}}";
  if (damage === "wrong field") analysis.input.orders = "{{gate.value.invoices}}";
  if (damage === "literal alternative") gate.merge.else.fields.orders = { kind: "literal", value: "No evidence" };
  if (damage === "duplicate analysis" || damage === "analysis of analysis") {
    const second = { ...structuredClone(analysis), id: "second_analysis" };
    if (damage === "analysis of analysis") second.input = "{{joined_analysis.structuredContent.text}}";
    s.workflow.steps.splice(s.workflow.steps.length - 1, 0, second);
    s.workflow.metadata.controlFlow.root.nodes.splice(2, 0, { kind: "action", nodeId: second.id });
  }
  expect(() => inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toThrow("Recurring automation candidate failed its server contract");
});
test("partial raw-content proposal keeps missing analysis unresolved and cannot claim readiness", async () => {
  const s = await fixture("joined-analysis"); s.workflow.steps.at(-1).parameters.body = "{{gate.value.invoices}} {{gate.value.orders}}";
  s.workflow.metadata.unresolved_requirements.push(analysisRequirement);
  expect(inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toMatchObject({ status: "PARTIAL", deliveryBodyBound: true, analysis: { status: "UNRESOLVED" }, readyForPublication: false });
});
test("a terminated No branch cannot supply content, merge, or execute the later shared delivery", async () => {
  const s = await fixture(), gate = s.workflow.metadata.controlFlow.root.nodes[0];
  s.request = recurringDeliveryRequest("Get invoice and related order reports and email manager@example.test daily if the declared usePrimary boolean is true; otherwise return false and do not deliver.")!;
  s.workflow.metadata.automation_request = structuredClone(recurringAutomationCandidateContext(s.request).automation_request);
  s.workflow.steps = s.workflow.steps.filter((step: any) => !step.id.startsWith("no_"));
  gate.else.nodes = [{ kind: "return", id: "no_delivery", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } }];
  gate.merge.else = { kind: "object", fields: { invoices: { kind: "literal", value: "Explicit no delivery" }, orders: { kind: "literal", value: "" } } };
  // Both mappings retain the declared type even though No terminates first.
  expect(inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toMatchObject({ deliveryBodyBound: true, status: "CAPABILITIES_MAPPED" });
});
test("nested object joins trace only the selected field, not unrelated report provenance", async () => {
  const s = await fixture(), gate = s.workflow.metadata.controlFlow.root.nodes[0];
  gate.merge.schema = { type: "object", properties: { payload: gate.merge.schema }, required: ["payload"], additionalProperties: false };
  gate.merge.then = { kind: "object", fields: { payload: gate.merge.then } }; gate.merge.else = { kind: "object", fields: { payload: gate.merge.else } };
  s.workflow.steps.at(-1).parameters.body = "{{gate.value.payload.invoices}} {{gate.value.payload.orders}}";
  expect(inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin").deliveryBodyBound).toBe(true);
  s.workflow.steps.at(-1).parameters.body = "{{gate.value.payload.orders}}";
  expect(() => inspectRecurringAutomationCandidate(stringify(s.workflow), s.request, s.tools, "Platform Admin")).toThrow("delivery body must include every requested report");
});
test("shared decision proof reduces 100 independent choices without enumerating their Boolean product", () => {
  const ids = Array.from({ length: 100 }, (_, i) => "gate_" + i), logic = new RecurringPathLogic(ids);
  let all = 1;
  for (const id of ids) { const variable = logic.variable(id); all = logic.and(all, logic.or(variable, logic.not(variable))); }
  expect(all).toBe(1); expect(logic.stateCount).toBe(200);
  const a = logic.variable(ids[0]!), b = logic.variable(ids[1]!);
  expect(logic.implies(logic.and(a, b), a)).toBe(true); expect(logic.implies(a, b)).toBe(false);
  expect(logic.and(a, logic.not(a))).toBe(0);
});
test("provenance refuses unknown, duplicate and over-bound decision identities", () => {
  expect(() => new RecurringPathLogic(["gate", "gate"])).toThrow("unique decision bound");
  expect(() => new RecurringPathLogic(Array.from({ length: 101 }, (_, i) => "gate_" + i))).toThrow("unique decision bound");
  expect(() => new RecurringPathLogic(["gate"]).variable("invented")).toThrow("unknown decision");
});
