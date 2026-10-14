import { stringify } from "yaml";
import type { HandlerServices } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { prepareOperationExecution } from "../workflows/operation-compilation-lifecycle.js";
import { resolveReadBinding, type CompiledOperationPlan, type ReadAdmissionPin } from "../workflows/compiled-read.js";
import { assertProtectedCheckpointOwnership, confirmedProtectedOperationTransition, protectedOperationValueState, type ProtectedCheckpointOwner } from "./operation-protected-checkpoints.js";
import { assertConfirmedOperationResults } from "./operation-result-evidence.js";

export type ProtectedReadDispatch = { plan: CompiledOperationPlan; owner: ProtectedCheckpointOwner };

/** Private exact selected-node binding. The returned flat prerequisite view is
 * denial-only; it must NEVER mint a token or replace original publication YAML.
 * Legacy readers cannot acquire handler authority by passing completed IDs. */
export function protectedReadPrerequisiteYAML(services: HandlerServices, state: RepositoryState, executionId: string, actorId: string,
  context: ProtectedReadDispatch, yaml: string, index: number, pin: ReadAdmissionPin | undefined, args: Record<string, unknown>): string {
  const run = state.executions[executionId], { plan, owner } = context;
  if (!run || run.workflowSnapshot?.yaml !== yaml || run.operationSecret?.actorId !== actorId) throw new Error("Protected read has no exact current execution");
  assertProtectedCheckpointOwnership(state, run, plan, owner);
  const publication = state.versions[run.workflowId]?.filter(version => version.version === run.workflowSnapshot!.version && version.artifactState === "PUBLISHED");
  if (publication?.length !== 1) throw new Error("Protected read requires one immutable publication");
  prepareOperationExecution(state, services, publication[0]!, yaml, run.operationSecret.admittedRole, run.workflowSnapshot.operationCompilation);
  assertConfirmedOperationResults(state, run, plan);
  const next = confirmedProtectedOperationTransition(state, run, plan), node = plan.ir.root.nodes[index];
  if (next.kind !== "action" || next.index !== index || node?.kind !== "action" || node.effectClass !== "read" || node.id !== next.nodeId ||
      !pin || !canonicalJSONBytes(pin).equals(canonicalJSONBytes(node.capability.admission))) throw new Error("Protected read is not the exact selected compiled read");
  const resolved = resolveReadBinding(node.inputs, protectedOperationValueState(run, plan.ir.flow!, node.id));
  if (!canonicalJSONBytes(resolved).equals(canonicalJSONBytes(args))) throw new Error("Protected read arguments differ from the exact selected bindings");
  const blueprint = parseWorkflowYAMLStrict(yaml), completed = new Set(Object.values(run.readProgress!.attempts).filter(attempt => attempt.status === "DONE").map(attempt => attempt.nodeId));
  const metadata = { ...blueprint.metadata }; delete metadata.controlFlow;
  return stringify({ ...blueprint, metadata, steps: blueprint.steps.filter(step => step.id === node.id || completed.has(step.id)) });
}
