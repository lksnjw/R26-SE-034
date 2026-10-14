import type { ToolDefinition } from "../../src/registry/schemas.js";
import { recurringAutomationCandidateContext, recurringDeliveryRequest } from "../../src/delivery/recurring-automation.js";
import { reportAnalysis } from "./recurring-analysis-tools.js";

export type RecurringJoinMode = "reports" | "branch-analysis" | "joined-analysis";
export function recurringCrossJoinWorkflow(tools: readonly ToolDefinition[], reportField = "summary") {
  const candidate = recurringJoinWorkflow(tools, "reports", reportField), workflow = candidate.workflow, gate = workflow.metadata.controlFlow.root.nodes[0];
  const order = { ...workflow.steps.find((step: any) => step.id === "yes_orders"), id: "shared_orders" };
  order.parameters = { ...order.parameters, orderIds: "{{gate.value.orderIds}}" };
  workflow.steps = workflow.steps.filter((step: any) => !step.id.endsWith("_orders"));
  for (const branch of ["then", "else"]) gate[branch].nodes = gate[branch].nodes.filter((node: any) => !node.nodeId.endsWith("_orders"));
  gate.merge.schema = { type: "object", properties: { invoices: { type: "string" }, orderIds: { type: "array", items: { type: "string" }, maxItems: 100 } }, required: ["invoices", "orderIds"], additionalProperties: false };
  for (const [branch, id] of [["then", "yes_invoices"], ["else", "no_invoices"]] as const)
    gate.merge[branch] = { kind: "object", fields: { invoices: { kind: "ref", source: "nodeOutput", nodeId: id, path: ["structuredContent", reportField] },
      orderIds: { kind: "ref", source: "nodeOutput", nodeId: id, path: ["structuredContent", "orderIds"] } } };
  workflow.steps.splice(2, 0, order); workflow.metadata.controlFlow.root.nodes.splice(1, 0, { kind: "action", nodeId: order.id });
  workflow.steps.at(-1).parameters.body = "Invoices: {{gate.value.invoices}}\nOrders: {{shared_orders.structuredContent." + reportField + "}}";
  return candidate;
}
export function recurringJoinWorkflow(tools: readonly ToolDefinition[], mode: RecurringJoinMode = "reports", reportField = "summary") {
  const text = (mode === "reports" ? "Get" : "Analyse") + " invoice and related order reports daily: if the declared usePrimary boolean is true use the primary report branch, otherwise use the alternative report branch. Join the chosen invoice and order content, then email both to manager@example.test and return its confirmed acceptance status.";
  const request = recurringDeliveryRequest(text)!, steps: any[] = [];
  const action = (nodeId: string) => ({ kind: "action", nodeId }), seq = (...nodes: any[]) => ({ kind: "sequence", nodes });
  const ref = (nodeId: string, field: string) => ({ kind: "ref", source: "nodeOutput", nodeId, path: ["structuredContent", field] });
  const report = tools.find(tool => tool.report_coverage_contract?.business_resource === "invoices")!, related = tools.find(tool => tool.report_coverage_contract?.business_resource === "orders")!;
  const email = tools.find(tool => tool.email_delivery_contract)!;
  const branch = (prefix: string) => {
    const invoiceId = prefix + "_invoices", orderId = prefix + "_orders";
    steps.push({ id: invoiceId, action: report.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
      { id: orderId, action: related.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}", orderIds: "{{" + invoiceId + ".structuredContent.orderIds}}" } });
    const nodes = [action(invoiceId), action(orderId)];
    if (mode === "branch-analysis") {
      steps.push(reportAnalysis(prefix + "_invoice_analysis", invoiceId), reportAnalysis(prefix + "_order_analysis", orderId));
      nodes.push(action(prefix + "_invoice_analysis"), action(prefix + "_order_analysis"));
    }
    return { tree: seq(...nodes), value: { kind: "object", fields: {
      invoices: ref(mode === "branch-analysis" ? prefix + "_invoice_analysis" : invoiceId, mode === "branch-analysis" ? "text" : reportField),
      orders: ref(mode === "branch-analysis" ? prefix + "_order_analysis" : orderId, mode === "branch-analysis" ? "text" : reportField),
    } } };
  };
  const yes = branch("yes"), no = branch("no"), nodes: any[] = [{ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["usePrimary"] }, then: yes.tree, else: no.tree,
    merge: { schema: { type: "object", properties: { invoices: { type: "string" }, orders: { type: "string" } }, required: ["invoices", "orders"], additionalProperties: false }, then: yes.value, else: no.value } }];
  let body = "Invoices: {{gate.value.invoices}}\nOrders: {{gate.value.orders}}";
  if (mode === "joined-analysis") {
    const analysis = reportAnalysis("joined_analysis", "unused");
    steps.push({ ...analysis, input: { invoices: "{{gate.value.invoices}}", orders: "{{gate.value.orders}}" } }); nodes.push(action(analysis.id)); body = "{{joined_analysis.structuredContent.text}}";
  }
  steps.push({ id: "deliver", action: email.name, parameters: { recipient: "manager@example.test", subject: "Daily chosen invoice and order report", body } });
  nodes.push(action("deliver"), { kind: "return", id: "answer", output: { schema: { type: "boolean" }, value: ref("deliver", "accepted") } });
  const unresolved = request.requirements.filter(item => !item.startsWith("Add one exact reviewed ERP report") && !item.startsWith("Add one exact reviewed email") &&
    !(mode !== "reports" && item.startsWith("Add a supported bounded analysis")));
  const workflow: any = { name: "Chosen daily reports", description: "Typed joined report proposal, inactive until explicit review and activation.",
    trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" }, usePrimary: { type: "boolean" } },
      required: ["reportStartAt", "reportEndAt", "usePrimary"], additionalProperties: false } } }, steps,
    metadata: { automation_request: structuredClone(recurringAutomationCandidateContext(request).automation_request), unresolved_requirements: unresolved, controlFlow: { schemaVersion: "read-control-flow/v2", root: seq(...nodes) } } };
  return { text, request, workflow };
}
