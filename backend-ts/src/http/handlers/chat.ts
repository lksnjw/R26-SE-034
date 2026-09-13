import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import { requestTraceId } from "../../trace/request-trace.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, requestParam, stringValue } from "./common.js";
import { classifyIntent } from "../../agent/intent-classifier.js";
import { editEmailDraft, prepareEmailDraft } from "../../delivery/email-chat.js";
import { admitEmailDelivery } from "../../delivery/email-operation.js";
import { hasRecurringCompositionCapability, inspectRecurringAutomationCandidate, recurringAutomationCandidateContext,
  recurringAutomationShell, recurringDeliveryRequest, type RecurringAutomationComposition, type RecurringDeliveryRequest } from "../../delivery/recurring-automation.js";
import { runQueryLoop, type ToolStep } from "../../agent/query-loop.js";
import { runActionLoop } from "../../agent/action-loop.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import { validateSemantics } from "../../governance/semantic-validator.js";
import { isPolicyCheckerEnabled, checkErpPolicy } from "../../governance/rbac.js";
import { dispatchReadTool } from "../../tools/read-tool-broker.js";
import { modifyWorkflow } from "../../agent/workflow-modifier.js";
import { parseWorkflowYAMLStrict } from "../../parser/workflow.js";
import { stringify as yamlStringify } from "yaml";
import { assertActorAuthority, assertChatAuthority, requestedModel, selectProvider } from "./model-selection.js";
import { activeChatStatus, chatJobQueue } from "../../agent/chat-jobs.js";
import { processNodeProposal } from "../../agent/node-proposals.js";
import { chatSummary, createChat, deleteChat, getChat, listChats, updateChat } from "./chat-sessions.js";
import { buildCapabilitiesResponse, compactWorkflowArtifacts, errorText } from "./chat-artifacts.js";

/*******************************************************************************
 * Function: buildWorkflowYamlFromSteps
 *
 * Builds workflow YAML from chat tool steps and the user prompt.
 ******************************************************************************/
function buildWorkflowYamlFromSteps(steps: ToolStep[], userPrompt: string): string {
  const safeName = userPrompt.trim().slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Chat Workflow";
  const stepsYaml = steps
    .map((step, i) => {
      const friendlyDesc = step.toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const paramsJson = Object.keys(step.arguments).length > 0
        ? "\n    parameters:\n" + Object.entries(step.arguments).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join("\n")
        : "";
      return `  - id: step_${i + 1}\n    action: ${step.toolName}\n    description: "${friendlyDesc}"${paramsJson}`;
    })
    .join("\n");
  return `name: "${safeName}"\ndescription: "Saved from chat session"\nsteps:\n${stepsYaml}`;
}
// ── Workflows catalog (feasibility policy) ──────────────────────────────────
interface CatalogWorkflow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  allowed_roles: string[];
  requires_write: boolean;
  domain: string;
  doable: boolean;
}
interface WorkflowsCatalog {
  workflows: CatalogWorkflow[];
  globally_blocked: string[];
  role_notes: Record<string, string>;
}

let _catalogCache: WorkflowsCatalog | null = null;
/*******************************************************************************
 * Function: loadWorkflowsCatalog
 *
 * Loads and caches the workflow catalog and blocked-request patterns.
 ******************************************************************************/
function loadWorkflowsCatalog(): WorkflowsCatalog {
  if (_catalogCache !== null) return _catalogCache;
  try {
    const path = resolve(process.cwd(), "policy/workflows_catalog.json");
    _catalogCache = JSON.parse(readFileSync(path, "utf8")) as WorkflowsCatalog;
  } catch {
    _catalogCache = { workflows: [], globally_blocked: [], role_notes: {} };
  }
  return _catalogCache;
}

/*******************************************************************************
 * Function: checkFeasibility
 *
 * Checks a workflow request against catalog support and blocking rules.
 ******************************************************************************/
function checkFeasibility(request: string, userRole: string): { feasible: boolean; matchedWorkflow?: CatalogWorkflow; reason?: string } {
  const catalog = loadWorkflowsCatalog();
  const normalized = request.toLowerCase();

  // Check globally blocked phrases
  for (const blocked of catalog.globally_blocked) {
    if (normalized.includes(blocked.toLowerCase())) {
      return { feasible: false, reason: `This action ("${blocked}") is globally blocked and cannot be automated in this system.` };
    }
  }

  // Find best matching workflow by keyword scoring
  let bestMatch: CatalogWorkflow | undefined;
  let bestScore = 0;
  for (const workflow of catalog.workflows) {
    const score = workflow.keywords.reduce((acc, kw) => acc + (normalized.includes(kw.toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestMatch = workflow; }
  }

  if (bestMatch === undefined || bestScore === 0) {
    // No specific match — allow it to proceed (LLM will figure it out)
    return { feasible: true };
  }

  if (!bestMatch.doable) {
    return { feasible: false, matchedWorkflow: bestMatch, reason: `"${bestMatch.name}" is not supported in this ERP system.` };
  }

  const normalizedRole = userRole.trim();
  const allowed = bestMatch.allowed_roles.some((r) => r.toLowerCase() === normalizedRole.toLowerCase()) || normalizedRole === "Platform Admin";
  if (!allowed) {
    const roleNote = catalog.role_notes[normalizedRole] ?? `Role "${normalizedRole}" does not have access to this workflow.`;
    return {
      feasible: false,
      matchedWorkflow: bestMatch,
      reason: `Your role (**${normalizedRole}**) is not permitted to run "${bestMatch.name}".\n\n${roleNote}`,
    };
  }

  if (bestMatch.requires_write && normalizedRole === "Client") {
    return { feasible: false, matchedWorkflow: bestMatch, reason: `"${bestMatch.name}" requires write access. The **Client** role is read-only.` };
  }

  return { feasible: true, matchedWorkflow: bestMatch };
}

export const CHAT_UNHANDLED = Symbol("chat-unhandled");

/*******************************************************************************
 * Function: handleChatRoute
 *
 * Dispatches saved chat sessions, model catalog, and chat messages.
 ******************************************************************************/
export async function handleChatRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof CHAT_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/chat/sessions` && route.method === "GET") return listChats(request, reply, user, services);
  if (route.path === `${base}/chat/models` && route.method === "GET") return reply.send(ok(
    services.providerRuntime?.catalog() ?? { configured: false, binding: null, models: [] }, "Configured chat models loaded; remote compatibility is not certified", null));
  if (route.path === `${base}/chat/sessions` && route.method === "POST") return createChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id` && route.method === "GET") return getChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id` && route.method === "PATCH") return updateChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id` && route.method === "DELETE") return deleteChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id/messages`) return sendChatMessage(request, reply, user, services);
  return CHAT_UNHANDLED;
}

/*******************************************************************************
 * Function: sendChatMessage
 *
 * Handles a chat message through the matching query, action, or workflow
 * flow.
 ******************************************************************************/
async function sendChatMessage(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  if (Object.hasOwn(body, "emailDeliveryCommand")) return reply.status(202).send(ok(
    await admitEmailDelivery(services, user, requestParam(request, "id"), body.emailDeliveryCommand, requestTraceId(request), request),
    "Independent approval requested for the exact draft; nothing has been sent", null));
  if (Object.hasOwn(body, "emailDraftCommand")) return reply.send(ok(await editEmailDraft(services, user, requestParam(request, "id"), body.emailDraftCommand, request), "Email draft saved; nothing sent", null));
  if (body.delivery === "async-chat") return reply.status(202).send(ok(
    await chatJobQueue(services).admit(requestParam(request, "id"), user, body, requestTraceId(request)), "Chat operation acknowledged; no business completion is implied", null));
  if (body.delivery !== undefined) throw new HandlerFailure(400, "Unsupported chat delivery mode");
  if (Object.hasOwn(body, "nodeContext")) throw new HandlerFailure(400, "Selected node prompts require saved asynchronous chat admission");
  const content = stringValue(body.content).trim() === "" ? stringValue(body.message).trim() : stringValue(body.content).trim();
  if (content === "") throw new HandlerFailure(400, "message is required");
  const previousModel = await services.repository.read((state) => state.chats[requestParam(request, "id")]?.selectedModel);
  const provider = selectProvider(services, requestedModel(body.model) ?? previousModel);
  if (provider !== undefined) services = { ...services, providerRuntime: provider };
  const intent = classifyIntent(content);
  const traceId = requestTraceId(request);
  const stored = await services.repository.mutate((state) => {
    const id = requestParam(request, "id");
    if (Object.values(state.chatOperations).some(op => op.sessionId === id && activeChatStatus(op.status)))
      throw new HandlerFailure(409, "This conversation has an active operation; wait or cancel before sending another message", { code: "CHAT_OPERATION_ACTIVE" });
    let chat = state.chats[id];
    if (chat === undefined) { const timestamp = now(); chat = { id, ownerId: user.id, title: content.slice(0, 80), createdAt: timestamp, updatedAt: timestamp, messageCount: 0, messages: [] }; state.chats[id] = chat; }
    if (chat.ownerId !== user.id && (intent === "EMAIL_DELIVERY" || !user.permissions.includes("workflow:write"))) throw new HandlerFailure(404, "Chat session not found");
    assertChatAuthority(state, user, id);
    if (provider?.binding) chat.selectedModel = provider.binding.model;
    const priorMessages = chat.messages.map((message) => `${stringValue(message.role)}: ${stringValue(message.text)}`);
    const userMessage = { id: nextID(state, "msg"), role: "user", text: content, createdAt: now(), traceId, ...(provider?.binding ? { modelBinding: provider.binding } : {}) };
    chat.messages.push(userMessage); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    return { session: chatSummary(chat), userMessage, priorMessages };
  });
  return reply.send(await processStoredChat({
    body, content, sessionId: requestParam(request, "id"), traceId, stored,
    user, services, ...(request.signal ? { signal: request.signal } : {}), request,
  }));
}

/** Shared synchronous/queued processing; no HTTP reply or request lifetime is
 * required by the worker. Saved input/context is admitted separately. */
export async function processStoredChat(input: {
  body: Record<string, unknown>; content: string; sessionId: string; traceId: string;
  stored: import("../../agent/chat-context.js").StoredChatInput;
  user: CurrentUser; services: HandlerServices; signal?: AbortSignal;
  request?: FastifyRequest; hooks?: import("../../agent/chat-context.js").ChatProcessingHooks;
}) {
  const { body, content, sessionId, traceId, stored, user, services, signal, request, hooks } = input;
  if (body.nodeContext !== undefined) {
    if (!hooks) throw new HandlerFailure(400, "Selected node prompts require saved chat operations");
    return processNodeProposal({ context: body.nodeContext, content, sessionId, traceId, user, services, ...(signal ? { signal } : {}), hooks });
  }
  const provider = services.providerRuntime;
  const intent = classifyIntent(content);
  const automationRequest = recurringDeliveryRequest(content);
  const bodyWorkflowCtx = isRecord(body.workflowContext) ? body.workflowContext : null;
  const workflowContextYaml = typeof bodyWorkflowCtx?.yaml === "string" && bodyWorkflowCtx.yaml.trim() ? bodyWorkflowCtx.yaml.trim() : null;
  const workflowContextName = typeof bodyWorkflowCtx?.name === "string" && bodyWorkflowCtx.name ? bodyWorkflowCtx.name : "Workflow";
  const chatMutation = <T>(mutation: (state: import("../../repository/store.js").RepositoryState) => T) =>
    services.repository.mutate((state) => {
      hooks?.assertCurrent(state);
      const value = mutation(state);
      if (isRecord(value) && value.role === "assistant") hooks?.saved(state, value);
      return value;
    });
  const readTool = (name: string, args: Record<string, unknown>) => hooks
    ? hooks.read(name, args, beforeDispatch => dispatchReadTool(services, user.id, name, args, { signal, traceId, sessionId, beforeDispatch }))
    : dispatchReadTool(services, user.id, name, args, { signal, traceId, sessionId });
  await hooks?.stage("PREPARING");
  // Prepend workflow YAML context as a synthetic assistant message so the LLM can answer questions about it
  const augmentedPriorMessages = workflowContextYaml
    ? [`assistant: I have the following workflow loaded for context:\n**${workflowContextName}**\n\`\`\`yaml\n${workflowContextYaml}\n\`\`\``, ...stored.priorMessages]
    : stored.priorMessages;
  const preserveRecurringShell = async (requestValue: RecurringDeliveryRequest, compositionFailure?: "COMPOSITION_UNAVAILABLE" | "CAPABILITY_DISCOVERY_UNAVAILABLE" | "NO_REVIEWED_COMPOSITION_CAPABILITY") => {
    await hooks?.stage("GENERATING");
    const yaml = recurringAutomationShell(content, requestValue), timestamp = now();
    const savedAutomation = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      let workflowId: string | null = null;
      if (user.permissions.includes("workflow:write")) {
        workflowId = nextID(state, "wf");
        state.workflows[workflowId] = { id: workflowId, name: `${requestValue.cadence === "custom" ? "Recurring" : requestValue.cadence} delivery automation`,
          description: "Incomplete recurring delivery workflow preserved from chat", owner: { id: user.id, name: user.name }, assignedUserIds: [], status: "PENDING",
          trigger: { type: "manual" }, steps: 0, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [],
          canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false, chatSessionId: sessionId,
          chatMessageId: stringValue(stored.userMessage.id), prompt: content, traceId } as unknown as import("../../models/schemas.js").Workflow;
        hooks?.artifact(state, { type: "workflow-draft", id: workflowId });
      }
      const reason = compositionFailure === undefined ? "The configured model or ERPBridge connection is unavailable." :
        compositionFailure === "NO_REVIEWED_COMPOSITION_CAPABILITY" ? "No exact reviewed report or delivery capability is currently available." :
          compositionFailure === "CAPABILITY_DISCOVERY_UNAVAILABLE" ? "Current ERPBridge capability discovery could not be confirmed." :
            "The generated composition did not satisfy the server-owned recurring-workflow contract.";
      const text = workflowId ? `Recurring automation shell saved in the canvas. ${reason} It is incomplete, has not been published or executed, and no schedule is active. Resolve the listed requirements before publication and activate recurrence only through the scheduler.` :
        `Recurring automation requirements were preserved, but your current role cannot save a workflow. ${reason} Nothing was sent and no schedule is active.`;
      const artifacts = { intent: "WORKFLOW", yaml, selected_workflow_yaml: yaml, ...(workflowId ? { workflowId } : {}), automationRequest: requestValue,
        ...(compositionFailure ? { compositionFailure } : {}), can_execute: false, validation_passed: false,
        validation: { passed: false, failed_rules: ["SCHEMA_INVALID", "UNRESOLVED_REQUIREMENTS"], warnings: [] },
        blocking_errors: requestValue.requirements, next_action: "REVIEW_DRAFT" };
      const assistantMessage = { id: nextID(state, "msg"), role: "assistant", text, artifacts, createdAt: timestamp, traceId };
      chat.messages.push(assistantMessage); chat.messageCount = chat.messages.length; chat.updatedAt = timestamp; hooks?.saved(state, assistantMessage);
      return { workflowId, assistantMessage, text, artifacts };
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: savedAutomation.assistantMessage, answer: savedAutomation.text,
      intent: "ACTION", workflowDraft: { yaml }, validation: savedAutomation.artifacts.validation }, "Recurring workflow shell preserved; no schedule or delivery occurred", null);
  };
  // ── Feasibility / role-policy check ─────────────────────────────────────
  // Controlled by the Policy Checker toggle in Settings (state.settings.rbac.enabled).
  const policyCheckerEnabled = await isPolicyCheckerEnabled(services.repository);
  if (policyCheckerEnabled) {
    const feasibility = checkFeasibility(content, user.role);
    if (!feasibility.feasible) {
      const denialText = feasibility.matchedWorkflow
        ? `**Request blocked by policy.**\n\n${feasibility.reason}`
        : `**Request blocked.**\n\n${feasibility.reason ?? "This action is not permitted in this system."}`;
      const assistantMessage = await chatMutation((state) => {
        const chat = assertChatAuthority(state, user, sessionId);
        const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: denialText, artifacts: { intent: "POLICY_DENIAL", blockedWorkflow: feasibility.matchedWorkflow?.id ?? null }, createdAt: now(), traceId };
        chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
        return message;
      });
      return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: denialText, intent: "POLICY_DENIAL" }, "Message processed", null);
    }
  }
  if (intent === "EMAIL_DELIVERY") {
    const result = await prepareEmailDraft(services, user, sessionId, content, request, { ...(signal ? { signal } : {}), traceId, ...(hooks ? { hooks } : {}) });
    return ok({ session: stored.session, userMessage: stored.userMessage, ...result }, "Email draft prepared; nothing sent", null);
  }
  if (intent === "ACTION" && automationRequest &&
      (services.synthesis === undefined || services.erpbridgeSession === undefined || services.providerRuntime?.configured !== true))
    return preserveRecurringShell(automationRequest);
  if (["QUERY", "AUDIT", "TOOL_CALL"].includes(intent) &&
      (services.erpbridgeSession === undefined || services.providerRuntime?.configured !== true)) {
    const code = services.erpbridgeSession === undefined ? "ERPBRIDGE_NOT_CONNECTED" : "PROVIDER_NOT_CONFIGURED";
    const text = code === "ERPBRIDGE_NOT_CONNECTED"
      ? "ERPBridge is not connected. I cannot retrieve ERP data or execute tools for this request. No ERP operation was performed."
      : "The agent provider is not configured. I cannot plan this request. No ERP operation was performed.";
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", text, artifacts: { intent, blocked: true, code }, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: text,
      intent, blocked: true, operation: { success: false, code } }, "Message processed; ERP operation unavailable", null);
  }
  if (intent === "CAPABILITIES") {
    const liveCapTools = await discoverTools(services.erpbridgeSession ?? null, services.registries);
    const capText = buildCapabilitiesResponse(liveCapTools);
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: capText, artifacts: { intent: "CAPABILITIES" }, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: capText, intent }, "Message processed", null);
  }
  if ((intent === "QUERY" || intent === "AUDIT") && services.providerRuntime?.configured === true) {
    // Offer only registered, role-granted read contracts. Optional advisory
    // settings cannot broaden the dispatchable tool pool.
    let readOnlyTools: readonly import("../../registry/schemas.js").ToolDefinition[] = [];
    if (services.erpbridgeSession !== undefined) {
      readOnlyTools = (await discoverTools(services.erpbridgeSession, services.registries))
        .filter((tool) => tool.is_read_only && tool.allowed_roles.includes(user.role));
    }
    const chatHistory = augmentedPriorMessages.map((line) => {
      const sep = line.indexOf(": ");
      return sep > -1 ? { role: line.slice(0, sep), text: line.slice(sep + 2) } : { role: "user", text: line };
    });
    let loopResult;
    try {
      loopResult = await runQueryLoop(
        { userMessage: content, chatHistory, sessionId, actorId: user.id, actorRole: user.role, ...(signal ? { signal } : {}), traceId, ...(hooks ? { onTurn: () => hooks.stage("MODEL") } : {}) },
        readOnlyTools,
        readTool,
        services.providerRuntime,
        true,
      );
    } catch (error) {
      throw new HandlerFailure(502, `Query agent failed: ${errorText(error)}`);
    }
    const workflowDraft = loopResult.readOutcome === "READS_COMPLETED" && !loopResult.narrativeRejected
      ? buildWorkflowYamlFromSteps(loopResult.toolSteps, content)
      : undefined;
    const queryArtifacts = {
      intent,
      sources: loopResult.toolCallLog,
      toolSteps: loopResult.toolSteps,
      boundHit: loopResult.boundHit,
      iterationsUsed: loopResult.iterationsUsed,
      latencyMs: loopResult.latencyMs,
      readOutcome: loopResult.readOutcome,
      narrativeRejected: loopResult.narrativeRejected,
      ...(loopResult.visualisation !== undefined ? { visualisation: loopResult.visualisation } : {}),
      ...(workflowDraft !== undefined ? { workflowDraft } : {}),
    };
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: loopResult.text, artifacts: queryArtifacts, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({
      session: stored.session,
      userMessage: stored.userMessage,
      assistantMessage,
      answer: loopResult.text,
      intent,
      sources: loopResult.toolCallLog,
      toolSteps: loopResult.toolSteps,
      ...(loopResult.visualisation !== undefined ? { visualisation: loopResult.visualisation } : {}),
      ...(workflowDraft !== undefined ? { workflowDraft } : {}),
      boundHit: loopResult.boundHit,
      modelBinding: provider?.binding ?? null,
      usage: { inputTokens: loopResult.totalTokens.input, outputTokens: loopResult.totalTokens.output, measured: loopResult.totalTokens.measured === true },
    }, "Message processed", null);
  }
  if (intent === "TOOL_CALL" && services.erpbridgeSession !== undefined && services.providerRuntime?.configured === true) {
    const bridgeSession = services.erpbridgeSession;
    const allTools = await discoverTools(bridgeSession, services.registries);
    const chatHistory = augmentedPriorMessages.map((line) => {
      const sep = line.indexOf(": ");
      return sep > -1 ? { role: line.slice(0, sep), text: line.slice(sep + 2) } : { role: "user", text: line };
    });
    const governanceUser = { id: user.id, role: user.role, department: user.departmentId };
    let actionResult;
    try {
      actionResult = await runActionLoop(
        { userMessage: content, chatHistory, sessionId, actorId: user.id, actorRole: user.role, user: governanceUser, ...(signal ? { signal } : {}), traceId, ...(hooks ? { onTurn: () => hooks.stage("MODEL") } : {}) },
        allTools,
        readTool,
        // Required write authorization cannot be disabled by an advisory toggle.
        async (toolName, toolDef, args, govUser) =>
              checkErpPolicy(bridgeSession, {
                userId: govUser.id,
                userRole: govUser.role,
                action: toolName,
                prompt: `User "${govUser.id}" (${govUser.role}) wants to execute: ${toolDef.display_name ?? toolName}`,
                context: { tool: toolName, arguments: args },
              }),
        services.providerRuntime,
      );
    } catch (error) {
      throw new HandlerFailure(502, `Action agent failed: ${errorText(error)}`);
    }
    const actionArtifacts = {
      intent: "TOOL_CALL",
      steps: actionResult.steps,
      blocked: actionResult.blocked,
      workflowDraft: actionResult.workflowYaml,
      toolSteps: actionResult.steps.map((s) => ({ toolName: s.toolName, arguments: s.arguments, result: s.result })),
    };
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: actionResult.text, artifacts: actionArtifacts, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({
      session: stored.session,
      userMessage: stored.userMessage,
      assistantMessage,
      answer: actionResult.text,
      intent,
      steps: actionResult.steps,
      blocked: actionResult.blocked,
      workflowDraft: actionResult.workflowYaml,
      modelBinding: provider?.binding ?? null,
      usage: { inputTokens: actionResult.totalTokens.input, outputTokens: actionResult.totalTokens.output, measured: actionResult.totalTokens.measured === true },
    }, "Message processed", null);
  }

  if (intent === "WORKFLOW_MODIFY" && services.providerRuntime?.configured === true) {
    const lastWorkflowYaml = await services.repository.read((state) => {
      const chat = state.chats[sessionId];
      if (chat === undefined) return null;
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        const msg = chat.messages[i] as Record<string, unknown>;
        const artifacts = msg.artifacts as Record<string, unknown> | undefined;
        const yaml = artifacts?.yaml ?? artifacts?.selected_workflow_yaml ?? artifacts?.workflowDraft;
        if (typeof yaml === "string" && yaml.trim().length > 0) return yaml;
        if (typeof yaml === "object" && yaml !== null && typeof (yaml as Record<string, unknown>).yaml === "string") {
          return (yaml as Record<string, unknown>).yaml as string;
        }
      }
      return null;
    });

    const effectiveYaml = lastWorkflowYaml ?? workflowContextYaml;
    if (effectiveYaml !== null) {
      await hooks?.stage("GENERATING");
      const modResult = await modifyWorkflow(effectiveYaml, content, services.providerRuntime, signal);
      const responseText = modResult.ok
        ? `I've prepared a workflow change proposal: ${modResult.changeDescription}\n\nReview the proposal in the panel; it is not saved, published or executed.`
        : `I wasn't able to apply that modification: ${modResult.errorMessage ?? "Unknown error"}`;
      const modArtifacts = modResult.ok
        ? { intent: "WORKFLOW", yaml: modResult.yaml, selected_workflow_yaml: modResult.yaml, can_execute: false, validation: { passed: false, failed_rules: [], warnings: [] } }
        : { intent: "WORKFLOW_MODIFY_ERROR" };
      const assistantMessage = await chatMutation((state) => {
        const chat = assertChatAuthority(state, user, sessionId);
        const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: responseText, artifacts: modArtifacts, createdAt: now(), traceId };
        chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
        return message;
      });
      return ok({
        session: stored.session,
        userMessage: stored.userMessage,
        assistantMessage,
        answer: responseText,
        intent,
        ...(modResult.ok ? { yaml: modResult.yaml } : {}),
      }, "Message processed", null);
    }
    // Fall through to synthesis if no previous workflow found in chat
  }

  if (intent !== "ACTION") {
    // Non-ACTION intents that reached here (e.g. TOOL_CALL with no bridge) — reply conversationally.
    const fallbackMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const msg = {
        id: nextID(state, "msg"),
        role: "assistant",
        text: "I'm not sure how to help with that. Try asking me to list data from the ERP system, create a workflow, or describe what you need.",
        artifacts: { intent },
        createdAt: now(),
        traceId,
      };
      chat.messages.push(msg); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return msg;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: fallbackMessage, answer: fallbackMessage.text, intent }, "Message processed", null);
  }

  if (services.synthesis === undefined) throw new HandlerFailure(502, "Chat orchestration is not configured");
  let liveToolsForSynthesis: readonly import("../../registry/schemas.js").ToolDefinition[];
  try { liveToolsForSynthesis = await discoverTools(services.erpbridgeSession ?? null, services.registries); }
  catch (error) {
    if (automationRequest) return preserveRecurringShell(automationRequest, "CAPABILITY_DISCOVERY_UNAVAILABLE");
    throw error;
  }
  if (automationRequest && !hasRecurringCompositionCapability(automationRequest, liveToolsForSynthesis, user.role))
    return preserveRecurringShell(automationRequest, "NO_REVIEWED_COMPOSITION_CAPABILITY");
  let result;
  await hooks?.stage("GENERATING");
  try { result = await services.synthesis.synthesize({ prompt: content, userRole: user.role, user: { id: user.id, role: user.role, department: user.departmentId }, ...(provider === undefined ? {} : { providerRuntime: provider }), priorMessages: augmentedPriorMessages,
    ...(automationRequest ? { candidateContext: recurringAutomationCandidateContext(automationRequest),
      candidateValidator: (yaml: string) => { inspectRecurringAutomationCandidate(yaml, automationRequest, liveToolsForSynthesis, user.role); } } : {}),
    ...(signal ? { signal } : {}), traceId, sessionId: sessionId, messageId: stringValue(stored.userMessage.id), liveTools: liveToolsForSynthesis }); }
  catch (error) {
    if (automationRequest) return preserveRecurringShell(automationRequest, "COMPOSITION_UNAVAILABLE");
    const errText = errorText(error);
    const errorDetail = errText.split(":").at(-1)?.trim() || errText;
    const friendlyText = errText.includes("HTTP 400") || errText.includes("Generation attempt failed") || errText.includes("Candidate generation failed")
      ? "I wasn't able to generate a workflow for this request.\n\nThis usually happens when the request involves capabilities not available in this ERP system (e.g. tax verification, sanctions checking, email notifications), or when the AI model is temporarily unavailable.\n\nTry asking for a simpler workflow, or check **Capabilities** to see what this system supports."
      : `Unable to generate workflow — the generation service encountered an error. Please try again.\n\n_${errorDetail}_`;
    const errMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const msg = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: friendlyText, artifacts: { intent: "WORKFLOW_ERROR" }, createdAt: now(), traceId };
      chat.messages.push(msg); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return msg;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: errMessage, answer: friendlyText, intent: "WORKFLOW_ERROR" }, "Message processed", null);
  }
  const automationComposition: RecurringAutomationComposition | null = automationRequest ?
    inspectRecurringAutomationCandidate(result.yaml, automationRequest, liveToolsForSynthesis, user.role) : null;
  // Preserve the proposed program exactly. Unknown actions are reported, not
  // renamed by heuristics or silently removed along with their business intent.
  const liveToolNameSet = new Set(liveToolsForSynthesis.flatMap((tool) => [tool.name, tool.mcp_tool_name]));
  let missingTools: string[] = [];
  try {
    missingTools = parseWorkflowYAMLStrict(result.yaml).steps
      .filter((step) => (step.kind === undefined || step.kind === "" || step.kind === "tool") && !liveToolNameSet.has(step.action ?? ""))
      .map((step) => step.action ?? "");
  } catch { /* Invalid proposals remain visible as drafts, never published. */ }
  // Autosave a draft only. Verification and publication are separate actions.
  const chatSessionId = sessionId;
  const chatMessageId = stringValue(stored.userMessage.id);
  let autoSavedWorkflowId: string | null = null;
  // Build acceptance and runtime transaction checkpoints are separate. Saving
  // or accepting this draft never removes or authorizes runtime approval nodes.
  let pendingGenerationApproval: { steps: Array<{ stepId: string; description: string }>; requestedAt: string } | null = null;
  try {
    let blueprint;
    try { blueprint = parseWorkflowYAMLStrict(result.yaml); } catch { blueprint = null; }
    if (blueprint !== null && user.permissions.includes("workflow:write")) {
      const approvalSteps = blueprint.steps
        .filter((s) => s.kind === "approval")
        .map((s) => ({ stepId: s.id, description: (s.description ?? "").trim() || `Approval required for step ${s.id}` }));
      const nowTs = new Date().toISOString();
      if (approvalSteps.length > 0) pendingGenerationApproval = { steps: approvalSteps, requestedAt: nowTs };
      autoSavedWorkflowId = await chatMutation((state) => {
        assertChatAuthority(state, user, chatSessionId);
        state.counter += 1;
        const wfId = `wf_${state.counter}_${randomBytes(4).toString("hex")}`;
        const wf = {
          id: wfId,
          name: blueprint!.name || content.slice(0, 60) || "Generated Workflow",
          description: (blueprint as Record<string, unknown>).description as string ?? "",
          owner: { id: user.id, name: user.name },
          assignedUserIds: [],
          status: "PENDING",
          trigger: blueprint!.trigger,
          steps: blueprint!.steps.length,
          successRate: 0,
          lastRunAt: null,
          publishedVersion: 0,
          draftVersion: 1,
          tags: [],
          domainTags: [],
          canRun: false,
          createdAt: nowTs,
          updatedAt: nowTs,
          yaml: result.yaml,
          archived: false,
          chatSessionId,
          chatMessageId: stringValue(stored.userMessage.id),
          prompt: content,
          traceId,
          pendingGenerationApproval,
        };
        state.workflows[wfId] = wf as unknown as import("../../models/schemas.js").Workflow;
        hooks?.artifact(state, { type: "workflow-draft", id: wfId });
        return wfId;
      });
    }
  } catch (error) { if (error instanceof HandlerFailure) throw error; /* Other save failures remain explicit proposals. */ }

  // State claims come from persistence/validation, not an additional model.
  const assistantText = [
    autoSavedWorkflowId ? automationComposition ? "Recurring workflow steps saved as an editable draft. They have not been published, scheduled or executed." : "Workflow draft saved. It has not been published or executed." : "Workflow proposal prepared, but no saved draft was acknowledged.",
    result.validation.passed ? "Structural and registry validation passed; this is not execution readiness." : "Validation failed; review the reported issues before publishing.",
    automationComposition ? `${automationComposition.mappedSteps.length} exact reviewed capability step${automationComposition.mappedSteps.length === 1 ? " was" : "s were"} mapped. ${automationComposition.remainingRequirements.length} requirement${automationComposition.remainingRequirements.length === 1 ? " remains" : "s remain"}; no schedule is active.` : "",
    missingTools.length ? "Some requested actions have no admitted live ERPBridge contract. The original proposal was preserved." : "",
    pendingGenerationApproval ? "Build acceptance is pending. Runtime approval checkpoints remain required for each transaction." : "",
  ].filter(Boolean).join("\n\n");
  const artifacts = compactWorkflowArtifacts(result, chatSessionId, chatMessageId, traceId, autoSavedWorkflowId, missingTools, pendingGenerationApproval,
    automationRequest, automationComposition);
  const assistantMessage = await chatMutation((state) => {
    const chat = assertChatAuthority(state, user, sessionId);
    const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: assistantText, artifacts, createdAt: now(), traceId };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    return message;
  });
  const retrieval = result.retrieval as { tools?: unknown[]; rules?: unknown[]; global_rules?: unknown[] };
  return ok({
    session: stored.session,
    userMessage: stored.userMessage,
    assistantMessage,
    answer: assistantText,
    yaml: result.yaml,
    workflowDraft: { ...result.candidate, chatSessionId, chatMessageId, traceId },
    validation: result.validation,
    flowPreview: null,
    usage: { inputTokens: result.candidate.generation_metadata.inputTokens, outputTokens: result.candidate.generation_metadata.outputTokens, measured: result.candidate.generation_metadata.measured },
    retrieval: result.retrieval,
    toolCandidates: retrieval.tools ?? [],
    ruleCandidates: [...(retrieval.rules ?? []), ...(retrieval.global_rules ?? [])],
  }, "Message processed", null);
}
