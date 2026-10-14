import type { CompiledOperationPlan } from "./compiled-read.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import { assertRuntimeAgentEgress, assertRuntimeAnalysisEgress } from "../providers/egress-policy.js";

/** Advisory current readiness only. Queue admission captures and rechecks the
 * exact configuration privately; this cannot grant egress or dispatch. */
export function operationModelReadinessIssues(plan: CompiledOperationPlan, runtime?: ProviderRuntime): string[] {
  const nodes = plan.ir.root.nodes.filter(node => node.kind === "analysis" || node.kind === "agent");
  if (!nodes.length) return [];
  const configuration = runtime?.configuration;
  if (!runtime?.configured || !configuration) return ["A configured model provider is required for this workflow"];
  const issues: string[] = [];
  for (const node of nodes) {
    try {
      runtime.snapshot(node.model || configuration.model);
      if (node.kind === "agent") assertRuntimeAgentEgress(configuration.egressPolicy!, configuration.baseURL, node.dataClass);
      else assertRuntimeAnalysisEgress(configuration.egressPolicy!, configuration.baseURL, node.dataClass);
    } catch { issues.push(`Node ${node.id} requires a configured model and separately reviewed ${node.kind} data-class policy`); }
  }
  return issues;
}
