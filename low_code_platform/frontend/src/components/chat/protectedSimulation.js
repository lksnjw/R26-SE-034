export const protectedSimulationLabels = {
  SUPPLIED_READ_OUTPUT: "Supplied read response accepted",
  SUPPLIED_EFFECT_OUTPUT_NOT_APPROVED: "Supplied effect response · no effect approved or sent",
  SUPPLIED_BUSINESS_READ_ERROR: "Supplied business read fault · not ERP evidence",
  SIMULATED_GROUP_STARTED: "Protected body started",
  SIMULATED_HANDLER_SELECTED: "Handler selected by supplied test fault",
  SIMULATED_GROUP_SUCCEEDED: "Body succeeded · declared output evaluated",
  SIMULATED_HANDLED_ERROR: "Test fault handled · declared output evaluated",
  SIMULATED_GROUP_RETURNED: "Returned from group · output bypassed",
  SIMULATED_GROUP_FAILED: "Protected body stopped",
  SIMULATED_HANDLER_FAILED: "Handler stopped · no group answer",
  SIMULATED_RETURN: "Simulated final value returned",
  SIMULATED_MERGE: "Selected branch value evaluated",
  SIMULATED_ITEM: "Item value evaluated",
  SIMULATED_COLLECTION: "Collected test values evaluated",
  NOT_EVALUATED: "Not evaluated",
  BODY_ABORTED: "Earlier body read failed",
  BODY_SUCCEEDED: "Body succeeded · handler not needed",
  NOT_SELECTED: "Other branch not selected",
  AFTER_RETURN: "After return · not evaluated",
  EMPTY_COLLECTION: "Empty collection · body not evaluated",
  UNHANDLED_FIXTURE_BUSINESS_ERROR: "Supplied business fault has no applicable handler",
  SIMULATION_VISIT_LIMIT: "Simulation evaluation budget exceeded",
  COLLECTION_RETURN_INVALID: "Return inside collection is unsupported",
};

// Exact per-invocation fixtures, never a shared response for loop iterations.
export function simulationFixturePayload(fixtures, steps) {
  const outputs = {}, failures = {};
  for (const [id, value] of Object.entries(fixtures)) {
    if (!value.enabled) continue;
    if (value.businessFault) { failures[id] = { kind: "business-read-error", code: "ERP_RESOURCE_NOT_FOUND" }; continue; }
    const step = steps.find(step => step.id === id.split("/").at(-1));
    const model = ["analysis", "agent"].includes(step?.kind ?? step?.source?.kind);
    outputs[id] = model ? { structuredContent: value.fields } : {
      content: value.text ? [{ type: "text", text: value.text }] : [],
      ...(value.structured ? { structuredContent: value.fields } : {}), ...(value.failure ? { isError: true } : {}),
    };
  }
  return { outputs, failures };
}

export function protectedSimulationBoundary(value) {
  return value?.handler_selection === "supplied_test_fault_only" && value.erp_absence === "not_established" && value.effect_behavior === "not_tested";
}

export function validProtectedTraceEntry(entry, record) {
  const owners = new Map();
  const visit = (block, loops = [], depth = 0) => {
    if (depth > 16 || owners.size > 1000) return;
    for (const node of block?.nodes ?? []) {
      const id = node.kind === "action" ? node.nodeId : node.id;
      const guide = record.authoring?.nodes?.find(item => item.nodeId === id);
      const kinds = node.kind === "action" ? [guide?.kind === "analysis" || guide?.kind === "agent" ? guide.kind : "action"] :
        node.kind === "if" ? ["condition", "merge"] : node.kind === "foreach" ? ["collection", "collection-item"] : [node.kind];
      owners.set(id, { kinds, loops, ...(node.kind === "foreach" ? { ownLoop: { id, maxItems: node.maxItems } } : {}) });
      if (node.kind === "if") { visit(node.then, loops, depth + 1); visit(node.else, loops, depth + 1); }
      if (node.kind === "foreach") visit(node.body, [...loops, { id, maxItems: node.maxItems }], depth + 1);
      if (node.kind === "protect") { visit(node.body, loops, depth + 1); visit(node.handler, loops, depth + 1); }
    }
  };
  visit(record.authoring?.controlFlow);
  const owner = owners.get(entry.nodeId);
  if (!owner || !owner.kinds.includes(entry.kind) || !Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0 || !Array.isArray(entry.iterations)) return false;
  const loops = entry.kind === "collection-item" ? [...owner.loops, owner.ownLoop] : owner.loops;
  // Skipped actions can denote an unentered loop template, not a fabricated
  // item. Evaluated events must match every exact declared owner/frame.
  return (entry.outcome === "NOT_EVALUATED" ? entry.iterations.length <= loops.length : entry.iterations.length === loops.length) &&
    entry.iterations.every((frame, index) => frame.loopId === loops[index]?.id && Number.isInteger(frame.index) && frame.index >= 0 && frame.index < loops[index].maxItems);
}
