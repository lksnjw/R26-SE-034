import { expect, test, vi } from "vitest";
import { recurringJoinWorkflow, type RecurringJoinMode } from "./fixtures/recurring-join-workflow.js";
// @ts-expect-error Local JavaScript qualification entrypoint has no declarations
import { prepareRecurringAnalysisFixture, reviewFixtureAnalysisEgress } from "../scripts/firestore-recurring-analysis.mjs";

// These protect the qualification assertions, not model quality or application
// authorization. The physical campaign separately exercises real HTTP/records.
function fixture(mode: RecurringJoinMode = "joined-analysis", selected = true) {
  const tools: any[] = ["invoices", "orders"].map(resource => ({ name: resource,
    report_coverage_contract: { business_resource: resource }, bridge_contract: { output_schema: { type: "object", properties: { marker: { type: "string" } } } } }));
  tools.push({ name: "email", email_delivery_contract: {} });
  const { workflow } = recurringJoinWorkflow(tools, mode, "reportId"), own = selected ? "yes" : "no";
  const invoices = { complete: true, itemCount: 2, orderIds: ["order-2", "order-1"], items: [{ invoiceId: "i-1", orderId: "order-1" }, { invoiceId: "i-2", orderId: "order-2" }] };
  const orders = { complete: true, itemCount: 2, items: [{ orderId: "order-1", total: 10 }, { orderId: "order-2", total: 20 }] };
  const run: any = { stepOutputs: { [own + "_invoices"]: { structuredContent: invoices }, [own + "_orders"]: { structuredContent: orders } },
    reportCoverages: { [own + "_invoices"]: {}, [own + "_orders"]: {} }, valueOutputs: { gate: { value: { invoices, orders } } },
    readProgress: { decisions: { gate: { selected: selected ? "then" : "else" } }, values: { gate: { status: "DONE" } } } };
  const verify = prepareRecurringAnalysisFixture(workflow, mode, selected, tools);
  const node = workflow.steps.find((step: any) => step.kind === "analysis" && (mode === "joined-analysis" || step.id.startsWith(own)));
  const data = { INSTRUCTION: node.instruction, OUTPUT_SCHEMA: node.output_schema, INPUT: mode === "joined-analysis" ? structuredClone({ invoices, orders }) : structuredClone(invoices) };
  return { workflow, own, run, data, verify };
}

test.each([true, false])("joined analysis qualification checks exact complete selected report objects: %s", selected => {
  const s = fixture("joined-analysis", selected), result = s.verify(s.data, s.run);
  expect(result).toEqual({ nodeId: "joined_analysis", input: s.data.INPUT, output: { text: "joined_analysis: qualified 2 invoices and 2 related orders" } });
  expect(s.workflow.metadata.controlFlow.root.nodes[0].merge.then.fields.invoices.path).toEqual(["structuredContent"]);
  expect(s.workflow.steps.find((step: any) => step.kind === "analysis").data_class).toBe("restricted");
});
test.each([true, false])("branch analysis qualification uses only its selected report and distinct source: %s", selected => {
  const s = fixture("branch-analysis", selected), result = s.verify(s.data, s.run);
  expect(result.nodeId).toBe(s.own + "_invoice_analysis"); expect(result.input).toEqual(s.run.stepOutputs[s.own + "_invoices"].structuredContent);
  const order = s.workflow.steps.find((step: any) => step.id === s.own + "_order_analysis");
  s.data.INSTRUCTION = order.instruction; s.data.INPUT = s.run.stepOutputs[s.own + "_orders"].structuredContent;
  expect(s.verify(s.data, s.run).output.text).toBe(s.own + "_order_analysis: qualified 2 related orders");
});
test("qualification treats reloaded receipt maps as unordered, while retaining exact report membership", () => {
  const s = fixture(); s.run.reportCoverages = { yes_orders: {}, yes_invoices: {} };
  expect(s.verify(s.data, s.run).nodeId).toBe("joined_analysis");
  s.run.reportCoverages.no_invoices = {};
  expect(() => s.verify(s.data, s.run)).toThrow();
});
test.each(["unknown instruction", "wrong schema", "wrong branch", "pending join", "wrong join value", "missing receipt", "incomplete report", "wrong count", "wrong related keys", "wrong named input"])(
  "qualification rejects corrupted evidence instead of claiming verified analysis: %s", damage => {
    const s = fixture();
    if (damage === "unknown instruction") s.data.INSTRUCTION = "Invent a successful summary";
    if (damage === "wrong schema") s.data.OUTPUT_SCHEMA = { type: "boolean" };
    if (damage === "wrong branch") s.run.readProgress.decisions.gate.selected = "else";
    if (damage === "pending join") s.run.readProgress.values.gate.status = "RUNNING";
    if (damage === "wrong join value") s.run.valueOutputs.gate.value = { invoices: "Plausible prose", orders: "Not evidence" };
    if (damage === "missing receipt") delete s.run.reportCoverages.yes_orders;
    if (damage === "incomplete report") s.run.stepOutputs.yes_invoices.structuredContent.complete = false;
    if (damage === "wrong count") s.run.stepOutputs.yes_invoices.structuredContent.itemCount = 1;
    if (damage === "wrong related keys") s.run.stepOutputs.yes_orders.structuredContent.items[0].orderId = "unrelated";
    if (damage === "wrong named input") (s.data.INPUT as any).orders = (s.data.INPUT as any).invoices;
    expect(() => s.verify(s.data, s.run)).toThrow();
  });
test("fixture egress review requires confirmation, persists through reboot and restores prior purposes without inference", async () => {
  let provider: any = { id: "fixture", active: true, name: "Fixture", type: "openai_compatible", baseUrl: "https://provider.fixture.example.test/v1",
    model: "fixture-a", additionalModels: ["fixture-b"], temperature: 0, revision: 1, apiKey: "synthetic-only",
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://provider.fixture.example.test", runtimeAnalysisDataClasses: ["internal"],
      runtimeAgentDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-08T00:00:00Z", reviewedBy: { id: "owner", name: "owner" } } };
  let configuration = structuredClone(provider); const models: string[] = [];
  const restart = vi.fn(async () => { configuration = structuredClone(provider); });
  const request = vi.fn(async (method: string, url: string, body: any, status: number) => {
    expect(method).toBe("PUT"); expect(url).toBe("/api/providers/fixture"); expect(body.apiKey).toBeUndefined();
    expect(body.egressPolicy.runtimeAgentDataClasses).toEqual([]); expect(body.egressPolicy.interactiveDataClasses).toEqual(["restricted"]);
    if (!body.egressPolicy.confirmed) { expect(status).toBe(422); return { data: null }; }
    expect(status).toBe(200); provider = { ...provider, revision: provider.revision + 1, egressPolicy: { ...provider.egressPolicy,
      runtimeAnalysisDataClasses: structuredClone(body.egressPolicy.runtimeAnalysisDataClasses) } };
    const { apiKey: _secret, ...publicProvider } = provider; return { data: publicProvider };
  });
  const restore = await reviewFixtureAnalysisEgress({ getRepository: () => ({ snapshot: async () => ({ providers: { fixture: structuredClone(provider) } }) }),
    getServices: () => ({ providerRuntime: { configuration } }), restart, request, models });
  expect(configuration.egressPolicy.runtimeAnalysisDataClasses).toEqual(["internal", "restricted"]);
  await restore(); expect(configuration.egressPolicy.runtimeAnalysisDataClasses).toEqual(["internal"]);
  expect(restart).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(3); expect(models).toEqual([]); expect(provider.revision).toBe(3);
});
