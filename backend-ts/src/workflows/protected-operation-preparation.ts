import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import type { HandlerServices, CurrentUser } from "../http/handlers/common.js";
import { HandlerFailure } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { permittedWorkflow, assertCurrentWorkflowEditor, requireWorkflowBase } from "./commands.js";
import { protectedOperationProfile } from "./protected-operation-profile.js";
import type { CompiledProtectedOperationPlan } from "./protected-operation-compiler.js";
import { ModelDataClassViolation } from "./model-data-classification.js";
import { assertRuntimeAnalysisEgress, assertRuntimeAgentEgress } from "../providers/egress-policy.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import { runtimeApprovalPolicyHash } from "../runner/runtime-approvals.js";
import { protectedOperationConnections, assertProtectedConnectionsCurrent, discoverProtectedOperationConnections,
  captureProtectedOperationPlan, assertProtectedCapabilitiesDiscovered, type ProtectedConnectionObservation } from "./protected-operation-bindings.js";

type Purpose = "inspect" | "publication";
type Context = { workflowId: string; baseVersion: number; sourceHash: string; actorId: string; roleId: string; role: string; permissionHash: string; aclHash: string; registryHash: string };
type ModelBinding = { nodeId: string; kind: "analysis" | "agent"; providerId: string; configurationRevision: string; model: string };
export type PreparedProtectedOperationCompilation = Readonly<{ profile: "protected-operation-preparation/v1"; workflowId: string; baseVersion: number;
  sourceHash: string; semanticHash: string; machineHash: string; registryHash: string; originalNodes: number; capabilities: number; modelNodes: number; runtimeQualified: false }>;
type PrivatePreparation = { services: HandlerServices; purpose: Purpose; context: Context; plan: CompiledProtectedOperationPlan;
  connections: ProtectedConnectionObservation[]; runtime?: ProviderRuntime | undefined; models: ModelBinding[]; approvalPolicy?: string | undefined };
const preparations = new WeakMap<PreparedProtectedOperationCompilation, PrivatePreparation>();
const hash = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const same = (left: unknown, right: unknown) => canonicalJSONBytes(left).equals(canonicalJSONBytes(right));
function deny(message: string, status = 409): never { throw new HandlerFailure(status, message, { code: "PROTECTED_PREPARATION_CHANGED" }); }

function savedContext(state: Readonly<RepositoryState>, services: HandlerServices, workflowId: string, user: CurrentUser, purpose: Purpose) {
  const account = state.users[user.id], role = account && state.roles[account.roleId];
  const permissions = [...new Set([...(role?.permissions ?? []), ...(account?.permissionOverrides ?? [])].filter(Boolean))].sort();
  if (!account || account.id !== user.id || account.status.toLowerCase() !== "active" || !role || role.id !== account.roleId || account.roleId !== user.roleId || role.name !== user.role ||
      !same(permissions, [...new Set(user.permissions)].sort())) deny("Workflow authority changed; reload before continuing", 403);
  const workflow = state.workflows[workflowId];
  if (!workflow || workflow.id !== workflowId || !permittedWorkflow(workflow, user, purpose === "publication")) deny("Workflow not found or not accessible", 404);
  if (purpose === "publication") assertCurrentWorkflowEditor(state, workflow, user);
  if (Buffer.byteLength(workflow.yaml) > 200_000) deny("Protected workflow source exceeds supported bounds", 422);
  const source = parseWorkflowYAMLStrict(workflow.yaml);
  if (protectedOperationProfile(source) !== "protected-collections-pending") deny("Expected an authored protected collection", 422);
  return { workflow, source, context: { workflowId, baseVersion: workflow.draftVersion, sourceHash: workflowContentHash(workflow.yaml), actorId: account.id,
    roleId: account.roleId, role: role.name, permissionHash: hash(permissions), registryHash: services.registries.hash(),
    aclHash: hash({ ownerId: workflow.owner.id, assignedUserIds: [...new Set(workflow.assignedUserIds ?? [])].sort(), archived: workflow.archived,
      emailDeliverySource: Boolean(workflow.emailDeliverySource), recoverySource: Boolean(workflow.recoverySource) }) } satisfies Context };
}
function modelBindings(plan: CompiledProtectedOperationPlan, runtime?: ProviderRuntime): ModelBinding[] {
  const nodes = plan.ir.root.nodes.filter(node => node.kind === "analysis" || node.kind === "agent");
  if (!nodes.length) return [];
  const config = runtime?.configuration, binding = runtime?.binding;
  if (!runtime?.configured || !config || !binding || config.id !== binding.providerId) deny("Protected model nodes require a current configured provider", 422);
  return nodes.map(node => {
    try {
      const selected = runtime.snapshot(node.model || config.model).binding;
      if (!selected || selected.configurationRevision !== binding.configurationRevision || selected.providerId !== binding.providerId) throw new Error("Provider changed");
      if (node.kind === "agent") assertRuntimeAgentEgress(config.egressPolicy!, config.baseURL, node.dataClass);
      else assertRuntimeAnalysisEgress(config.egressPolicy!, config.baseURL, node.dataClass);
      return { nodeId: node.id, kind: node.kind, providerId: selected.providerId, configurationRevision: selected.configurationRevision, model: selected.model };
    } catch { return deny(`Node ${node.id} requires a current configured model and separately reviewed ${node.kind} data-class policy`, 422); }
  });
}
function approvalPolicy(state: Readonly<RepositoryState>, plan: CompiledProtectedOperationPlan): string | undefined {
  if (!plan.ir.root.nodes.some(node => node.kind === "action" && node.effectClass !== "read")) return undefined;
  const policyHash = runtimeApprovalPolicyHash(state);
  // The policy validator authenticates the shape first. Its hash alone cannot
  // preserve eligibility if an administrator later revokes a reviewer role.
  const policy = (state.settings.rbac as { runtimeApprovalPolicy: { approverRoleIds: string[] } }).runtimeApprovalPolicy;
  const roles = policy.approverRoleIds.map(id => {
    const role = state.roles[id];
    if (!role?.permissions.includes("execution:approve")) deny("Protected effects require currently eligible independent approval roles", 422);
    return { id, name: role.name, permissions: [...new Set(role.permissions)].sort() };
  });
  return hash({ policyHash, roles });
}

/** Server-minted preparation, not publication, admission, approval or dispatch.
 * Source/actor/reviews are taken from confirmed repository state, never supplied
 * IR/pins. The normal collection publication/worker refusal remains unchanged. */
export async function prepareProtectedOperationCompilation(services: HandlerServices, workflowId: string, user: CurrentUser, purpose: Purpose = "inspect"): Promise<PreparedProtectedOperationCompilation> {
  const initial = await services.repository.readAuthoritative(state => savedContext(state, services, workflowId, user, purpose));
  const connections = protectedOperationConnections(services, initial.source), hasModels = initial.source.steps.some(step => step.kind === "analysis" || step.kind === "agent");
  const runtime = hasModels ? services.providerRuntime : undefined, providerBinding = hasModels ? runtime?.binding ?? null : null;
  const live = await discoverProtectedOperationConnections(services, connections);
  return services.repository.readAuthoritative(state => {
    const fresh = savedContext(state, services, workflowId, user, purpose);
    requireWorkflowBase(fresh.workflow, initial.context.baseVersion, initial.context.sourceHash);
    if (!same(initial.context, fresh.context)) deny("Workflow, registry or authority changed during protected preparation");
    try {
      assertProtectedConnectionsCurrent(services, fresh.source, connections);
      if (hasModels && (runtime !== services.providerRuntime || !same(providerBinding, runtime?.binding ?? null))) deny("Provider changed during protected preparation");
      const plan = captureProtectedOperationPlan(state, services, fresh.source, fresh.workflow.yaml, user.role);
      assertProtectedCapabilitiesDiscovered(plan, live);
      const models = modelBindings(plan, runtime), policy = approvalPolicy(state, plan);
      const value: PreparedProtectedOperationCompilation = Object.freeze({ profile: "protected-operation-preparation/v1", workflowId, baseVersion: fresh.context.baseVersion,
        sourceHash: plan.sourceHash, semanticHash: plan.semanticHash, machineHash: plan.machine.semanticHash, registryHash: fresh.context.registryHash,
        originalNodes: plan.ir.root.nodes.length, capabilities: plan.ir.capabilityClasses.length, modelNodes: models.length, runtimeQualified: false });
      preparations.set(value, { services, purpose, context: fresh.context, plan, connections, runtime, models, ...(policy ? { approvalPolicy: policy } : {}) });
      return value;
    } catch (error) {
      if (error instanceof HandlerFailure) throw error;
      if (error instanceof ModelDataClassViolation) throw new HandlerFailure(422, error.message, { code: "MODEL_DATA_CLASS_DOWNGRADE" });
      throw new HandlerFailure(422, "Protected collection requires exact current reviewed contracts, connections, role mappings and scoped typed bindings", { code: "PROTECTED_COMPILATION_REQUIRED" });
    }
  });
}

/** Recheck in the caller's committing/readiness transaction. Private minting
 * and complete fresh recompilation prevent browser hashes/booleans from being
 * promoted to trust. Returning a plan still grants no worker/SDK authority. */
export function assertProtectedOperationPreparationCurrent(prepared: PreparedProtectedOperationCompilation, services: HandlerServices, state: Readonly<RepositoryState>, user: CurrentUser,
  purpose: Purpose = "inspect"): CompiledProtectedOperationPlan {
  const owned = preparations.get(prepared);
  if (!owned || owned.services !== services || owned.purpose !== purpose) deny("Protected preparation is not owned by this lifecycle");
  const fresh = savedContext(state, services, owned.context.workflowId, user, purpose);
  if (!same(owned.context, fresh.context)) deny("Protected draft, actor, ACL or registry changed before use");
  try {
    assertProtectedConnectionsCurrent(services, fresh.source, owned.connections);
    const plan = captureProtectedOperationPlan(state, services, fresh.source, fresh.workflow.yaml, user.role, owned.plan);
    if ((owned.models.length && owned.runtime !== services.providerRuntime) || !same(owned.models, modelBindings(plan, services.providerRuntime))) deny("Protected provider/model configuration changed");
    if (approvalPolicy(state, plan) !== owned.approvalPolicy) deny("Protected independent approval policy changed");
    return plan;
  } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    deny("Protected compilation reviews or connection context changed; inspect again");
  }
}
