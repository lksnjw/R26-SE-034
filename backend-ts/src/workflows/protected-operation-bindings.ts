import type { HandlerServices } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import type { WorkflowBlueprint } from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { captureCapabilityAdmissionPin, captureReadAdmissionPin, reviewedCapabilityDataClass, capabilityContractHash } from "../registry/capability-admission.js";
import { boundMcpConnection, selectedMcpConnectionId, connectionToolKey, type BoundMcpConnection } from "../tools/mcp-dispatch-context.js";
import { compileProtectedOperationWorkflow, assertProtectedOperationPlanCurrent, type CompiledProtectedOperationPlan } from "./protected-operation-compiler.js";
import type { ReadAdmissionPin } from "./compiled-read.js";

export type ProtectedConnectionObservation = BoundMcpConnection & { generation: number; admissionBinding: string };

/** Server-owned connection identity, not a browser endpoint or dispatch grant. */
export function protectedOperationConnections(services: HandlerServices, source: WorkflowBlueprint): ProtectedConnectionObservation[] {
  const ids = [...new Set(source.steps.filter(step => effectiveStepKind(step) !== "analysis").map(step => selectedMcpConnectionId(services, step.connection_id)))].sort();
  return ids.map(id => {
    const bound = boundMcpConnection(services, id), session = bound.session, generation = session.discoveryGeneration ?? 0;
    if (session.requiresReviewedRevision !== true || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding ||
        !Number.isSafeInteger(generation) || generation < 0) throw new Error("Protected operations require connected reviewed SDK-entry sessions");
    return { ...bound, generation, admissionBinding: session.admissionBinding };
  });
}
export function assertProtectedConnectionsCurrent(services: HandlerServices, source: WorkflowBlueprint, expected: readonly ProtectedConnectionObservation[]): void {
  const current = protectedOperationConnections(services, source);
  if (current.length !== expected.length || current.some((value, index) => {
    const old = expected[index]!;
    return value.id !== old.id || value.session !== old.session || value.generation !== old.generation || value.admissionBinding !== old.admissionBinding ||
      !canonicalJSONBytes(value.roleMap).equals(canonicalJSONBytes(old.roleMap));
  })) throw new Error("Protected operation connection selection, session, discovery or role map changed");
}
export async function discoverProtectedOperationConnections(services: HandlerServices, connections: readonly ProtectedConnectionObservation[]) {
  return new Map(await Promise.all(connections.map(async value => [value.id, await discoverTools(value.session, services.registries)] as const)));
}

/** Freshly derive all pins/classes from authoritative records. Neither a
 * syntactic pin nor the immutable plan substitutes for final SDK admission. */
export function captureProtectedOperationPlan(state: Readonly<RepositoryState>, services: HandlerServices, source: WorkflowBlueprint, yaml: string, role: string,
  expected?: CompiledProtectedOperationPlan): CompiledProtectedOperationPlan {
  const tools = services.registries.snapshot().tools, pins = new Map<string, ReadAdmissionPin>();
  for (const step of source.steps) {
    if (effectiveStepKind(step) === "analysis") continue;
    const connectionId = selectedMcpConnectionId(services, step.connection_id), { session, roleMap } = boundMcpConnection(services, connectionId);
    if (session.requiresReviewedRevision !== true || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding)
      throw new Error("Protected operation requires a current reviewed SDK-entry connection");
    const previous = expected?.ir.root.nodes.find(node => node.id === step.id);
    const actions = effectiveStepKind(step) === "agent" ? step.allowed_actions ?? [] : [step.action ?? ""];
    for (const action of actions) {
      const matches = tools.filter(tool => tool.name === action || tool.mcp_tool_name === action);
      if (matches.length !== 1) throw new Error("Protected operation has no unique current capability");
      const tool = matches[0]!, old = previous?.kind === "action" ? previous.capability : previous?.kind === "agent" ? previous.allowedCapabilities.find(value => value.toolId === tool.tool_id) : undefined;
      if (expected && (!old?.admission || old.admission.connectionId !== connectionId || old.toolId !== tool.tool_id))
        throw new Error("Protected operation original capability/connection changed");
      if (tool.bridge_contract?.remote_roles.length && !tool.bridge_contract.remote_roles.includes(roleMap[role] ?? ""))
        throw new Error(`Node ${step.id} requires a current reviewed ERPBridge role mapping`);
      const pin = captureCapabilityAdmissionPin(state, services.registries, tool, session.admissionBinding, old?.admission, connectionId);
      pins.set(connectionToolKey(connectionId, tool.tool_id), pin); if (!step.connection_id) pins.set(tool.tool_id, pin);
      if (tool.operation_contract?.readback) {
        const targets = tools.filter(value => value.tool_id === tool.operation_contract!.readback!.tool_id);
        const readback = previous?.kind === "action" ? previous.readback : undefined;
        if (targets.length !== 1 || expected && (!readback || readback.admission.connectionId !== connectionId))
          throw new Error("Protected operation lacks its exact same-connection read-back target");
        // Read-back is a separate governed query with its own future actor.
        // Preserve its exact reviewed contract without borrowing the publisher's
        // role or pretending that preparation authorizes that recovery query.
        const captured = captureReadAdmissionPin(state, services.registries, targets[0]!, session.admissionBinding, readback?.admission, connectionId);
        pins.set(connectionToolKey(connectionId, targets[0]!.tool_id), captured); if (!step.connection_id) pins.set(targets[0]!.tool_id, captured);
      }
    }
  }
  const classify = (pin: ReadAdmissionPin) => reviewedCapabilityDataClass(state, pin);
  if (expected) { assertProtectedOperationPlanCurrent(expected, yaml, tools, role, pins, classify); return structuredClone(expected); }
  return compileProtectedOperationWorkflow(yaml, tools, role, pins, classify);
}
export function assertProtectedCapabilitiesDiscovered(plan: CompiledProtectedOperationPlan, live: Awaited<ReturnType<typeof discoverProtectedOperationConnections>>): void {
  for (const node of plan.ir.root.nodes) {
    const targets = node.kind === "action" ? [node.capability, ...(node.readback ? [node.readback] : [])] : node.kind === "agent" ? node.allowedCapabilities : [];
    for (const target of targets) {
      const pin = target.admission;
      const matches = pin ? (live.get(pin.connectionId) ?? []).filter(tool => tool.tool_id === target.toolId &&
        capabilityContractHash(tool) === pin.contractHash && target.contractHash === pin.contractHash) : [];
      if (matches.length !== 1) throw new Error("Protected operation requires every exact primary, agent and read-back capability on its reviewed connection");
    }
  }
}
