import { stringify } from "yaml";
import type { HandlerServices } from "../http/handlers/common.js";
import { validateWorkflow } from "../http/handlers/common.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { createDispatchIdentity } from "./registry.js";
import { validateToolInput } from "./tool-input-schema.js";
import { withoutSecretFields } from "../redact/secrets.js";

// Phase-0 containment: only explicitly registered, role-granted reads may
// reach the SDK. Transaction writes await approval/idempotency/recovery.
export async function dispatchReadTool(
  services: HandlerServices,
  actorId: string,
  toolName: string,
  args: Record<string, unknown>,
  context: { signal?: AbortSignal | undefined; traceId?: string | undefined; sessionId?: string | undefined; workflowId?: string | undefined; executionId?: string | undefined } = {},
): Promise<Record<string, unknown>> {
  const actor = await services.repository.effectiveUser(actorId);
  if (actor === null || actor.status.toLowerCase() !== "active" ||
      !actor.permissions.some((permission) => ["chat:use", "workflow:write", "workflow:run", "workflow:run_own"].includes(permission)))
    throw new Error("Tool dispatch denied: current actor is not authorized");
  const session = services.erpbridgeSession;
  if (session === undefined) throw new Error("ERPBridge is not connected; tool dispatch is unavailable");
  const tools = await discoverTools(session, services.registries);
  const matches = tools.filter((tool) => tool.name === toolName || tool.mcp_tool_name === toolName);
  if (matches.length !== 1) throw new Error("Tool dispatch denied: tool has no unique admitted live contract");
  const tool = matches[0]!;
  if (!tool.is_read_only) throw new Error("Live ERP writes are blocked until transaction approval, idempotency and recovery are enforced");
  if (!tool.allowed_roles.includes(actor.role)) throw new Error("Tool dispatch denied: current role has no grant for this tool");
  if (Object.hasOwn(args, "role")) throw new Error("Tool dispatch denied: model-provided role is not allowed");
  const parameters = structuredClone(args);
  if (validateToolInput(tool.input_schema, parameters).length > 0) throw new Error("Tool dispatch denied: unsupported schema or invalid arguments");
  const issues = validateToolArguments(toolName, parameters, tool);
  if (issues.missing.length || issues.invalid.length) throw new Error("Tool dispatch denied: arguments failed runtime validation");
  const yaml = stringify({ name: "Authorized read", description: "One exact read proposed by the workspace agent", trigger: { type: "manual" }, steps: [{ id: "read", action: tool.name, parameters }] });
  const { signal, ...metadata } = context;
  const gate = await validateWorkflow(services, "ReadToolBroker", yaml, actor, { ...metadata, ...(signal === undefined ? {} : { signal }) });
  if (!gate.result.passed || gate.token === null) throw new Error("Tool dispatch denied: deterministic verification failed");
  const identity = createDispatchIdentity(actor, services.config.erpbridgeRoleMap);
  const resolved = await services.validator.evaluateResolvedStep("ReadToolBroker", yaml, 0, parameters, gate.token, identity);
  if (resolved.capability === null || resolved.violation !== null) throw new Error("Tool dispatch denied: no valid exact-argument capability");
  // Validation may await external services. Recheck current authority after
  // those waits; a revoked or changed identity cannot use an older capability.
  const current = await services.repository.effectiveUser(actorId);
  if (current === null || current.status.toLowerCase() !== "active" || current.role !== actor.role ||
      !current.permissions.some((permission) => ["chat:use", "workflow:write", "workflow:run", "workflow:run_own"].includes(permission)) ||
      !tool.allowed_roles.includes(current.role)) throw new Error("Tool dispatch denied: actor authority changed during verification");
  const envelope = await session.clientFor(tool).execute(tool.name, resolved.capability, parameters, identity, context.signal);
  const sanitized = withoutSecretFields(envelope) as Record<string, unknown>;
  // Structured and JSON-text MCP results must not send credential-shaped
  // fields into model context, chat persistence, exports or API responses.
  if (Array.isArray(sanitized.content)) sanitized.content = sanitized.content.map((block: unknown) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return block;
    const item = block as Record<string, unknown>;
    if (item.type !== "text" || typeof item.text !== "string") return item;
    try { return { ...item, text: JSON.stringify(withoutSecretFields(JSON.parse(item.text))) }; } catch { return item; }
  });
  return sanitized;
}
