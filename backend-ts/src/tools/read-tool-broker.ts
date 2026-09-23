import { stringify } from "yaml";
import type { HandlerServices } from "../http/handlers/common.js";
import { validateWorkflow } from "../http/handlers/common.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { createDispatchIdentity } from "./registry.js";
import { validateToolInput } from "./tool-input-schema.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import { hasReservedBridgeRole } from "./erpbridge-contract.js";
import type { ReadAdmissionPin, CompiledReadPlan } from "../workflows/compiled-read.js";
import { selectedPrerequisiteYAML } from "../workflows/selected-prerequisite-view.js";
import { capabilityContractHash, captureReadAdmissionPin } from "../registry/capability-admission.js";
import { parseReadControlFlow } from "../workflows/read-control-flow.js";
import { ReadIterationCheckpoints, type ReadSelectedEvidence } from "../runner/read-iteration-checkpoints.js";
import type { ReadVisit } from "../workflows/read-interpreter.js";
import { selectedReadEvidenceYAML } from "../workflows/read-completion-evidence.js";
import { assertIterationDispatchBinding } from "../workflows/read-iteration-dispatch-binding.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundMcpConnection, selectedMcpConnectionId } from "./mcp-dispatch-context.js";
import { consumeAcknowledgedReadErrorEvidence, ErpbridgeMcpToolError } from "./erpbridge-mcp-client.js";
import { assertReadErrorContract, type ReviewedReadBusinessFailure } from "./read-business-error.js";
import { protectedReadPrerequisiteYAML, type ProtectedReadDispatch } from "../runner/protected-read-dispatch.js";
import { ProtectedJobCheckpoints } from "../runner/protected-job-checkpoints.js";

const acknowledgedFailures = new WeakMap<object, { result: Record<string, unknown>; businessFailure?: ReviewedReadBusinessFailure }>();
/** Read-only observation for nested server checkpoints. Never accepts a
 * serialized flag, public exception constructor, or the mutable error.result. */
export function acknowledgedReadToolFailure(error: unknown): { code: "MCP_READ_TOOL_ERROR"; result: Record<string, unknown>; businessFailure?: ReviewedReadBusinessFailure } | undefined {
  if (!(error instanceof Error)) return undefined;
  const evidence = acknowledgedFailures.get(error);
  return evidence ? { code: "MCP_READ_TOOL_ERROR", ...structuredClone(evidence) } : undefined;
}

export type ReadDispatchContext = { signal?: AbortSignal | undefined; traceId?: string | undefined; sessionId?: string | undefined; workflowId?: string | undefined; executionId?: string | undefined;
  beforeDispatch?: ((verifiedRole: string) => Promise<void>) | undefined;
  /** Server-only denial check at the synchronous SDK/capability boundary. */
  assertDispatch?: (() => void) | undefined;
  /** Server-owned journal instance, never a model/browser evidence payload. */
  iteration?: { checkpoints: ReadIterationCheckpoints; plan: CompiledReadPlan; visit: ReadVisit; assertBinding?: () => void };
  /** Server-owned v8 worker identity, never browser/model-supplied receipts. */
  protectedOperation?: ProtectedReadDispatch;
  /** Owned v9 controller; no serialized continuation or caller receipt. */
  protectedInvocation?: { checkpoints: ProtectedJobCheckpoints };
  plan?: { yaml: string; stepIndex: number; token: ValidationToken; admissionPin?: ReadAdmissionPin; contractHash?: string; toolId?: string };
  /** Exact reviewed dynamic-node allow-list binding. The broker still builds
   * and validates one synthetic single-tool workflow for the concrete call. */
  dynamicPlan?: { admissionPin: ReadAdmissionPin; contractHash: string; toolId: string } };

// Phase-0 containment: only explicitly registered, role-granted reads may
// reach the SDK. Transaction writes await approval/idempotency/recovery.
export async function dispatchReadTool(
  services: HandlerServices,
  actorId: string,
  toolName: string,
  args: Record<string, unknown>,
  context: ReadDispatchContext = {},
): Promise<Record<string, unknown>> {
  args = structuredClone(args);
  const assertWorkerDispatch = context.assertDispatch;
  const assertStorageAuthority = services.repository.assertAuthority.bind(services.repository);
  assertStorageAuthority();
  const actor = await services.repository.effectiveUser(actorId);
  if (actor === null || actor.status.toLowerCase() !== "active" ||
      !actor.permissions.some((permission) => ["chat:use", "workflow:write", "workflow:run", "workflow:run_own"].includes(permission)))
    throw new Error("Tool dispatch denied: current actor is not authorized");
  await checkWorkflowScope(services, actor, context.workflowId);
  if (context.plan && context.dynamicPlan || context.protectedOperation && (!context.plan || context.dynamicPlan || context.iteration || context.protectedInvocation) ||
      context.protectedInvocation && (!context.plan || context.dynamicPlan || context.iteration || context.protectedOperation)) throw new Error("Tool dispatch cannot combine incompatible static, dynamic or iteration bindings");
  const protectedJournal = context.protectedInvocation?.checkpoints;
  if (context.protectedInvocation && (!(protectedJournal instanceof ProtectedJobCheckpoints) || protectedJournal.services !== services ||
      protectedJournal.repository !== services.repository || protectedJournal.executionId !== context.executionId))
    throw new Error("Protected dispatch requires its owned checkpoint controller");
  const exactPlan = context.plan ?? context.dynamicPlan;
  const connectionId = exactPlan?.admissionPin?.connectionId ?? selectedMcpConnectionId(services);
  const bound = boundMcpConnection(services, connectionId), session = bound.session;
  const registryHash = services.registries.hash(), generation = session.discoveryGeneration ?? 0;
  const roleMap = canonicalJSONBytes(bound.roleMap);
  const iteration = context.iteration && { ...context.iteration, plan: structuredClone(context.iteration.plan), visit: structuredClone(context.iteration.visit) };
  const assertContext = () => {
    assertStorageAuthority();
    const current = boundMcpConnection(services, connectionId);
    if (current.session !== session || session.available === false || services.registries.hash() !== registryHash ||
        (session.discoveryGeneration ?? 0) !== generation || !roleMap.equals(canonicalJSONBytes(current.roleMap)))
      throw new Error("Tool dispatch context changed during verification");
    if (context.signal?.aborted) throw new Error("Tool dispatch was cancelled");
    iteration?.assertBinding?.();
    assertWorkerDispatch?.();
  };
  const tools = await discoverTools(session, services.registries);
  const matches = tools.filter((tool) => tool.name === toolName || tool.mcp_tool_name === toolName);
  if (matches.length !== 1) throw new Error("Tool dispatch denied: tool has no unique admitted live contract");
  const tool = structuredClone(matches[0]!);
  assertReadErrorContract(tool);
  // Capture the exact reviewed identity before SDK entry. Later changes cannot
  // retroactively classify this response under a different review or contract.
  let errorReviewPin: ReadAdmissionPin | undefined;
  if (tool.read_error_contract) {
    if (session.requiresReviewedRevision !== true || !session.admissionBinding || session.dispatchBoundary !== "sdk-entry/v1")
      throw new Error("Business read-error classification requires a supported reviewed ERPBridge session");
    errorReviewPin = await services.repository.readAuthoritative(state => captureReadAdmissionPin(state, services.registries, tool,
      session.admissionBinding!, exactPlan?.admissionPin, connectionId));
  }
  const dispatchPin = errorReviewPin ?? exactPlan?.admissionPin;
  const assertContract = () => { if (exactPlan?.contractHash && (exactPlan.toolId !== tool.tool_id || exactPlan.contractHash !== capabilityContractHash(tool))) throw new Error("Compiled tool contract changed; no implicit rebinding is allowed"); };
  assertContract();
  await session.assertAdmission?.(tool, dispatchPin, context.signal);
  if (!tool.is_read_only) throw new Error("Live ERP writes are blocked until transaction approval, idempotency and recovery are enforced");
  if (!tool.allowed_roles.includes(actor.role)) throw new Error("Tool dispatch denied: current role has no grant for this tool");
  if (hasReservedBridgeRole(tool) && Object.hasOwn(args, "role")) throw new Error("Tool dispatch denied: model-provided role is not allowed");
  const parameters = structuredClone(args);
  if (validateToolInput(tool.input_schema, parameters).length > 0) throw new Error("Tool dispatch denied: unsupported schema or invalid arguments");
  const issues = validateToolArguments(toolName, parameters, tool);
  if (issues.missing.length || issues.invalid.length) throw new Error("Tool dispatch denied: arguments failed runtime validation");
  const yaml = context.plan?.yaml ?? stringify({ name: "Authorized read", description: "One exact read proposed by the workspace agent", trigger: { type: "manual" }, steps: [{ id: "read", action: tool.name, parameters }] });
  const index = context.plan?.stepIndex ?? 0;
  const blueprint = parseWorkflowYAMLStrict(yaml), authored = blueprint.steps[index];
  if (authored === undefined || ![tool.name, tool.mcp_tool_name].includes(authored.action ?? "")) throw new Error("Tool dispatch denied: authored action does not match requested tool");
  if (context.plan && selectedMcpConnectionId(services, authored.connection_id) !== connectionId) throw new Error("Tool dispatch denied: authored and compiled ERPBridge connections differ");
  let selected: ReadSelectedEvidence | undefined;
  const checkSelectedPath = (evidence: ReadSelectedEvidence) => {
    if (!services.validator.validatePlan("ReadConfirmedIterations", selectedReadEvidenceYAML(blueprint, evidence.nodeId, evidence.args, evidence.visit, evidence.prior), actor.role).passed)
      throw new Error("Selected iteration path does not meet confirmed process prerequisites");
  };
  const assertIterationContext = (state: Parameters<typeof assertIterationDispatchBinding>[1]) => {
    assertContext();
    assertIterationDispatchBinding(services, state, context.executionId!, iteration!.checkpoints.epoch, yaml, iteration!.plan, actor.role);
  };
  if (iteration) {
    const node = iteration.plan.ir.root.nodes[index], journal = iteration.checkpoints;
    if (!context.plan || context.beforeDispatch || !(journal instanceof ReadIterationCheckpoints) || journal.repository !== services.repository || journal.executionId !== context.executionId || journal.yaml !== yaml ||
        !node || node.id !== authored.id || node.capability.toolId !== tool.tool_id || node.capability.contractHash !== capabilityContractHash(tool) ||
        context.plan.toolId !== node.capability.toolId || context.plan.contractHash !== node.capability.contractHash ||
        !canonicalJSONBytes(context.plan.admissionPin).equals(canonicalJSONBytes(node.capability.admission)))
      throw new Error("Collection dispatch is not bound to its private compiled journal");
    await services.repository.readAuthoritative(assertIterationContext);
    selected = await journal.selectedEvidence(iteration.visit);
    if (selected.actorId !== actorId || selected.admittedRole !== actor.role || selected.executionId !== context.executionId || selected.sourceIndex !== index ||
        selected.nodeId !== node.id || selected.sourceHash !== iteration.plan.sourceHash || selected.semanticHash !== iteration.plan.semanticHash ||
        !canonicalJSONBytes(selected.args).equals(canonicalJSONBytes(parameters))) throw new Error("Collection dispatch arguments or identity differ from the exact current invocation");
    checkSelectedPath(selected);
  }
  if (blueprint.metadata?.controlFlow !== undefined) {
    const collectionSource = parseReadControlFlow(blueprint.metadata.controlFlow).schemaVersion === "read-control-flow/v3";
    if (collectionSource && !iteration && !protectedJournal)
      throw new Error("Collection reads require governed iteration dispatch; flat completed-node evidence is not accepted");
    if (iteration && !collectionSource) throw new Error("Iteration journal requires the collection source profile");
    if (protectedJournal) {
      const prefix = await services.repository.readAuthoritative(state => protectedJournal.prerequisiteYAML(state, yaml, index, context.plan?.admissionPin, parameters));
      if (!services.validator.validatePlan("ReadConfirmedProtectedInvocation", prefix, actor.role).passed)
        throw new Error("Selected protected invocation does not meet confirmed process prerequisites");
    } else if (!iteration) {
      if (!context.executionId) throw new Error("Conditional reads require a checkpointed execution identity");
      const completed = await services.repository.readAuthoritative(state => {
        const execution = state.executions[context.executionId!];
        if (execution?.status !== "RUNNING" || execution.workflowSnapshot?.yaml !== yaml || !execution.readProgress) throw new Error("Conditional execution is not current");
        return new Set(Object.values(execution.readProgress.attempts).filter(attempt => attempt.status === "DONE").map(attempt => attempt.nodeId));
      });
      // Original frozen verification still validates ALL declarations and mints
      // the exact-source capability below. This extra denial-only check proves
      // process prerequisites on the actual confirmed path, never on a skipped
      // branch that happened to appear earlier in the declaration catalog.
      const prefix = context.protectedOperation ? await services.repository.readAuthoritative(state =>
        protectedReadPrerequisiteYAML(services, state, context.executionId!, actorId, context.protectedOperation!, yaml, index, context.plan?.admissionPin, parameters)) :
        selectedPrerequisiteYAML(blueprint, authored.id, completed);
      if (!services.validator.validatePlan("ReadConfirmedPath", prefix, actor.role).passed) throw new Error("Selected read path does not meet confirmed process prerequisites");
    }
  }
  if (protectedJournal && blueprint.metadata?.controlFlow === undefined) throw new Error("Protected invocation requires its original structural source");
  const { signal, plan, dynamicPlan: _privateDynamicPlan, beforeDispatch, assertDispatch: _privateGuard, iteration: _privateIteration, protectedOperation: _privateProtectedOperation, protectedInvocation: _privateProtectedInvocation, ...metadata } = context;
  const gate = await validateWorkflow(services, "ReadToolBroker", yaml, actor, { ...metadata, ...(signal === undefined ? {} : { signal }) });
  if (!gate.result.passed || gate.token === null) throw new Error("Tool dispatch denied: deterministic verification failed");
  const identity = createDispatchIdentity(actor, bound.roleMap);
  // The original run receipt must remain authentic/current as well as the
  // fresh governance decision. Registry drift never silently rebinds a run.
  const resolved = await services.validator.evaluateResolvedStep(context.executionId ?? "ReadToolBroker", yaml, index, parameters, plan?.token ?? gate.token, identity, {
    ...metadata, actor: { id: actor.id, role: actor.role },
  });
  if (resolved.capability === null || resolved.violation !== null) throw new Error("Tool dispatch denied: no valid exact-argument capability");
  // Validation may await external services. Recheck current authority after
  // those waits; a revoked or changed identity cannot use an older capability.
  const finalDispatch = async () => {
    assertContext();
    if (protectedJournal) await services.repository.readAuthoritative(state => {
      assertContext(); protectedJournal.prerequisiteYAML(state, yaml, index, context.plan?.admissionPin, parameters);
    });
    if (context.protectedOperation) await services.repository.readAuthoritative(state => {
      assertContext(); protectedReadPrerequisiteYAML(services, state, context.executionId!, actorId, context.protectedOperation!, yaml, index, context.plan?.admissionPin, parameters);
    });
    const current = await services.repository.effectiveUser(actorId);
    if (current === null || current.status.toLowerCase() !== "active" || current.role !== actor.role ||
        !current.permissions.some((permission) => ["chat:use", "workflow:write", "workflow:run", "workflow:run_own"].includes(permission)) ||
        !tool.allowed_roles.includes(current.role)) throw new Error("Tool dispatch denied: actor authority changed during verification");
    await checkWorkflowScope(services, current, context.workflowId);
    // Server-owned checkpoint hook: cancellation and dispatch intent are checked
    // after all awaited policy work, immediately before entering the SDK.
    if (iteration) {
      // Rebuild from authoritative authenticated receipts after awaited policy
      // AND admission work. Check equality again inside the intent transaction.
      const fresh = await iteration.checkpoints.selectedEvidence(iteration.visit);
      if (!canonicalJSONBytes(fresh).equals(canonicalJSONBytes(selected))) throw new Error("Iteration prerequisite evidence changed during verification");
      checkSelectedPath(fresh);
      await iteration.checkpoints.dispatchIntent(iteration.visit, current.role, { selectedEvidence: fresh, assertContext: assertIterationContext });
    } else await beforeDispatch?.(current.role);
    assertContext();
    assertContract();
  };
  // Old injected session fixtures retain their existing hook semantics. A
  // collection cannot use that fallback: its binding requires SDK-entry/v1.
  if (session.dispatchBoundary !== "sdk-entry/v1") await finalDispatch();
  const readErrorBinding = Object.freeze({});
  try {
    return await session.clientFor(tool, dispatchPin).execute(authored.action!, resolved.capability, parameters, identity, context.signal,
      session.dispatchBoundary === "sdk-entry/v1" ? finalDispatch : undefined, assertContext, undefined, readErrorBinding);
  } catch (cause) {
    const evidence = consumeAcknowledgedReadErrorEvidence(cause, readErrorBinding);
    if (evidence) {
      // New broker-owned exception: SDK replay of an older broker error cannot
      // inherit evidence belonging to a different invocation.
      const error = new ErpbridgeMcpToolError(structuredClone(evidence.result));
      const businessFailure: ReviewedReadBusinessFailure | undefined = errorReviewPin && tool.read_error_contract &&
        evidence.remoteBusinessError === tool.read_error_contract.remote_type ? {
          profile: "reviewed-read-business-failure/v1", code: tool.read_error_contract.business_error,
          toolId: tool.tool_id, contractHash: errorReviewPin.contractHash, admissionPin: structuredClone(errorReviewPin),
        } : undefined;
      acknowledgedFailures.set(error, { result: evidence.result, ...(businessFailure ? { businessFailure } : {}) });
      throw error;
    }
    if (acknowledgedReadToolFailure(cause))
      throw new Error("ERPBridge read outcome is unconfirmed for this invocation", { cause });
    throw cause;
  }
}

async function checkWorkflowScope(services: HandlerServices, actor: { id: string; permissions: string[] }, workflowId: string | undefined): Promise<void> {
  if (workflowId === undefined) return;
  const workflow = await services.repository.read((state) => state.workflows[workflowId] ?? null);
  if (workflow === null || workflow.archived || (!actor.permissions.includes("workflow:run") &&
      (!actor.permissions.includes("workflow:run_own") || (workflow.owner.id !== actor.id && !(workflow.assignedUserIds ?? []).includes(actor.id)))))
    throw new Error("Tool dispatch denied: workflow execution access was revoked");
}
