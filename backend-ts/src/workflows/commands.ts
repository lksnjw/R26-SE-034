import { z } from "zod";
import { jsonObjectSchema, workflowStepBlueprintSchema, type Workflow } from "../models/schemas.js";
import { parseWorkflowYAMLStrict, stringifyWorkflowYAML, workflowContentHash } from "../parser/workflow.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";

export const nodeIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const nodePatchSchema = z.object({ action: z.string().min(1).max(128).optional(), description: z.string().max(2000).optional(), parameters: jsonObjectSchema.optional() }).strict().refine(value => Object.keys(value).length > 0);
export const workflowRevisionSchema = { baseVersion: z.number().int().min(1), baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) };
export const nodeContextSchema = z.object({ workflowId: z.string().min(1).max(128), nodeId: nodeIdSchema, ...workflowRevisionSchema }).strict();
export type NodeContext = z.infer<typeof nodeContextSchema>;
export const workflowCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("updateNode"), nodeId: nodeIdSchema, patch: nodePatchSchema }).strict(),
  z.object({ type: z.literal("addNode"), node: workflowStepBlueprintSchema, beforeNodeId: nodeIdSchema.nullable() }).strict(),
  z.object({ type: z.literal("removeNode"), nodeId: nodeIdSchema }).strict(),
  z.object({ type: z.literal("moveNode"), nodeId: nodeIdSchema, beforeNodeId: nodeIdSchema.nullable() }).strict(),
  z.object({ type: z.literal("restoreDraft"), yaml: z.string().min(1).max(200000) }).strict(),
  z.object({ type: z.literal("discardProposal"), proposalId: z.string().min(1).max(128) }).strict(),
]);
export function permittedWorkflow(workflow: Workflow, user: CurrentUser, editing: boolean): boolean {
  return !workflow.archived && (!editing || user.permissions.includes("workflow:write")) &&
    (user.permissions.includes("workflow:read") || workflow.owner.id === user.id || (workflow.assignedUserIds ?? []).includes(user.id));
}
export function requireWorkflowBase(workflow: Workflow, version: number, hash: string): void {
  if (workflow.draftVersion !== version || workflowContentHash(workflow.yaml) !== hash)
    throw new HandlerFailure(409, "This draft changed. Reload before applying the edit", { code: "DRAFT_REVISION_CONFLICT" });
}
export function assertCurrentWorkflowEditor(state: Readonly<RepositoryState>, workflow: Workflow, user: CurrentUser): CurrentUser {
  const account = state.users[user.id], role = account && state.roles[account.roleId];
  if (!account || account.status.toLowerCase() !== "active") throw new HandlerFailure(403, "Editing authority was revoked");
  const current = { ...account, role: role?.name ?? "", permissions: [...new Set([...(role?.permissions ?? []), ...account.permissionOverrides])] };
  if (current.role !== user.role || !permittedWorkflow(workflow, current, true)) throw new HandlerFailure(403, "Editing authority changed; reload the workspace");
  return current;
}
export function assertNodeContext(state: Readonly<RepositoryState>, context: NodeContext, user: CurrentUser) {
  const workflow = state.workflows[context.workflowId];
  if (!workflow) throw new HandlerFailure(404, "Workflow not found or not editable");
  assertCurrentWorkflowEditor(state, workflow, user);
  requireWorkflowBase(workflow, context.baseVersion, context.baseHash);
  if (workflow.yaml.length > 200000) throw new HandlerFailure(422, "Workflow source exceeds supported limits");
  const node = parseWorkflowYAMLStrict(workflow.yaml).steps.find(step => step.id === context.nodeId);
  if (!node) throw new HandlerFailure(422, "Selected node does not exist");
  return { workflow: structuredClone(workflow), node: structuredClone(node) };
}
export function applyWorkflowCommand(source: string, change: z.infer<typeof workflowCommandSchema>): string {
  if (change.type === "discardProposal") return source;
  const blueprint = parseWorkflowYAMLStrict(change.type === "restoreDraft" ? change.yaml : source);
  if (change.type === "restoreDraft") return stringifyWorkflowYAML(blueprint);
  if (change.type === "addNode") {
    if (blueprint.steps.some(step => step.id === change.node.id)) throw new HandlerFailure(422, "Node ID already exists");
    const index = change.beforeNodeId === null ? blueprint.steps.length : blueprint.steps.findIndex(step => step.id === change.beforeNodeId);
    if (index < 0) throw new HandlerFailure(422, "Insertion target does not exist");
    blueprint.steps.splice(index, 0, change.node);
  } else {
    const index = blueprint.steps.findIndex(step => step.id === change.nodeId);
    if (index < 0) throw new HandlerFailure(422, "Selected node does not exist");
    if (change.type === "updateNode") blueprint.steps[index] = { ...blueprint.steps[index]!, ...change.patch };
    else if (change.type === "removeNode") blueprint.steps.splice(index, 1);
    else {
      if (change.beforeNodeId === change.nodeId) throw new HandlerFailure(422, "A node cannot move before itself");
      const [node] = blueprint.steps.splice(index, 1);
      const target = change.beforeNodeId === null ? blueprint.steps.length : blueprint.steps.findIndex(step => step.id === change.beforeNodeId);
      if (target < 0) throw new HandlerFailure(422, "Move target does not exist");
      blueprint.steps.splice(target, 0, node!);
    }
  }
  if (blueprint.steps.length > 200 || new Set(blueprint.steps.map(step => step.id)).size !== blueprint.steps.length)
    throw new HandlerFailure(422, "Draft must have at most 200 uniquely identified nodes");
  return stringifyWorkflowYAML(blueprint);
}
