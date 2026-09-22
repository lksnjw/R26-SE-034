import { modelDataClasses, type ModelDataClass } from "../providers/egress-policy.js";
import { ModelDataClassViolation } from "./model-data-classification.js";
import type { OperationNode, ReadBinding, ReadAdmissionPin } from "./compiled-read.js";
import { actionOrder, type ReadSequence } from "./read-control-flow.js";

export type ProtectedOperationProvenance = { profile: "protected-operation-provenance/v1";
  nodes: Record<string, ModelDataClass>; handlerFaults: Record<string, ModelDataClass> };

/** Whole-value, lexical provenance for v9. Both authored paths are checked;
 * item selection, protected faults and aggregate construction never declassify
 * data. This proves compilation consistency, not current egress permission. */
export function protectedOperationProvenance(flow: ReadSequence, nodes: readonly OperationNode[], reviewedClass: (pin: ReadAdmissionPin) => ModelDataClass): ProtectedOperationProvenance {
  const definitions = new Map(nodes.map(node => [node.id, node]));
  const result: ProtectedOperationProvenance = { profile: "protected-operation-provenance/v1", nodes: {}, handlerFaults: {} };
  const rank = (value: ModelDataClass) => { const at = modelDataClasses.indexOf(value); if (at < 0) throw new Error("Unknown reviewed data classification"); return at; };
  const highest = (...values: ModelDataClass[]): ModelDataClass => values.reduce((a, b) => rank(a) >= rank(b) ? a : b, "public");
  const classify = (binding: ReadBinding, available: ReadonlyMap<string, ModelDataClass>): ModelDataClass => {
    if (binding.kind === "literal") return "public";
    if (binding.kind === "ref") {
      if (binding.source === "workflowInput") return "restricted";
      const value = available.get(binding.nodeId!);
      if (!value) throw new Error("Protected provenance requires an exact available lexical source");
      return value;
    }
    if (binding.kind === "object") return highest(...Object.values(binding.fields).map(child => classify(child, available)));
    if (binding.kind === "array") return highest(...binding.items.map(child => classify(child, available)));
    return highest(...binding.parts.filter(part => typeof part !== "string").map(child => classify(child, available)));
  };
  const visit = (block: ReadSequence, outer: ReadonlyMap<string, ModelDataClass>, context: ModelDataClass): Map<string, ModelDataClass> => {
    const available = new Map(outer);
    for (const node of block.nodes) {
      if (node.kind === "action") {
        const definition = definitions.get(node.nodeId);
        if (!definition) throw new Error("Protected provenance lacks an original action definition");
        let value: ModelDataClass;
        if (definition.kind === "action") {
          if (!definition.capability.admission) throw new Error("Protected provenance requires an exact source pin");
          value = highest(context, classify(definition.inputs, available), reviewedClass(definition.capability.admission),
            ...(definition.readback ? [reviewedClass(definition.readback.admission)] : []));
        } else {
          const required = highest(context, classify(definition.input, available),
            ...(definition.kind === "agent" ? definition.allowedCapabilities.map(capability => reviewedClass(capability.admission)) : []));
          if (rank(definition.dataClass) < rank(required)) throw new ModelDataClassViolation(definition.id, definition.dataClass, required);
          value = definition.dataClass;
        }
        available.set(node.nodeId, value); result.nodes[node.nodeId] = value; continue;
      }
      if (node.kind === "return") { result.nodes[node.id] = highest(context, classify(node.output.value, available)); continue; }
      if (node.kind === "if") {
        const selected = highest(context, classify(node.predicate, available));
        const then = visit(node.then, available, selected), other = visit(node.else, available, selected);
        result.nodes[node.id] = selected;
        if (node.merge) { const value = highest(selected, classify(node.merge.then, then), classify(node.merge.else, other)); available.set(node.id, value); result.nodes[node.id] = value; }
        continue;
      }
      if (node.kind === "foreach") {
        const item = highest(context, classify(node.items.value, available));
        const body = visit(node.body, new Map([...available, [node.id, item]]), item);
        const value = highest(item, classify(node.collect.value, body));
        available.set(node.id, value); result.nodes[node.id] = value; continue;
      }
      const body = visit(node.body, available, context);
      const fault = highest(context, ...actionOrder(node.body).map(id => result.nodes[id]!));
      result.handlerFaults[node.id] = fault;
      const handler = visit(node.handler, new Map([...available, [node.id, fault]]), fault);
      const value = highest(fault, classify(node.output.success, body), classify(node.output.handled, handler));
      available.set(node.id, value); result.nodes[node.id] = value;
    }
    return available;
  };
  visit(flow, new Map(), "public"); return result;
}
