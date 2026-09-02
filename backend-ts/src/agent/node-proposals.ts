import { ok } from "../models/schemas.js";
import { HandlerFailure, nextID, now, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { assertNodeContext, applyWorkflowCommand, nodeContextSchema, nodePatchSchema } from "../workflows/commands.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { promptData } from "../prompts/contracts.js";
import type { ChatProcessingHooks } from "./chat-context.js";

/** A node edit is a proposal, never a tool request, irrespective of its prose. */
export async function processNodeProposal(input: { context: unknown; content: string; sessionId: string; traceId: string;
  user: CurrentUser; services: HandlerServices; signal?: AbortSignal; hooks: ChatProcessingHooks }) {
  const { services, user, hooks, sessionId, traceId, signal } = input;
  const context = nodeContextSchema.parse(input.context);
  const provider = services.providerRuntime;
  if (!provider?.configured) throw new HandlerFailure(503, "Configure a provider before requesting a node proposal");
  const scoped = await services.repository.read(state => {
    hooks.assertCurrent(state as import("../repository/store.js").RepositoryState);
    return assertNodeContext(state, context, user);
  });
  const prompt = promptData({ instruction: input.content, node: withoutSecretFields(scoped.node),
    tools: services.registries.snapshot().tools.filter(tool => tool.allowed_roles.includes(user.role)).map(tool => ({ name: tool.name, inputSchema: tool.input_schema })) });
  await hooks.stage("GENERATING_NODE_PROPOSAL");
  let patch: ReturnType<typeof nodePatchSchema.parse>;
  try {
    const response = await provider.generateCandidate(prompt, "prompt/node-patch/v2", output => { nodePatchSchema.parse(JSON.parse(output.text)); }, signal,
      { traceId, workflowId: context.workflowId, sessionId, actor: { id: user.id, role: user.role } });
    patch = nodePatchSchema.parse(JSON.parse(response.text));
  } catch { throw new HandlerFailure(422, "A supported node patch was not returned; nothing was changed", { code: "NODE_PROPOSAL_INVALID" }); }
  const command = { type: "updateNode" as const, nodeId: context.nodeId, patch };
  const yaml = applyWorkflowCommand(scoped.workflow.yaml, command);
  if (yaml.length > 200000) throw new HandlerFailure(422, "Proposed draft exceeds supported limits");
  const validation = services.validator.validatePlan("NodeProposal", yaml, user.role);
  // Generation can outlive cancellation, permission changes and concurrent edits.
  // Commit proposal, message and terminal journal in the same fenced mutation.
  const result = await services.repository.mutate(state => {
    hooks.assertCurrent(state);
    const fresh = assertNodeContext(state, context, user);
    const chat = assertChatAuthority(state, user, sessionId);
    const proposal = { id: nextID(state, "proposal"), ...context, command, before: fresh.node,
      after: { ...fresh.node, ...patch }, validation, status: "PROPOSED", modelBinding: provider.binding };
    const message = { id: nextID(state, "msg"), role: "assistant", text: "Node change proposed. Review and apply it to save a new draft; nothing has been published or executed.",
      createdAt: now(), traceId, artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal } };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    hooks.artifact(state, { type: "node-proposal", id: proposal.id });
    hooks.saved(state, message);
    return { proposal, assistantMessage: message };
  });
  return ok(result, "Node change proposed; draft unchanged", { traceId });
}
