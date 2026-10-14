import assert from "node:assert/strict";

// Called only by the credential-free demo emulator campaign. No real provider
// review or inference is performed: these are intentional synthetic admin edits.
export async function reviewFixtureAnalysisEgress({ getRepository, getServices, restart, request, models }) {
  const original = Object.values((await getRepository().snapshot()).providers).find(provider => provider.active);
  assert.ok(original); const baseline = models.length;
  const command = classes => ({ name: original.name, type: original.type, baseUrl: original.baseUrl,
    model: original.model, additionalModels: original.additionalModels, temperature: original.temperature,
    egressPolicy: { approvedOrigin: original.egressPolicy.approvedOrigin, runtimeAnalysisDataClasses: classes,
      runtimeAgentDataClasses: original.egressPolicy.runtimeAgentDataClasses, interactiveDataClasses: original.egressPolicy.interactiveDataClasses } });
  const reviewedClasses = [...new Set([...original.egressPolicy.runtimeAnalysisDataClasses, "restricted"])];
  await request("PUT", "/api/providers/" + original.id, command(reviewedClasses), 422);
  assert.deepEqual((await getRepository().snapshot()).providers[original.id], original); assert.equal(models.length, baseline);
  const approved = (await request("PUT", "/api/providers/" + original.id, {
    ...command(reviewedClasses), egressPolicy: { ...command(reviewedClasses).egressPolicy, confirmed: true },
  }, 200)).data;
  assert.equal(approved.apiKey, undefined); assert.equal(approved.revision, original.revision + 1);
  await restart();
  assert.equal(getServices().providerRuntime.configuration.id, original.id);
  assert.deepEqual(getServices().providerRuntime.configuration.egressPolicy, approved.egressPolicy);
  assert.equal(models.length, baseline);
  return async () => {
    const restored = (await request("PUT", "/api/providers/" + original.id, { ...command(original.egressPolicy.runtimeAnalysisDataClasses),
      egressPolicy: { ...command(original.egressPolicy.runtimeAnalysisDataClasses).egressPolicy, confirmed: true },
    }, 200)).data;
    const before = models.length; await restart();
    assert.deepEqual(getServices().providerRuntime.configuration.egressPolicy, restored.egressPolicy);
    assert.deepEqual(restored.egressPolicy.runtimeAnalysisDataClasses, original.egressPolicy.runtimeAnalysisDataClasses);
    assert.equal(models.length, before);
  };
}

export function prepareRecurringAnalysisFixture(workflow, mode, selected, tools) {
  const analyses = workflow.steps.filter(step => step.kind === "analysis"), own = selected ? "yes" : "no";
  for (const step of analyses) {
    step.instruction = "LOCAL recurring calendar analysis " + mode + "/" + step.id;
    if (mode === "branch-analysis") step.input = step.input.replace(".structuredContent.summary}}", ".structuredContent}}");
  }
  if (mode === "joined-analysis") {
    const gate = workflow.metadata.controlFlow.root.nodes[0];
    for (const resource of ["invoices", "orders"]) {
      gate.merge.schema.properties[resource] = structuredClone(tools.find(tool => tool.report_coverage_contract?.business_resource === resource).bridge_contract.output_schema);
      gate.merge.then.fields[resource].path = ["structuredContent"]; gate.merge.else.fields[resource].path = ["structuredContent"];
    }
  }
  return (data, run) => {
    const node = analyses.find(step => step.instruction === data.INSTRUCTION); assert.ok(node, "Only this fixture's declared analysis can enter");
    assert.deepEqual(data.OUTPUT_SCHEMA, node.output_schema);
    assert.equal(run.readProgress.decisions.gate.selected, selected ? "then" : "else");
    const invoices = run.stepOutputs[own + "_invoices"].structuredContent, orders = run.stepOutputs[own + "_orders"].structuredContent;
    assert.deepEqual(Object.keys(run.reportCoverages).sort(), [own + "_invoices", own + "_orders"].sort());
    assert.equal(invoices.complete, true); assert.equal(orders.complete, true);
    assert.equal(invoices.itemCount, 2); assert.equal(orders.itemCount, 2);
    assert.deepEqual([...invoices.orderIds].sort(), orders.items.map(item => item.orderId).sort());
    let output;
    if (mode === "joined-analysis") {
      assert.equal(run.readProgress.values.gate.status, "DONE");
      assert.deepEqual(run.valueOutputs.gate.value, { invoices, orders }); assert.deepEqual(data.INPUT, { invoices, orders });
      output = { text: "joined_analysis: qualified 2 invoices and 2 related orders" };
    } else {
      assert.ok(node.id.startsWith(own + "_"));
      const invoice = node.id === own + "_invoice_analysis";
      assert.deepEqual(data.INPUT, invoice ? invoices : orders);
      output = { text: node.id + ": qualified 2 " + (invoice ? "invoices" : "related orders") };
    }
    return { nodeId: node.id, input: structuredClone(data.INPUT), output };
  };
}
