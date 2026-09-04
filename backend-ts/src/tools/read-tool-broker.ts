import { stringify } from "yaml";
import type { HandlerServices } from "../http/handlers/common.js";
import { validateWorkflow } from "../http/handlers/common.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { createDispatchIdentity } from "./registry.js";
import { validateToolInput } from "./tool-input-schema.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import { attachDispatchAuditTrace } from "../trace/audit-trace.js";
import { hasReservedBridgeRole } from "./erpbridge-contract.js";
import type { ReadAdmissionPin } from "../workflows/compiled-read.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { parseReadControlFlow } from "../workflows/read-control-flow.js";

export type ReadDispatchContext = { signal?: AbortSignal | undefined; traceId?: string | undefined; sessionId?: string | undefined; workflowId?: string | undefined; executionId?: string | undefined;
  beforeDispatch?: ((verifiedRole: string) => Promise<void>) | undefined;
  plan?: { yaml: string; stepIndex: number; token: ValidationToken; admissionPin?: ReadAdmissionPin; contractHash?: string; toolId?: string } };

// Phase-0 containment: only explicitly registered, role-granted reads may
// reach the SDK. Transaction writes await approval/idempotency/recovery.
export async function dispatchReadTool(
  services: HandlerServices,
  actorId: string,
  toolName: string,
  args: Record<string, unknown>,
  context: ReadDispatchContext = {},
): Promise<Record<string, unknown>> {
  const actor = await services.repository.effectiveUser(actorId);
  if (actor === null || actor.status.toLowerCase() !== "active" ||
      !actor.permissions.some((permission) => ["chat:use", "workflow:write", "workflow:run", "workflow:run_own"].includes(permission)))
    throw new Error("Tool dispatch denied: current actor is not authorized");
  await checkWorkflowScope(services, actor, context.workflowId);
  const session = services.erpbridgeSession;
  if (session === undefined) throw new Error("ERPBridge is not connected; tool dispatch is unavailable");
  const tools = await discoverTools(session, services.registries);
  const matches = tools.filter((tool) => tool.name === toolName || tool.mcp_tool_name === toolName);
  if (matches.length !== 1) throw new Error("Tool dispatch denied: tool has no unique admitted live contract");
  const tool = matches[0]!;
  const assertContract = () => { if (context.plan?.contractHash && (context.plan.toolId !== tool.tool_id || context.plan.contractHash !== capabilityContractHash(tool))) throw new Error("Compiled tool contract changed; no implicit rebinding is allowed"); };
  assertContract();
  await session.assertAdmission?.(tool, context.plan?.admissionPin);
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
  if (blueprint.metadata?.controlFlow !== undefined) {
    if (parseReadControlFlow(blueprint.metadata.controlFlow).schemaVersion === "read-control-flow/v3")
      throw new Error("Collection reads require governed iteration dispatch; flat completed-node evidence is not accepted");
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
    const prefix = stringify({ ...blueprint, steps: blueprint.steps.filter(step => step.id === authored.id || completed.has(step.id)) });
    if (!services.validator.validatePlan("ReadConfirmedPath", prefix, actor.role).passed) throw new Error("Selected read path does not meet confirmed process prerequisites");
  }
  const { signal, plan, beforeDispatch, ...metadata } = context;
  const gate = await validateWorkflow(services, "ReadToolBroker", yaml, actor, { ...metadata, ...(signal === undefined ? {} : { signal }) });
  if (!gate.result.passed || gate.token === null) throw new Error("Tool dispatch denied: deterministic verification failed");
  const identity = createDispatchIdentity(actor, services.config.erpbridgeRoleMap);
  // The original run receipt must remain authentic/current as well as the
  // fresh governance decision. Registry drift never silently rebinds a run.
  const resolved = await services.validator.evaluateResolvedStep(context.executionId ?? "ReadToolBroker", yaml, index, parameters, plan?.token ?? gate.token, identity);
  if (context.executionId !== undefined) await attachDispatchAuditTrace(services.repository, context.executionId, {
    ...metadata, actor: { id: actor.id, role: actor.role },
  });
  if (resolved.capability === null || resolved.violation !== null) throw new Error("Tool dispatch denied: no valid exact-argument capability");
  // Validation may await external services. Recheck current authority after
  // those waits; a revoked or changed identity cannot use an older capability.
  const current = await services.repository.effectiveUser(actorId);
  if (current === null || current.status.toLowerCase() !== "active" || current.role !== actor.role ||
      !current.permissions.some((permission) => ["chat:use", "workflow:write", "workflow:run", "workflow:run_own"].includes(permission)) ||
      !tool.allowed_roles.includes(current.role)) throw new Error("Tool dispatch denied: actor authority changed during verification");
  await checkWorkflowScope(services, current, context.workflowId);
  // Server-owned checkpoint hook: cancellation and dispatch intent are checked
  // after all awaited policy work, immediately before entering the SDK.
  await beforeDispatch?.(current.role);
  assertContract();
  const envelope = await session.clientFor(tool, context.plan?.admissionPin).execute(authored.action!, resolved.capability, parameters, identity, context.signal);
  return envelope;
}

async function checkWorkflowScope(services: HandlerServices, actor: { id: string; permissions: string[] }, workflowId: string | undefined): Promise<void> {
  if (workflowId === undefined) return;
  const workflow = await services.repository.read((state) => state.workflows[workflowId] ?? null);
  if (workflow === null || workflow.archived || (!actor.permissions.includes("workflow:run") &&
      (!actor.permissions.includes("workflow:run_own") || (workflow.owner.id !== actor.id && !(workflow.assignedUserIds ?? []).includes(actor.id)))))
    throw new Error("Tool dispatch denied: workflow execution access was revoked");
}
