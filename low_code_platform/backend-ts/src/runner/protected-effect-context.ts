import { stringify } from "yaml";
import type { RepositoryState } from "../repository/store.js";
import type { HandlerServices } from "../http/handlers/common.js";
import { capabilityContractHash, captureCapabilityAdmissionPin, supportedOperation } from "../registry/capability-admission.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { boundMcpConnection } from "../tools/mcp-dispatch-context.js";
import { createDispatchIdentity } from "../tools/registry.js";
import { assertProtectedJobCurrent, protectedHash as hash, type ProtectedJobOwner } from "./protected-job-state.js";
import { currentProtectedApprovalContext, protectedApprover, protectedApprovalStorage } from "./protected-approval-context.js";
import { assertProtectedApprovalContext, assertConsumedProtectedApprovalContext } from "./protected-approval-protocol.js";

/** Authoritative exact effect view. Neither approval JSON nor an arbitrary
 * callback can establish an owned claim, publication or selected session. */
export function ownedProtectedEffectContext(state: Readonly<RepositoryState>, services: HandlerServices, executionId: string,
  owner: ProtectedJobOwner, stage: "APPROVED" | "CONSUMED") {
  protectedApprovalStorage(services);
  const saved = assertProtectedJobCurrent(state, services, executionId, owner), context = currentProtectedApprovalContext(saved, state, services);
  const records = saved.run.protectedApprovalSecret, record = records?.activeId ? records.records[records.activeId] : undefined;
  if (!record || record.binding.sequence !== context.point.sequence || record.binding.invocationId !== context.point.invocationId || record.state !== stage || !record.decision)
    throw new Error("Protected effect lacks its exact approved current invocation");
  if (stage === "APPROVED") assertProtectedApprovalContext(context, record, Date.now());
  else assertConsumedProtectedApprovalContext(context, record, Date.now());
  const reviewer = protectedApprover(state, record.decision.actorId, record.binding.requesterId);
  if (reviewer.roleId !== record.decision.roleId) throw new Error("Protected effect reviewer authority changed");
  const tools = services.registries.snapshot().tools.filter(tool => tool.tool_id === context.node.capability.toolId), definition = tools[0];
  if (tools.length !== 1 || !definition || capabilityContractHash(definition) !== context.node.capability.contractHash ||
      definition.operation_contract?.effect_class !== context.node.effectClass) throw new Error("Protected effect contract changed");
  supportedOperation(definition);
  const bound = boundMcpConnection(services, context.node.capability.admission!.connectionId);
  captureCapabilityAdmissionPin(state, services.registries, definition, bound.session.admissionBinding!, context.node.capability.admission, bound.id);
  const identity = createDispatchIdentity({ id: saved.run.startedBy.id, role: saved.run.protectedJobSecret!.admittedRole }, bound.roleMap);
  return { saved, context, record, reviewer, definition, bound, identity };
}

/** Denial-only process view built from exact acknowledged lexical values. An
 * earlier sibling/item cannot satisfy a prerequisite by its static node ID. */
export function protectedEffectPrerequisiteYAML(value: ReturnType<typeof ownedProtectedEffectContext>): string {
  const { saved, context } = value, values = saved.machine.snapshot().values;
  const completed = new Set(Object.values(saved.ledger.snapshot().receipts).filter(row => row.boundary.kind === "action" && row.result.kind === "accept" &&
    Object.hasOwn(values, row.boundary.nodeId) && hash(values[row.boundary.nodeId]) === hash(row.result.output) &&
    row.boundary.iterations.every((frame, at) => at < context.point.iterations.length && hash(frame) === hash(context.point.iterations[at]))).map(row => row.boundary.nodeId));
  const blueprint = parseWorkflowYAMLStrict(saved.run.workflowSnapshot!.yaml), metadata = { ...blueprint.metadata }; delete metadata.controlFlow;
  return stringify({ ...blueprint, metadata, steps: blueprint.steps.filter(step => step.id === context.point.nodeId || completed.has(step.id)) });
}
