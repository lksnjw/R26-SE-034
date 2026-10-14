import type { CurrentUser, HandlerServices } from "../http/handlers/common.js";
import { assertActorAuthority } from "../http/handlers/model-selection.js";
import { assertNodeContext, nodeContextSchema } from "../workflows/commands.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import type { ChatProcessingHooks } from "../agent/chat-context.js";
import { evaluateOptionalPolicy, type PolicyRequest } from "./optional-policy.js";
import type { RepositoryState } from "../repository/store.js";

type ChatPolicyInput = { prompt: string; intent: string; nodeContext?: unknown; signal?: AbortSignal | undefined;
  traceId: string; sessionId: string; hooks?: ChatProcessingHooks | undefined };

/** Project only verified authoring facts. No source, parameters or outputs. */
export async function prepareChatPolicyRequest(services: Pick<HandlerServices, "repository" | "registries">, user: CurrentUser, input: ChatPolicyInput): Promise<PolicyRequest> {
  const selected = input.nodeContext === undefined ? undefined : nodeContextSchema.parse(input.nodeContext);
  const selectedNode = selected === undefined ? undefined : await services.repository.read(state => {
    input.hooks?.assertCurrent(state as import("../repository/store.js").RepositoryState);
    assertActorAuthority(state, user);
    const { node } = assertNodeContext(state, selected, user);
    const action = "action" in node && typeof node.action === "string" ? node.action : undefined;
    const connection = "connection_id" in node ? node.connection_id : undefined;
    const matches = services.registries.snapshot().tools.filter(tool => tool.name === action &&
      (tool.connection_id ?? "erpbridge-default") === (connection ?? "erpbridge-default"));
    const reviewed = matches.length === 1 && matches[0]!.bridge_contract && !hasReservedBridgeRole(matches[0]!) ? matches[0] : undefined;
    return { ...selected, kind: node.kind ?? "tool", ...(action ? { action: action.slice(0, 128) } : {}),
      ...(reviewed ? { reviewedReadOnly: reviewed.is_read_only } : {}), authoringPermissionVerified: true };
  });
  return { prompt: input.prompt, action: "chat_request",
    context: { intent: input.intent, ...(selectedNode ? { stage: "unapplied_node_proposal", selectedNode,
      apply: false, publication: false, execution: false, candidateValidated: false } : {}) },
    signal: input.signal, traceId: input.traceId, sessionId: input.sessionId };
}

export function assertChatPolicyContext(state: Readonly<RepositoryState>, user: CurrentUser, request: PolicyRequest): void {
  assertActorAuthority(state, user);
  if (request.context?.selectedNode !== undefined) {
    const selected = request.context.selectedNode as Record<string, unknown>;
    assertNodeContext(state, nodeContextSchema.parse({ workflowId: selected.workflowId, nodeId: selected.nodeId,
      baseVersion: selected.baseVersion, baseHash: selected.baseHash }), user);
  }
}

export async function evaluateChatPolicy(services: HandlerServices, user: CurrentUser, input: ChatPolicyInput) {
  const request = await prepareChatPolicyRequest(services, user, input);
  const result = await evaluateOptionalPolicy(services, user, request);
  if (input.nodeContext !== undefined && result.decision === "allow") await services.repository.read(state => {
    input.hooks?.assertCurrent(state as import("../repository/store.js").RepositoryState);
    assertChatPolicyContext(state, user, request);
  });
  return result;
}
