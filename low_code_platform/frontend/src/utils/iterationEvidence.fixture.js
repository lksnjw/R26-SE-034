// Offline presentation fixture matching the server journal's wire fields.
// It is not a signed receipt or evidence of production run admission.
export function iterationFixture(count = 2) {
  const flow = { kind: "sequence", nodes: [{ kind: "foreach", id: "each", maxItems: 100, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } },
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup" }] }, collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "id"] } } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } }] };
  const steps = [{ id: "lookup", action: "finance.read", parameters: { id: "{{each.item}}" } }], sourceHash = `sha256:${"a".repeat(64)}`, semanticHash = `sha256:${"b".repeat(64)}`;
  const yaml = JSON.stringify({ name: "Collection", description: "Offline presentation fixture", trigger: { type: "manual" }, steps, metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: flow } } });
  const results = Array.from({ length: count }, (_, index) => `Answer ${index + 1}`), receipts = {}, attempts = {}, outputs = {}, values = {}, timeline = [];
  const receipt = (kind, nodeId, invocationId, iterations, sourceIndex, extras = {}) => ({ kind, nodeId, invocationId, iterations, sourceIndex, status: "DONE", ...extras });
  receipts["collection:each"] = receipt("collection", "each", "each", [], 0, { completionIndex: 1, count }); values.each = { value: results };
  timeline.push({ id: "collection", boundaryKey: "collection:each", nodeId: "each", invocationId: "each", iterations: [], status: "DONE", count, output: values.each, outcome: "ITERATION_COLLECTION" });
  for (let index = 0; index < count; index++) {
    const frames = [{ loopId: "each", index }], address = `each/${index}/lookup`, attemptId = `attempt-${index}`, output = { content: [], structuredContent: { id: results[index] } };
    receipts[`action:${address}`] = receipt("action", "lookup", address, frames, 0, { attemptId });
    attempts[address] = { id: attemptId, nodeId: "lookup", invocationId: address, iterations: frames, stepIndex: 0, status: "DONE" }; outputs[address] = output;
    timeline.push({ id: attemptId, boundaryKey: `action:${address}`, attemptId, nodeId: "lookup", invocationId: address, iterations: frames, status: "DONE", output, outcome: "ITERATION_READ_COMPLETED" });
    const item = `each/${index}/each`; receipts[`collection-item:${item}`] = receipt("collection-item", "each", item, frames, 1); values[item] = { value: results[index] };
    timeline.push({ id: item, boundaryKey: `collection-item:${item}`, nodeId: "each", invocationId: item, iterations: frames, status: "DONE", output: values[item], outcome: "ITERATION_COLLECTION_ITEM" });
  }
  receipts["return:answer"] = receipt("return", "answer", "answer", [], 1); values.answer = { value: results };
  timeline.push({ id: "answer", boundaryKey: "return:answer", nodeId: "answer", invocationId: "answer", iterations: [], status: "DONE", output: values.answer, outcome: "ITERATION_RETURN" });
  const execution = { id: "collection-run", workflowId: "report", status: "DONE", startedAt: "2026-10-05T00:00:00Z", workflowSnapshot: { yaml, contentHash: sourceHash, version: 1, executionProfile: "collection-read-v1", compilation: { sourceHash, semanticHash, schemaVersion: "workflow-read-ir/v4", compilerVersion: "read-compiler/v4" } },
    iterationProgress: { profile: "read-iterations/v1", sourceHash, semanticHash, receipts }, readProgress: { profile: "read-progress-v1", lastSequence: 0, attempts }, stepOutputs: outputs, valueOutputs: values, finalOutput: results };
  return { execution, timeline, context: { yaml, sourceHash, flow, steps }, flow, steps, yaml, sourceHash };
}
