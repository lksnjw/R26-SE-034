import { z } from "zod";
import type { Workflow } from "../models/schemas.js";
import type { RepositoryState, StoredRecord } from "../repository/store.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { HandlerFailure, nextID, type CurrentUser } from "../http/handlers/common.js";
import { applyWorkflowCommand, workflowCommandSchema } from "./commands.js";

const referenceSchema = z.object({ versionId: z.string().min(1).max(128), contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const historySchema = z.object({ profile: z.literal("draft-edit-history/v1"), undo: z.array(referenceSchema).max(100), redo: z.array(referenceSchema).max(100) }).strict();
type Reference = z.infer<typeof referenceSchema>;
type History = z.infer<typeof historySchema>;
type Command = z.infer<typeof workflowCommandSchema>;
const emptyHistory = (): History => ({ profile: "draft-edit-history/v1", undo: [], redo: [] });
const corrupt = () => new HandlerFailure(409, "Saved edit history needs repair; no draft was changed", { code: "DRAFT_HISTORY_INVALID" });

export function historyVersion(state: Readonly<RepositoryState>, workflow: Workflow, reference: Reference): StoredRecord {
  const matches = (state.versions[workflow.id] ?? []).filter(value => value.id === reference.versionId);
  const version = matches[0];
  if (matches.length !== 1 || !version || version.workflowId !== workflow.id || typeof version.yaml !== "string" || !version.yaml.length || version.yaml.length > 200000 ||
      !Number.isSafeInteger(version.version) || Number(version.version) < 1 || workflowContentHash(version.yaml) !== reference.contentHash ||
      version.contentHash !== undefined && version.contentHash !== reference.contentHash) throw corrupt();
  return version;
}

// History is part of the immutable version record, not a client-side stack or
// a mutable pointer to a publication. Publishing cannot grant undo authority.
export function savedDraftHistory(state: Readonly<RepositoryState>, workflow: Workflow): History | null {
  const active = (state.versions[workflow.id] ?? []).findLast(value => value.version === workflow.draftVersion && value.editHistory !== undefined);
  if (!active) return null;
  if (typeof active.id !== "string" || active.yaml !== workflow.yaml) throw corrupt();
  historyVersion(state, workflow, { versionId: active.id, contentHash: workflowContentHash(workflow.yaml) });
  const parsed = historySchema.safeParse(active.editHistory);
  if (!parsed.success) throw corrupt();
  for (const reference of [...parsed.data.undo, ...parsed.data.redo]) historyVersion(state, workflow, reference);
  return parsed.data;
}

export function draftHistorySummary(state: Readonly<RepositoryState>, workflow: Workflow) {
  const history = savedDraftHistory(state, workflow) ?? emptyHistory();
  return { profile: history.profile, undoDepth: history.undo.length, redoDepth: history.redo.length, undoTarget: history.undo.at(-1)?.versionId ?? null,
    redoTarget: history.redo.at(-1)?.versionId ?? null, undoLimit: 100, olderRevisions: "available_in_saved_history" };
}

export function resolveDraftCommand(state: Readonly<RepositoryState>, workflow: Workflow, command: Command): string {
  if (command.type === "restoreVersion") return String(historyVersion(state, workflow, { versionId: command.versionId, contentHash: command.contentHash }).yaml);
  if (command.type === "undoDraft" || command.type === "redoDraft") {
    const history = savedDraftHistory(state, workflow), target = history?.[command.type === "undoDraft" ? "undo" : "redo"].at(-1);
    if (!target || target.versionId !== command.versionId) throw new HandlerFailure(409, "Edit history changed. Reload before undoing or redoing", { code: "DRAFT_HISTORY_CONFLICT" });
    return String(historyVersion(state, workflow, target).yaml);
  }
  return applyWorkflowCommand(workflow.yaml, command);
}

export function saveDraftRevision(state: RepositoryState, workflow: Workflow, yaml: string, command: Command, actor: Pick<CurrentUser, "id" | "name">, passed: boolean) {
  if (yaml.length > 200000) throw new HandlerFailure(422, "Resulting draft exceeds supported limits");
  const blueprint = parseWorkflowYAMLStrict(yaml), history = savedDraftHistory(state, workflow) ?? emptyHistory();
  if ((command.type === "undoDraft" || command.type === "redoDraft" || command.type === "restoreVersion") && resolveDraftCommand(state, workflow, command) !== yaml)
    throw new HandlerFailure(409, "Saved revision changed during validation", { code: "DRAFT_HISTORY_CONFLICT" });
  const versions = state.versions[workflow.id] ?? [], beforeHash = workflowContentHash(workflow.yaml);
  let before = versions.findLast(value => typeof value.id === "string" && value.workflowId === workflow.id && value.version === workflow.draftVersion && value.yaml === workflow.yaml);
  if (!before) {
    before = { id: nextID(state, "ver"), workflowId: workflow.id, version: workflow.draftVersion, artifactState: "DRAFT", yaml: workflow.yaml,
      contentHash: beforeHash, createdAt: new Date().toISOString(), sourceUpdatedAt: workflow.updatedAt, createdBy: { id: actor.id, name: actor.name }, change: { type: "baseline" } };
    versions.push(before);
    state.versions[workflow.id] = versions;
  }
  const reference = { versionId: String(before.id), contentHash: beforeHash };
  historyVersion(state, workflow, reference);
  const nextHistory: History = command.type === "undoDraft" ? { ...history, undo: history.undo.slice(0, -1), redo: [...history.redo, reference].slice(-100) }
    : command.type === "redoDraft" ? { ...history, undo: [...history.undo, reference].slice(-100), redo: history.redo.slice(0, -1) }
    : { ...history, undo: [...history.undo, reference].slice(-100), redo: [] };
  workflow.yaml = yaml; workflow.draftVersion += 1; workflow.canRun = false;
  workflow.name = blueprint.name; workflow.description = blueprint.description ?? ""; workflow.steps = blueprint.steps.length; workflow.trigger = blueprint.trigger;
  workflow.status = passed ? "PENDING" : "draft-unvalidated"; workflow.updatedAt = new Date().toISOString(); delete workflow.canvas;
  const approvals = blueprint.steps.filter(step => step.kind === "approval").map(step => ({ stepId: step.id, description: step.description ?? "Runtime approval checkpoint" }));
  workflow.pendingGenerationApproval = approvals.length ? { steps: approvals, requestedAt: workflow.updatedAt } : null;
  const version = { id: nextID(state, "ver"), workflowId: workflow.id, version: workflow.draftVersion, artifactState: "DRAFT", yaml, contentHash: workflowContentHash(yaml),
    createdAt: workflow.updatedAt, createdBy: { id: actor.id, name: actor.name }, parentVersionId: before.id, editHistory: nextHistory,
    change: { type: command.type, ...("nodeId" in command ? { nodeId: command.nodeId } : command.type === "wrapProtected" ? { nodeId: command.protectedId } : {}), ...("versionId" in command ? { sourceVersionId: command.versionId } : {}) } };
  versions.push(version); state.versions[workflow.id] = versions;
  return version;
}

export function historyPage(state: Readonly<RepositoryState>, workflow: Workflow, beforeId?: string) {
  const all = (state.versions[workflow.id] ?? []).filter(value => typeof value.id === "string" && value.workflowId === workflow.id);
  const end = beforeId === undefined ? all.length : all.findIndex(value => value.id === beforeId);
  if (end < 0) throw new HandlerFailure(409, "History page changed. Reload saved history", { code: "DRAFT_HISTORY_CONFLICT" });
  const entries = all.slice(Math.max(0, end - 20), end).reverse().map(value => {
    const contentHash = typeof value.yaml === "string" ? workflowContentHash(value.yaml) : "";
    historyVersion(state, workflow, { versionId: String(value.id), contentHash });
    const blueprint = parseWorkflowYAMLStrict(String(value.yaml));
    const creator = z.object({ id: z.string().max(128), name: z.string().max(256) }).safeParse(value.createdBy);
    const change = z.object({ type: z.string().max(128), nodeId: z.string().max(128).optional(), sourceVersionId: z.string().max(128).optional() }).safeParse(value.change);
    return { id: value.id, version: value.version, artifactState: value.artifactState === "PUBLISHED" ? "PUBLISHED" : "DRAFT", contentHash,
      name: blueprint.name, nodeCount: blueprint.steps.length, createdAt: typeof value.createdAt === "string" && value.createdAt.length < 64 ? value.createdAt : undefined,
      createdBy: creator.success ? creator.data : undefined, change: change.success ? change.data : undefined,
      current: value.version === workflow.draftVersion && value.yaml === workflow.yaml };
  });
  return { entries, nextBeforeId: end > 20 ? entries.at(-1)?.id ?? null : null, total: all.length, ...draftHistorySummary(state, workflow) };
}
