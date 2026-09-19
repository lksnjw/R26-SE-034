import { modelDataClasses, type ModelDataClass } from "../providers/egress-policy.js";
import type { CompiledOperationPlan, ReadAdmissionPin, ReadBinding } from "./compiled-read.js";
import { operationControlDependencies } from "./operation-control-flow.js";
import { controlNodes } from "./read-control-flow.js";

export class ModelDataClassViolation extends Error {
  constructor(nodeId: string, declared: ModelDataClass, required: ModelDataClass) {
    super(`Model node ${nodeId} declares ${declared} data but its reviewed sources require at least ${required}. Raise data_class and separately review the provider's model-egress policy; summarizing or formatting does not declassify data.`);
    this.name = "ModelDataClassViolation";
  }
}

/** Conservative, whole-value provenance over the supported flat operation IR.
 * No field-level declassification or content inference. Caller inputs have no
 * reviewed classification contract and therefore retain the restricted floor.
 * This is an authorization prerequisite, never a replacement for egress policy. */
export function assertModelDataClassification(plan: CompiledOperationPlan, reviewedClass: (pin: ReadAdmissionPin) => ModelDataClass): void {
  if (!plan.ir.root.nodes.some(node => node.kind === "analysis" || node.kind === "agent")) return;
  const outputs = new Map<string, ModelDataClass>();
  const controlDependencies = operationControlDependencies(plan.ir.flow);
  const merges = new Map(plan.ir.flow ? controlNodes(plan.ir.flow).filter(node => node.merge).map(node => [node.id, node]) : []);
  const resolving = new Set<string>();
  const rank = (value: ModelDataClass) => {
    const index = modelDataClasses.indexOf(value);
    if (index < 0) throw new Error("Unknown reviewed data classification");
    return index;
  };
  const highest = (...values: ModelDataClass[]): ModelDataClass => values.reduce((left, right) => rank(left) >= rank(right) ? left : right, "public");
  const bindingClass = (binding: ReadBinding): ModelDataClass => {
    switch (binding.kind) {
      case "literal": return "public";
      case "ref": {
        if (binding.source === "workflowInput") return "restricted";
        const id = binding.nodeId ?? "";
        let value = outputs.get(id);
        const merge = merges.get(id);
        if (!value && merge?.merge) {
          if (resolving.has(id)) throw new Error("Model classification has a cyclic merge source");
          resolving.add(id);
          try {
            // Both possible values AND selection remain sensitive, even if
            // one run takes a public/empty path. Never declassify by routing.
            value = highest(bindingClass(merge.merge.then), bindingClass(merge.merge.else), bindingClass(merge.predicate));
            outputs.set(id, value);
          } finally { resolving.delete(id); }
        }
        if (!value) throw new Error("Model classification requires an exact preceding output source");
        return value;
      }
      case "object": return highest(...Object.values(binding.fields).map(bindingClass));
      case "array": return highest(...binding.items.map(bindingClass));
      case "template": return highest(...binding.parts.filter(part => typeof part !== "string").map(bindingClass));
    }
  };
  for (const node of plan.ir.root.nodes) {
    if (node.kind === "action") {
      if (!node.capability.admission) throw new Error("Model classification requires an exact reviewed source pin");
      outputs.set(node.id, highest(reviewedClass(node.capability.admission), bindingClass(node.inputs), ...(controlDependencies.get(node.id) ?? []).map(bindingClass),
        ...(node.readback ? [reviewedClass(node.readback.admission)] : [])));
      continue;
    }
    const required = highest(bindingClass(node.input), ...(controlDependencies.get(node.id) ?? []).map(bindingClass), ...(node.kind === "agent" ? node.allowedCapabilities.map(capability => reviewedClass(capability.admission)) : []));
    if (rank(node.dataClass) < rank(required)) throw new ModelDataClassViolation(node.id, node.dataClass, required);
    // A high declaration is retained through later model nodes AND tool inputs.
    outputs.set(node.id, node.dataClass);
  }
}
