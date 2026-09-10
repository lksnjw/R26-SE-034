import { z } from "zod";
import { jsonObjectSchema, workflowStepBlueprintSchema, type Workflow } from "../models/schemas.js";
import { parseWorkflowYAMLStrict, stringifyWorkflowYAML, workflowContentHash } from "../parser/workflow.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import { readControlFlowSchema, readPredicateSchema, structuralNodes } from "./read-control-flow.js";
import { draftFlow, locateFlowNode, insertionScope, moveDraftNode, saveDraftFlow } from "./draft-control-edits.js";
import { readMergeSchema, readReturnSchema } from "./read-values.js";

export const nodeIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const nodePatchSchema = z.object({ action: z.string().min(1).max(128).optional(), description: z.string().max(2000).optional(), parameters: jsonObjectSchema.optional() }).strict().refine(value => Object.keys(value).length > 0);
const analysisInputSchema = z.string().min(1).max(1000).regex(/^\{\{[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\}\}$/).refine(value => !value.startsWith("{{input."), "Analysis input must come from a prior node output");
const analysisOutputSchema = jsonObjectSchema.refine(value => value.type === "object", "Analysis output schema must be an object");
export const analysisNodePatchSchema = z.object({ description: z.string().max(2000).optional(), instruction: z.string().min(1).max(4000).optional(),
  input: analysisInputSchema.optional(), output_schema: analysisOutputSchema.optional(),
  data_class: z.enum(["public", "internal", "confidential", "restricted"]).optional(), model: z.string().max(256).refine(value => !value.includes(":latest"), "Floating model IDs are not supported").optional(),
  max_input_items: z.number().int().min(1).max(10_000).optional(), max_input_chars: z.number().int().min(1).max(200_000).optional(),
  max_output_tokens: z.number().int().min(1).max(8_192).optional() }).strict().refine(value => Object.keys(value).length > 0);
const analysisNodeSchema = z.object({ id: nodeIdSchema, kind: z.literal("analysis"), description: z.string().max(2000).optional(), instruction: z.string().min(1).max(4000),
  input: analysisInputSchema, output_schema: analysisOutputSchema, data_class: z.enum(["public", "internal", "confidential", "restricted"]),
  model: z.string().max(256).refine(value => !value.includes(":latest"), "Floating model IDs are not supported").optional(), max_input_items: z.number().int().min(1).max(10_000).optional(),
  max_input_chars: z.number().int().min(1).max(200_000).optional(), max_output_tokens: z.number().int().min(1).max(8_192).optional() }).strict();
export const conditionPatchSchema = z.object({ predicate: readPredicateSchema }).strict();
export const returnPatchSchema = z.object({ output: readReturnSchema }).strict();
const destinationSchema = z.union([z.object({ conditionId: nodeIdSchema, branch: z.enum(["then", "else"]) }).strict(), z.object({ loopId: nodeIdSchema, scope: z.literal("body") }).strict()]);
const collectionConfig = { items: readReturnSchema.refine(value => value.schema.type === "array", "Collection requires an array schema"), maxItems: z.number().int().min(1).max(100), collect: readReturnSchema };
export const collectionPatchSchema = z.object(collectionConfig).partial().strict().refine(value => Object.keys(value).length > 0);
export const workflowRevisionSchema = { baseVersion: z.number().int().min(1), baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) };
export const nodeContextSchema = z.object({ workflowId: z.string().min(1).max(128), nodeId: nodeIdSchema, ...workflowRevisionSchema }).strict();
export type NodeContext = z.infer<typeof nodeContextSchema>;
export const workflowCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("updateNode"), nodeId: nodeIdSchema, patch: nodePatchSchema }).strict(),
  z.object({ type: z.literal("updateAnalysis"), nodeId: nodeIdSchema, patch: analysisNodePatchSchema }).strict(),
  z.object({ type: z.literal("addNode"), node: workflowStepBlueprintSchema, beforeNodeId: nodeIdSchema.nullable(), destination: destinationSchema.optional() }).strict(),
  z.object({ type: z.literal("addAnalysis"), node: analysisNodeSchema, beforeNodeId: nodeIdSchema.nullable() }).strict(),
  z.object({ type: z.literal("removeNode"), nodeId: nodeIdSchema }).strict(),
  z.object({ type: z.literal("moveNode"), nodeId: nodeIdSchema, beforeNodeId: nodeIdSchema.nullable(), destination: destinationSchema.optional() }).strict(),
  z.object({ type: z.literal("addCondition"), conditionId: nodeIdSchema, predicate: readPredicateSchema, beforeNodeId: nodeIdSchema.nullable(), destination: destinationSchema.optional() }).strict(),
  z.object({ type: z.literal("wrapNode"), nodeId: nodeIdSchema, conditionId: nodeIdSchema, predicate: readPredicateSchema, branch: z.enum(["then", "else"]) }).strict(),
  z.object({ type: z.literal("updateCondition"), nodeId: nodeIdSchema, patch: conditionPatchSchema }).strict(),
  z.object({ type: z.literal("removeCondition"), nodeId: nodeIdSchema }).strict(),
  z.object({ type: z.literal("setConditionMerge"), nodeId: nodeIdSchema, merge: readMergeSchema.nullable() }).strict(),
  z.object({ type: z.literal("addReturn"), nodeId: nodeIdSchema, output: readReturnSchema, beforeNodeId: nodeIdSchema.nullable(), destination: destinationSchema.optional() }).strict(),
  z.object({ type: z.literal("updateReturn"), nodeId: nodeIdSchema, patch: returnPatchSchema }).strict(),
  z.object({ type: z.literal("removeReturn"), nodeId: nodeIdSchema }).strict(),
  z.object({ type: z.literal("wrapCollection"), nodeId: nodeIdSchema, loopId: nodeIdSchema, ...collectionConfig }).strict(),
  z.object({ type: z.literal("updateCollection"), nodeId: nodeIdSchema, patch: collectionPatchSchema }).strict(),
  z.object({ type: z.literal("removeCollection"), nodeId: nodeIdSchema }).strict(),
  z.object({ type: z.literal("restoreDraft"), yaml: z.string().min(1).max(200000) }).strict(),
  z.object({ type: z.literal("undoDraft"), versionId: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("redoDraft"), versionId: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("restoreVersion"), versionId: z.string().min(1).max(128), contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal("setControlFlow"), flow: readControlFlowSchema }).strict(),
  z.object({ type: z.literal("discardProposal"), proposalId: z.string().min(1).max(128) }).strict(),
]);
export function selectedNodePatchSchema(node: { kind?: string | undefined }) {
  return node.kind === "foreach" ? collectionPatchSchema : node.kind === "return" ? returnPatchSchema : node.kind === "if" ? conditionPatchSchema : node.kind === "analysis" ? analysisNodePatchSchema : nodePatchSchema;
}
export function selectedNodePatchVersion(node: { kind?: string | undefined }) { return node.kind === "foreach" ? "prompt/collection-patch/v1" : node.kind === "return" ? "prompt/return-patch/v1" : node.kind === "if" ? "prompt/condition-patch/v1" : node.kind === "analysis" ? "prompt/analysis-node-patch/v1" : "prompt/node-patch/v2"; }
export function selectedNodePatchCommand(node: { id: string; kind?: string | undefined }, patch: unknown) {
  return workflowCommandSchema.parse({ type: node.kind === "foreach" ? "updateCollection" : node.kind === "return" ? "updateReturn" : node.kind === "if" ? "updateCondition" : node.kind === "analysis" ? "updateAnalysis" : "updateNode", nodeId: node.id, patch });
}
export function canViewWorkflow(workflow: Workflow, user: Pick<CurrentUser, "id" | "permissions">): boolean {
  if (workflow.emailDeliverySource && workflow.owner.id !== user.id) return false;
  return user.permissions.includes("workflow:read") || workflow.owner.id === user.id || (workflow.assignedUserIds ?? []).includes(user.id);
}
export function permittedWorkflow(workflow: Workflow, user: CurrentUser, editing: boolean): boolean {
  return !workflow.archived && (!editing || user.permissions.includes("workflow:write") && !workflow.emailDeliverySource && !workflow.recoverySource) &&
    canViewWorkflow(workflow, user);
}
export function assertWorkflowMutable(workflow: Workflow): void {
  if (workflow.emailDeliverySource) throw new HandlerFailure(409, "Chat email-delivery publications are immutable and managed only through their linked execution", { code: "EMAIL_DELIVERY_WORKFLOW_IMMUTABLE" });
  if (workflow.recoverySource) throw new HandlerFailure(409, "Linked recovery publications are immutable and managed only through their linked execution", { code: "RECOVERY_WORKFLOW_IMMUTABLE" });
}
export function requireWorkflowBase(workflow: Workflow, version: number, hash: string): void {
  if (workflow.draftVersion !== version || workflowContentHash(workflow.yaml) !== hash)
    throw new HandlerFailure(409, "This draft changed. Reload before applying the edit", { code: "DRAFT_REVISION_CONFLICT" });
}
export function assertCurrentWorkflowEditor(state: Readonly<RepositoryState>, workflow: Workflow, user: CurrentUser): CurrentUser {
  assertWorkflowMutable(workflow);
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
  const blueprint = parseWorkflowYAMLStrict(workflow.yaml);
  const node = blueprint.steps.find(step => step.id === context.nodeId) ?? (blueprint.metadata?.controlFlow === undefined ? undefined : structuralNodes(draftFlow(blueprint)).find(node => node.id === context.nodeId));
  if (!node) throw new HandlerFailure(422, "Selected node does not exist");
  return { workflow: structuredClone(workflow), node: structuredClone(node) };
}
export function applyWorkflowCommand(source: string, change: z.infer<typeof workflowCommandSchema>): string {
  if (change.type === "discardProposal") return source;
  if (change.type === "undoDraft" || change.type === "redoDraft" || change.type === "restoreVersion") throw new HandlerFailure(422, "History commands require a saved server revision");
  const blueprint = parseWorkflowYAMLStrict(change.type === "restoreDraft" ? change.yaml : source);
  if (change.type === "restoreDraft") return stringifyWorkflowYAML(blueprint);
  if (change.type === "setControlFlow") { blueprint.metadata = { ...blueprint.metadata, controlFlow: change.flow }; return stringifyWorkflowYAML(blueprint); }
  if (change.type === "wrapCollection" || change.type === "updateCollection" || change.type === "removeCollection") {
    const root = draftFlow(blueprint), found = locateFlowNode(root, change.nodeId);
    if (change.type === "wrapCollection") {
      if (!found || found.node.kind !== "action") throw new HandlerFailure(422, "Select one action to wrap in a collection");
      if (locateFlowNode(root, change.loopId)) throw new HandlerFailure(422, "Structural ID already exists");
      found.block.nodes[found.index] = { kind: "foreach", id: change.loopId, items: change.items, maxItems: change.maxItems, collect: change.collect, body: { kind: "sequence", nodes: [found.node] } };
    } else {
      if (!found || found.node.kind !== "foreach") throw new HandlerFailure(422, "Selected collection does not exist");
      if (change.type === "updateCollection") Object.assign(found.node, change.patch);
      else { if (found.node.body.nodes.length) throw new HandlerFailure(422, "Move or remove the collection body before removing its owner"); found.block.nodes.splice(found.index, 1); }
    }
    saveDraftFlow(blueprint, root); return stringifyWorkflowYAML(blueprint);
  }
  if (change.type === "setConditionMerge" || change.type === "addReturn" || change.type === "updateReturn" || change.type === "removeReturn") {
    const root = draftFlow(blueprint), found = locateFlowNode(root, change.nodeId);
    if (change.type === "addReturn") {
      if (found) throw new HandlerFailure(422, "Structural ID already exists");
      const target = insertionScope(root, change.beforeNodeId, change.destination); target.block.nodes.splice(target.index, 0, { kind: "return", id: change.nodeId, output: change.output });
    } else if (change.type === "setConditionMerge") {
      if (!found || found.node.kind !== "if") throw new HandlerFailure(422, "Selected condition does not exist");
      if (change.merge === null) delete found.node.merge; else found.node.merge = change.merge;
    } else {
      if (!found || found.node.kind !== "return") throw new HandlerFailure(422, "Selected return does not exist");
      if (change.type === "removeReturn") found.block.nodes.splice(found.index, 1); else found.node.output = change.patch.output;
    }
    saveDraftFlow(blueprint, root); return stringifyWorkflowYAML(blueprint);
  }
  if (["addCondition", "wrapNode", "updateCondition", "removeCondition"].includes(change.type) ||
      blueprint.metadata?.controlFlow !== undefined && ["addNode", "moveNode", "removeNode"].includes(change.type) ||
      (change.type === "addNode" || change.type === "moveNode") && change.destination) {
    const root = draftFlow(blueprint);
    if (change.type === "addCondition" || change.type === "wrapNode") {
      if (locateFlowNode(root, change.conditionId)) throw new HandlerFailure(422, "Structural ID already exists");
      const node = { kind: "if" as const, id: change.conditionId, predicate: change.predicate, then: { kind: "sequence" as const, nodes: [] as import("./read-control-flow.js").ReadControlNode[] }, else: { kind: "sequence" as const, nodes: [] as import("./read-control-flow.js").ReadControlNode[] } };
      if (change.type === "wrapNode") {
        const found = locateFlowNode(root, change.nodeId);
        if (!found || found.node.kind !== "action") throw new HandlerFailure(422, "Select an action to wrap in a condition");
        node[change.branch].nodes.push(found.node); found.block.nodes[found.index] = node;
      } else { const target = insertionScope(root, change.beforeNodeId, change.destination); target.block.nodes.splice(target.index, 0, node); }
    } else if (change.type === "updateCondition" || change.type === "removeCondition") {
      const found = locateFlowNode(root, change.nodeId);
      if (!found || found.node.kind !== "if") throw new HandlerFailure(422, "Selected condition does not exist");
      if (change.type === "updateCondition") found.node.predicate = change.patch.predicate;
      else {
        if (found.node.then.nodes.length || found.node.else.nodes.length) throw new HandlerFailure(422, "Move or remove the contents of both paths before removing this condition");
        found.block.nodes.splice(found.index, 1);
      }
    } else if (change.type === "addNode") {
      if (locateFlowNode(root, change.node.id)) throw new HandlerFailure(422, "Structural ID already exists");
      const target = insertionScope(root, change.beforeNodeId, change.destination);
      target.block.nodes.splice(target.index, 0, { kind: "action", nodeId: change.node.id }); blueprint.steps.push(change.node);
    } else if (change.type === "removeNode" || change.type === "moveNode") {
      if (change.type === "moveNode") moveDraftNode(root, change.nodeId, change.beforeNodeId, change.destination);
      else {
        const found = locateFlowNode(root, change.nodeId);
        if (!found || found.node.kind !== "action") throw new HandlerFailure(422, "Selected action does not exist");
        found.block.nodes.splice(found.index, 1);
        blueprint.steps = blueprint.steps.filter(step => step.id !== change.nodeId);
      }
    }
    if (blueprint.steps.length > 200) throw new HandlerFailure(422, "Draft must have at most 200 uniquely identified nodes");
    saveDraftFlow(blueprint, root); return stringifyWorkflowYAML(blueprint);
  }
  if (!["updateNode", "updateAnalysis", "addNode", "addAnalysis", "removeNode", "moveNode"].includes(change.type)) throw new HandlerFailure(422, "Unsupported structural command");
  if (change.type === "addAnalysis" && blueprint.metadata?.controlFlow !== undefined) throw new HandlerFailure(422, "Analysis nodes are supported only in a flat reviewed operation");
  if (change.type === "addCondition" || change.type === "wrapNode" || change.type === "updateCondition" || change.type === "removeCondition") throw new HandlerFailure(422, "Unsupported structural command");
  if (change.type === "addNode" || change.type === "addAnalysis") {
    if (blueprint.steps.some(step => step.id === change.node.id)) throw new HandlerFailure(422, "Node ID already exists");
    const index = change.beforeNodeId === null ? blueprint.steps.length : blueprint.steps.findIndex(step => step.id === change.beforeNodeId);
    if (index < 0) throw new HandlerFailure(422, "Insertion target does not exist");
    blueprint.steps.splice(index, 0, change.node);
  } else {
    const index = blueprint.steps.findIndex(step => step.id === change.nodeId);
    if (index < 0) throw new HandlerFailure(422, "Selected node does not exist");
    if (change.type === "updateNode" || change.type === "updateAnalysis") {
      const selected = blueprint.steps[index]!;
      if ((change.type === "updateAnalysis" && selected.kind !== "analysis") || (change.type === "updateNode" && selected.kind === "analysis"))
        throw new HandlerFailure(422, "The selected node type does not match this edit command");
      blueprint.steps[index] = { ...selected, ...change.patch };
    }
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
