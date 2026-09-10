import type { CurrentUser, HandlerServices } from "../http/handlers/common.js";
import { HandlerFailure } from "../http/handlers/common.js";
import type { RepositoryState, StoredRecord } from "../repository/store.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { captureCapabilityAdmissionPin, captureReadAdmissionPin } from "../registry/capability-admission.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { compileOperationWorkflow, operationCompilationReceipt, type CompiledOperationPlan, type OperationCompilationReceipt, type ReadAdmissionPin } from "./compiled-read.js";
import { effectiveStepKind } from "../models/schemas.js";

export type StoredOperationCompilation = { plan: CompiledOperationPlan; receipt: OperationCompilationReceipt; verifiedRole: string; compiledAt: string };
export type PreparedOperationCompilation = { stored: StoredOperationCompilation; session: NonNullable<HandlerServices["erpbridgeSession"]>; generation: number };
function compileCurrent(state: Readonly<RepositoryState>, services: HandlerServices, yaml: string, role: string, expected?: CompiledOperationPlan) {
  const session = services.erpbridgeSession;
  if (!session?.requiresReviewedRevision || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding || session.available === false)
    throw new Error("Operations require a connected reviewed SDK-entry ERPBridge session");
  const tools = services.registries.snapshot().tools, pins = new Map<string, ReadAdmissionPin>();
  for (const step of parseWorkflowYAMLStrict(yaml).steps) {
    if (effectiveStepKind(step) === "analysis") continue;
    if (effectiveStepKind(step) === "agent") {
      const expectedNode = expected?.ir.root.nodes.find(node => node.id === step.id);
      for (const action of step.allowed_actions ?? []) {
        const matches = tools.filter(tool => tool.name === action || tool.mcp_tool_name === action);
        if (matches.length !== 1) throw new Error("Agent allow-list action has no unique current tool");
        const tool = matches[0]!, expectedCapability = expectedNode?.kind === "agent" ? expectedNode.allowedCapabilities.find(value => value.toolId === tool.tool_id) : undefined;
        if (expected && !expectedCapability) throw new Error("Stored agent node lacks an exact capability pin");
        pins.set(tool.tool_id, captureCapabilityAdmissionPin(state, services.registries, tool, session.admissionBinding, expectedCapability?.admission));
      }
      continue;
    }
    const matches = tools.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action);
    if (matches.length !== 1) throw new Error("Operation action has no unique current tool");
    const expectedNode = expected?.ir.root.nodes.find(node => node.id === step.id), pin = expectedNode?.kind === "action" ? expectedNode.capability.admission : undefined;
    const tool = matches[0]!;
    if (expected && !pin) throw new Error("Stored operation lacks an exact pin");
    pins.set(tool.tool_id, captureCapabilityAdmissionPin(state, services.registries, tool, session.admissionBinding, pin));
    if (tool.operation_contract?.readback) {
      const targets = tools.filter(target => target.tool_id === tool.operation_contract!.readback!.tool_id);
      const readback = expectedNode?.kind === "action" ? expectedNode.readback : undefined;
      if (targets.length !== 1 || expected && !readback) throw new Error("Operation lacks an exact reviewed read-back target");
      pins.set(targets[0]!.tool_id, captureReadAdmissionPin(state, services.registries, targets[0]!, session.admissionBinding, readback?.admission, pin?.connectionId));
    }
  }
  const plan = compileOperationWorkflow(yaml, tools, role, pins);
  if (expected && !canonicalJSONBytes(expected).equals(canonicalJSONBytes(plan))) throw new Error("Operation source, semantics or admission changed");
  return plan;
}
export async function prepareOperationPublication(services: HandlerServices, yaml: string, user: CurrentUser): Promise<PreparedOperationCompilation | null> {
  const source = parseWorkflowYAMLStrict(yaml), tools = services.registries.snapshot().tools;
  if (!source.steps.some(step => tools.some(tool => !tool.is_read_only && [tool.name, tool.mcp_tool_name].includes(step.action ?? "")))) return null;
  const session = services.erpbridgeSession, generation = session?.discoveryGeneration ?? 0, registryHash = services.registries.hash();
  if (!session) throw new HandlerFailure(503, "Reviewed ERPBridge is required for operation publication");
  await discoverTools(session, services.registries);
  try {
    const plan = await services.repository.readAuthoritative(state => compileCurrent(state, services, yaml, user.role));
    if (services.erpbridgeSession !== session || generation !== (session.discoveryGeneration ?? 0) || registryHash !== services.registries.hash()) throw new Error("Operation context changed");
    return { stored: { plan, receipt: operationCompilationReceipt(plan, registryHash), verifiedRole: user.role, compiledAt: new Date().toISOString() }, session, generation };
  } catch { throw new HandlerFailure(422, "Operation publication requires supported exact reviewed contracts and typed sequential bindings", { code: "OPERATION_COMPILATION_REQUIRED" }); }
}
export function assertOperationPublicationCurrent(prepared: PreparedOperationCompilation, services: HandlerServices, state: Readonly<RepositoryState>, yaml: string, role: string) {
  if (services.erpbridgeSession !== prepared.session || prepared.generation !== (prepared.session.discoveryGeneration ?? 0) || prepared.stored.receipt.registryHash !== services.registries.hash())
    throw new HandlerFailure(409, "Operation connection or registry changed before publication");
  compileCurrent(state, services, yaml, role, prepared.stored.plan);
}
export function prepareOperationExecution(state: Readonly<RepositoryState>, services: HandlerServices, publication: StoredRecord, yaml: string, role: string, expected?: OperationCompilationReceipt): StoredOperationCompilation {
  try {
    const stored = publication.compiledOperation as StoredOperationCompilation | undefined;
    if (!stored || stored.verifiedRole !== role || !Number.isFinite(Date.parse(stored.compiledAt)) || canonicalJSONBytes(stored).length > 1_200_000) throw new Error("Missing operation compilation");
    const plan = compileCurrent(state, services, yaml, role, stored.plan), receipt = operationCompilationReceipt(plan, services.registries.hash());
    if (!canonicalJSONBytes(stored.receipt).equals(canonicalJSONBytes(receipt)) || expected && !canonicalJSONBytes(expected).equals(canonicalJSONBytes(receipt))) throw new Error("Operation receipt changed");
    return structuredClone(stored);
  } catch { throw new HandlerFailure(409, "Operation publication is missing, stale or unavailable; explicitly review and republish", { code: "PUBLISHED_OPERATION_REQUIRED" }); }
}
