import { parseReadControlFlow, loopNodes, protectedNodes, type ReadSequence } from "./read-control-flow.js";
import { protectedFailureOwners } from "./operation-protected-control.js";
import type { CompiledOperationPlan } from "./compiled-read.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { assertReadErrorContract } from "../tools/read-business-error.js";
import { capabilityContractHash } from "../registry/capability-admission.js";

/** Explicit executable profile boundary, not a publication or dispatch grant.
 * Collections retain their draft representation until durable iteration is
 * integrated; they must never be flattened into once-only operation actions. */
export function protectedOperationProfile(source: { metadata?: Record<string, unknown> | undefined }): "ordinary" | "protected" | "protected-collections-pending" {
  if ((source.metadata?.controlFlow as { schemaVersion?: unknown } | undefined)?.schemaVersion !== "read-control-flow/v4") return "ordinary";
  return loopNodes(parseReadControlFlow(source.metadata!.controlFlow).root).length ? "protected-collections-pending" : "protected";
}

/** Offline eligibility only: a body must contain a mapped low-risk read.
 * Current review, immutable pins and dispatch authority remain separate. */
export function protectedErrorSourceIssues(root: ReadSequence, sources: readonly { id: string; tools: readonly ToolDefinition[] }[]): string[] {
  const eligible = new Set<string>();
  for (const source of sources) {
    if (source.tools.some(tool => {
      if (tool.read_error_contract?.profile !== "erpbridge-read-error/v1" || tool.read_error_contract.remote_type !== "not_found" ||
          tool.read_error_contract.business_error !== "ERP_RESOURCE_NOT_FOUND") return false;
      try { assertReadErrorContract(tool); return true; } catch { return false; }
    })) {
      for (const owner of protectedFailureOwners(root, source.id)) eligible.add(owner);
    }
  }
  return protectedNodes(root).filter(group => !eligible.has(group.id))
    .map(group => `Protected group ${group.id} requires an exact reviewed ERP_RESOURCE_NOT_FOUND read-error source in its body`);
}

/** Compiled eligibility also binds each mapped tool to its exact contract.
 * Arbitrary failures, effects and provider errors cannot select a handler. */
export function assertProtectedErrorSources(plan: CompiledOperationPlan, tools: readonly ToolDefinition[]): void {
  if (plan.ir.schemaVersion !== "workflow-operation-ir/v8" || !plan.ir.flow) return;
  const sources = plan.ir.root.nodes.map(node => {
    const capabilities = node.kind === "action" && node.effectClass === "read" ? [node.capability] : node.kind === "agent" ? node.allowedCapabilities : [];
    return { id: node.id, tools: capabilities.flatMap(capability => tools.filter(tool => tool.tool_id === capability.toolId &&
      capabilityContractHash(tool) === capability.contractHash && capability.admission?.contractHash === capability.contractHash)) };
  });
  const issues = protectedErrorSourceIssues(plan.ir.flow, sources);
  if (issues.length) throw new Error(issues.join("; "));
}
