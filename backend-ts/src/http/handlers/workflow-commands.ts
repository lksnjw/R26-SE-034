import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok, fail, type Workflow } from "../../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import { inspectReadWorkflow } from "../../runner/read-workflow.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import { requestTraceId } from "../../trace/request-trace.js";
import { appendAudit, HandlerFailure, nextID, type CurrentUser, type HandlerServices } from "./common.js";
import type { RepositoryState } from "../../repository/store.js";
import { canonicalJSONBytes } from "../../core/canonical-json.js";
import { supportsReadJobs } from "../../runner/read-jobs.js";
import { promptData } from "../../prompts/contracts.js";
import { assertChatAuthority, selectProvider } from "./model-selection.js";
import { activeChatStatus } from "../../agent/chat-jobs.js";
import { prepareCompiledExecution } from "../../workflows/read-compilation-lifecycle.js";
import { nodeIdSchema as id, nodePatchSchema as patch, workflowRevisionSchema as base, workflowCommandSchema as command,
  permittedWorkflow as permitted, requireWorkflowBase as requireBase, assertCurrentWorkflowEditor, applyWorkflowCommand as apply } from "../../workflows/commands.js";
export { assertCurrentWorkflowEditor } from "../../workflows/commands.js";

const requestSchema = z.object({ ...base, command, proposalId: z.string().min(1).max(128).optional() }).strict();
const proposalSchema = z.object({ ...base, nodeId: id, prompt: z.string().trim().min(1).max(4000), sessionId: z.string().min(1).max(128), model: z.string().trim().min(1).max(256).optional() }).strict();

function record(workflow: Workflow) { return { workflowId: workflow.id, version: workflow.draftVersion, contentHash: workflowContentHash(workflow.yaml), yaml: workflow.yaml, publishedVersion: workflow.publishedVersion, canRun: workflow.canRun }; }
function ownedProposal(state: RepositoryState, actorId: string, workflowId: string, proposalId: string) {
  for (const chat of Object.values(state.chats)) {
    if (chat.ownerId !== actorId) continue;
    for (const message of chat.messages) {
      const artifact = message.artifacts as { proposal?: Record<string, unknown> } | undefined;
      const item = artifact?.proposal;
      if (item?.id === proposalId && item.workflowId === workflowId) {
        if (item.status !== "PROPOSED") throw new HandlerFailure(409, "Proposal was already resolved");
        return { item, chat };
      }
    }
  }
  throw new HandlerFailure(404, "Owned proposal not found");
}

export async function handleWorkflowCommand(kind: "commands" | "node-proposals" | "readiness", request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  try {
    const workflowId = String((request.params as { id: string }).id);
    const current = await services.repository.read((state) => structuredClone(state.workflows[workflowId] ?? null));
    if (current === null || !permitted(current, user, kind !== "readiness")) throw new HandlerFailure(404, "Workflow not found or not editable");
    if (current.yaml.length > 200000) throw new HandlerFailure(422, "Workflow source exceeds supported limits");
    const traceId = requestTraceId(request, current.traceId);
    if (kind === "readiness") {
      const validation = services.validator.validatePlan("WorkspaceReadiness", current.yaml, user.role);
      let issues: string[] = [], bridge = "not_connected";
      try {
        const blueprint = parseWorkflowYAMLStrict(current.yaml);
        issues = inspectReadWorkflow(blueprint, services.registries.snapshot().tools, user.role);
        if (services.erpbridgeSession !== undefined) {
          bridge = "discovery_available";
          try { issues.push(...inspectReadWorkflow(blueprint, await discoverTools(services.erpbridgeSession, services.registries), user.role)); }
          catch { bridge = "discovery_failed"; }
        }
      } catch { issues.push("Workflow could not be parsed"); }
      const published = await services.repository.read((state) => (state.versions[workflowId] ?? []).some((version) => version.artifactState === "PUBLISHED" && version.version === current.publishedVersion && version.yaml === current.yaml));
      const compilation = await services.repository.readAuthoritative(state => {
        const version = (state.versions[workflowId] ?? []).findLast(value => value.artifactState === "PUBLISHED" && value.version === current.publishedVersion && value.yaml === current.yaml);
        if (!version) return { state: "NOT_PUBLISHED" };
        try { return { state: "CURRENT", receipt: prepareCompiledExecution(state, services, version, current.yaml, user.role).receipt }; }
        catch { return { state: "BLOCKED", reason: "Review and explicitly republish current capability bindings" }; }
      });
      if (compilation.state === "BLOCKED") issues.push("Published execution artifact needs current capability review and explicit re-publication");
      const canAttempt = user.permissions.some((permission) => ["workflow:run", "workflow:run_own"].includes(permission)) &&
        (user.permissions.includes("workflow:run") || current.owner.id === user.id || (current.assignedUserIds ?? []).includes(user.id));
      return reply.send(ok({ ...record(current), validation, issues: [...new Set(issues)], bridge, published, compilation,
        can_attempt_run: canAttempt && published && compilation.state === "CURRENT" && validation.passed && !issues.length && bridge === "discovery_available" && !current.pendingGenerationApproval?.steps.length,
        read_job_admission: supportsReadJobs(services) ? "read-job-v1" : "unavailable",
        authorization: "rechecked_at_dispatch", executionProfile: "sequential-read-v1" }, "Readiness checked", { traceId }));
    }
    if (kind === "node-proposals") {
      const parsed = proposalSchema.safeParse(request.body);
      if (!parsed.success) throw new HandlerFailure(400, "Invalid node proposal request");
      const value = parsed.data;
      requireBase(current, value.baseVersion, value.baseHash);
      const node = parseWorkflowYAMLStrict(current.yaml).steps.find((step) => step.id === value.nodeId);
      if (!node) throw new HandlerFailure(422, "Selected node does not exist");
      if (!(await services.repository.read((state) => state.chats[value.sessionId]?.ownerId === user.id))) throw new HandlerFailure(404, "Chat session not found");
      if (!services.providerRuntime?.configured) throw new HandlerFailure(503, "Configure a model provider before requesting a node proposal", { code: "PROVIDER_NOT_CONFIGURED" });
      const sessionModel = await services.repository.read((state) => {
        if (Object.values(state.chatOperations).some(op => op.sessionId === value.sessionId && activeChatStatus(op.status))) throw new HandlerFailure(409, "This conversation has an active operation", { code: "CHAT_OPERATION_ACTIVE" });
        return assertChatAuthority(state, user, value.sessionId).selectedModel;
      });
      const provider = selectProvider(services, value.model ?? sessionModel)!;
      const prompt = promptData({ instruction: value.prompt, node: withoutSecretFields(node), tools: services.registries.snapshot().tools.filter((tool) => tool.allowed_roles.includes(user.role)).map((tool) => ({ name: tool.name, inputSchema: tool.input_schema })) });
      let proposed: z.infer<typeof patch>;
      try {
        const response = await provider.generateCandidate(prompt, "prompt/node-patch/v2", (output) => { patch.parse(JSON.parse(output.text)); }, request.signal,
          { traceId, workflowId, ...(value.sessionId ? { sessionId: value.sessionId } : {}), actor: { id: user.id, role: user.role } });
        proposed = patch.parse(JSON.parse(response.text));
      } catch { throw new HandlerFailure(422, "The model did not return a supported node patch; nothing was changed", { code: "NODE_PROPOSAL_INVALID" }); }
      const change = { type: "updateNode" as const, nodeId: node.id, patch: proposed };
      const yaml = apply(current.yaml, change);
      const validation = services.validator.validatePlan("NodeProposal", yaml, user.role);
      const proposal = await services.repository.mutate((state) => {
        if (Object.values(state.chatOperations).some(op => op.sessionId === value.sessionId && activeChatStatus(op.status))) throw new HandlerFailure(409, "This conversation has an active operation", { code: "CHAT_OPERATION_ACTIVE" });
        const scopedChat = assertChatAuthority(state, user, value.sessionId);
        if (provider.binding) scopedChat.selectedModel = provider.binding.model;
        const fresh = state.workflows[workflowId];
        if (!fresh || !permitted(fresh, user, true)) throw new HandlerFailure(404, "Workflow not editable");
        assertCurrentWorkflowEditor(state, fresh, user);
        requireBase(fresh, value.baseVersion, value.baseHash);
        const result = { id: nextID(state, "proposal"), workflowId, nodeId: node.id, baseVersion: value.baseVersion, baseHash: value.baseHash, command: change, before: node, after: { ...node, ...proposed }, validation, status: "PROPOSED", modelBinding: provider.binding };
        if (value.sessionId) {
          const chat = state.chats[value.sessionId];
          if (!chat || chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat session not found");
          chat.messages.push({ id: nextID(state, "msg"), role: "user", text: value.prompt, createdAt: new Date().toISOString(), traceId, artifacts: { intent: "NODE_EDIT_REQUEST", workflowId, nodeId: node.id } },
            { id: nextID(state, "msg"), role: "assistant", text: "Node change proposed. Review and apply it to save a new draft; nothing has been published or executed.", createdAt: new Date().toISOString(), traceId, artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal: result } });
          chat.messageCount = chat.messages.length; chat.updatedAt = new Date().toISOString();
        }
        return result;
      });
      return reply.send(ok(proposal, "Node change proposed; draft unchanged", { traceId }));
    }
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) throw new HandlerFailure(400, "Invalid workflow command");
    requireBase(current, parsed.data.baseVersion, parsed.data.baseHash);
    const yaml = apply(current.yaml, parsed.data.command);
    if (yaml.length > 200000) throw new HandlerFailure(422, "Resulting draft exceeds supported limits");
    const validation = services.validator.validatePlan("WorkflowCommand", yaml, user.role);
    const updated = await services.repository.mutate((state) => {
      const fresh = state.workflows[workflowId];
      if (!fresh || !permitted(fresh, user, true)) throw new HandlerFailure(404, "Workflow not editable");
      const editor = assertCurrentWorkflowEditor(state, fresh, user);
      requireBase(fresh, parsed.data.baseVersion, parsed.data.baseHash);
      if (parsed.data.command.type === "discardProposal") {
        const { item, chat } = ownedProposal(state, user.id, workflowId, parsed.data.command.proposalId);
        item.status = "DISCARDED"; item.resolvedAt = new Date().toISOString(); item.resolvedBy = user.id;
        chat.updatedAt = String(item.resolvedAt);
        appendAudit(state, editor, "workflow.proposal.discard", "workflow", workflowId, {}, { proposalId: item.id }, request);
        return structuredClone(fresh);
      }
      if (parsed.data.proposalId) {
        const { item, chat } = ownedProposal(state, user.id, workflowId, parsed.data.proposalId);
        if (item.baseHash !== parsed.data.baseHash || item.baseVersion !== parsed.data.baseVersion ||
            !canonicalJSONBytes(item.command).equals(canonicalJSONBytes(parsed.data.command)))
          throw new HandlerFailure(409, "Applied command does not match the saved proposal");
        item.status = "APPLIED"; item.appliedVersion = fresh.draftVersion + 1;
        item.resolvedAt = new Date().toISOString(); item.resolvedBy = user.id; chat.updatedAt = String(item.resolvedAt);
      }
      const beforeHash = workflowContentHash(fresh.yaml);
      fresh.yaml = yaml; fresh.draftVersion += 1; fresh.canRun = false;
      const blueprint = parseWorkflowYAMLStrict(yaml);
      fresh.name = blueprint.name; fresh.description = blueprint.description ?? ""; fresh.steps = blueprint.steps.length;
      fresh.trigger = blueprint.trigger; fresh.status = validation.passed ? "PENDING" : "draft-unvalidated";
      fresh.updatedAt = new Date().toISOString(); delete fresh.canvas;
      // An edit invalidates proposal acceptance, but never removes approval nodes.
      const approvals = blueprint.steps.filter((step) => step.kind === "approval").map((step) => ({ stepId: step.id, description: step.description ?? "Runtime approval checkpoint" }));
      fresh.pendingGenerationApproval = approvals.length ? { steps: approvals, requestedAt: fresh.updatedAt } : null;
      const versions = state.versions[workflowId] ?? [];
      versions.push({ id: nextID(state, "ver"), workflowId, version: fresh.draftVersion, artifactState: "DRAFT", yaml, createdAt: fresh.updatedAt, createdBy: { id: user.id, name: user.name } });
      state.versions[workflowId] = versions;
      appendAudit(state, editor, "workflow.command", "workflow", workflowId, { contentHash: beforeHash }, { contentHash: workflowContentHash(yaml), command: parsed.data.command.type, version: fresh.draftVersion, ...(parsed.data.proposalId ? { proposalId: parsed.data.proposalId } : {}) }, request);
      return structuredClone(fresh);
    });
    return reply.send(ok({ ...record(updated), validation }, parsed.data.command.type === "discardProposal" ? "Proposal discarded; draft unchanged" : "Draft saved; not published or executed", { traceId }));
  } catch (error) {
    if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
    return reply.status(422).send(fail("Workflow command could not be parsed; nothing was changed", null));
  }
}
