import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { canReadExecution } from "../http/execution-scope.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import { operationCaseEvidence } from "./operation-reconciliation.js";

const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const id = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const operationRecoveryCommandSchema = z.object({ intentId: id, sourceVersion: z.number().int().positive(), factsHash: hash,
  reconciliationId: id, queryId: id, idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict();
const sourceSchema = z.object({ executionId: id, workflowId: id, workflowVersion: z.number().int().positive(), snapshotHash: hash,
  compilationHash: hash, intentId: id, nodeId: id, invocationId: id, reconciliationId: id, queryId: id,
  outcome: z.literal("NOT_APPLIED"), reconciliationRecordedAt: z.string().datetime() }).strict();
const actionSchema = z.object({ toolId: id, toolName: z.string().min(1).max(500), remoteToolName: z.string().min(1).max(1000), effectClass: z.string().min(1).max(100),
  connectionId: id, connectionBinding: z.string().min(1).max(1000), capabilityId: id, capabilityRevision: id, admissionVersion: z.number().int().positive(),
  contractHash: hash, argumentHash: hash, arguments: z.record(z.string(), z.unknown()) }).strict();
const requirementsSchema = z.tuple([z.literal("current-capability-validation"), z.literal("fresh-independent-approval"), z.literal("new-execution-and-intent"), z.literal("new-idempotency-boundary")]);
const artifactSchema = z.object({ profile: z.literal("operation-recovery-artifact/v1"), id, state: z.literal("REVIEW_REQUIRED"), source: sourceSchema, action: actionSchema,
  createdBy: z.object({ id, roleId: id, role: z.string().min(1).max(256) }).strict(), createdAt: z.string().datetime(), requirements: requirementsSchema,
  dispatchAuthority: z.literal(false), sourceRunUnchanged: z.literal(true), keyHash: hash, requestFingerprint: hash, artifactHash: hash }).strict();
export type OperationRecoveryArtifact = z.infer<typeof artifactSchema>;

function deny(message: string, status = 409): never { throw new HandlerFailure(status, message, { code: "OPERATION_RECOVERY_ARTIFACT_DENIED" }); }
function requireStorage(repository: Repository) {
  const storage = repository.persistence;
  if (storage && (storage.readQueueDurability !== "encrypted-single-writer" || storage.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !storage.saveExecutionCheckpoint))
    deny("Recovery artifacts require qualified encrypted scoped checkpoints", 503);
  repository.assertAuthority();
}
function sourceFor(value: ReturnType<typeof operationCaseEvidence>) {
  const resolution = value.history.at(-1);
  if (!value.resolved || !resolution || resolution.basis !== "queried-operation-state" || resolution.outcome !== "NOT_APPLIED" ||
      value.intent.reconciliationId !== resolution.id) deny("A linked recovery plan requires a closed reviewed NOT_APPLIED status observation");
  const admission = value.node.capability.admission;
  if (!admission || value.node.effectClass === "read") deny("The reconciled action cannot produce a recovery plan");
  const snapshot = value.execution.workflowSnapshot!;
  return {
    resolution,
    source: { executionId: value.execution.id, workflowId: value.execution.workflowId, workflowVersion: snapshot.version, snapshotHash: snapshot.contentHash,
      compilationHash: digest(snapshot.operationCompilation), intentId: value.intent.id, nodeId: value.intent.nodeId, invocationId: value.intent.invocationId,
      reconciliationId: resolution.id, queryId: resolution.queryId, outcome: "NOT_APPLIED" as const, reconciliationRecordedAt: resolution.recordedAt },
    action: { toolId: value.tool.tool_id, toolName: value.tool.name, remoteToolName: exactBridgeName(value.tool), effectClass: value.node.effectClass,
      connectionId: admission.connectionId, connectionBinding: value.connectionBinding, capabilityId: admission.capabilityId, capabilityRevision: admission.revisionId,
      admissionVersion: admission.admissionVersion, contractHash: admission.contractHash, argumentHash: value.intent.argumentHash, arguments: structuredClone(value.args) },
  };
}
function records(state: Readonly<RepositoryState>, executionId: string) {
  const value = operationCaseEvidence(state, executionId), expected = sourceFor(value), raw = value.execution.operationSecret?.recoveries ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 1) deny("Recovery artifact journal is malformed");
  const artifacts = Object.entries(raw).map(([key, item]) => {
    const parsed = artifactSchema.safeParse(item); if (!parsed.success || key !== parsed.data.id) deny("Stored recovery artifact is malformed");
    const artifact = parsed.data, { artifactHash, ...unsigned } = artifact;
    if (!canonicalJSONBytes(artifact.source).equals(canonicalJSONBytes(expected.source)) || !canonicalJSONBytes(artifact.action).equals(canonicalJSONBytes(expected.action)) ||
        artifact.requestFingerprint !== digest({ source: artifact.source, actorId: artifact.createdBy.id, keyHash: artifact.keyHash }) || artifactHash !== digest(unsigned) ||
        Date.parse(artifact.createdAt) < Date.parse(expected.resolution.recordedAt)) deny("Stored recovery artifact no longer matches its immutable source evidence");
    return artifact;
  });
  return { value, expected, artifacts };
}
const publicArtifact = (artifact: OperationRecoveryArtifact) => ({ profile: artifact.profile, id: artifact.id, state: artifact.state, source: artifact.source, action: artifact.action,
  createdBy: { id: artifact.createdBy.id, role: artifact.createdBy.role }, createdAt: artifact.createdAt, requirements: artifact.requirements,
  dispatchAuthority: false as const, sourceRunUnchanged: true as const, artifactHash: artifact.artifactHash });

export function operationRecoveryArtifactView(state: Readonly<RepositoryState>, executionId: string, actorId: string) {
  const current = state.users[actorId], role = current && state.roles[current.roleId], permissions = current ? [...(role?.permissions ?? []), ...current.permissionOverrides] : [];
  const execution = state.executions[executionId];
  if (!current || current.status.toLowerCase() !== "active" || !execution || !(permissions.includes("execution:reconcile") ||
      permissions.some(permission => ["workflow:read", "execution:read_own", "workflow:run", "workflow:run_own"].includes(permission)) &&
      canReadExecution({ id: actorId, permissions }, execution))) deny("Recovery artifact not found", 404);
  const caseValue = operationCaseEvidence(state, executionId), resolution = caseValue.history.at(-1);
  if (!caseValue.resolved || resolution?.basis !== "queried-operation-state" || resolution.outcome !== "NOT_APPLIED") {
    const caseState = !caseValue.resolved ? "CASE_OPEN" : resolution?.outcome === "APPLIED" ? "EFFECT_OBSERVED" : "EVIDENCE_NOT_QUALIFIED";
    return { profile: "operation-recovery-artifact-history/v1" as const, sourceExecutionId: executionId, intentId: caseValue.intent.id, sourceVersion: caseValue.version,
      factsHash: caseValue.factsHash, state: caseState, canCreate: false, dispatchAuthority: false as const, artifacts: [],
      explanation: caseState === "CASE_OPEN" ? "Resolve the uncertain source operation before planning recovery." : caseState === "EFFECT_OBSERVED" ?
        "The reviewed ERP status shows the effect was applied, so a replacement action is blocked." :
        "Only a settled reviewed ERP status observation of NOT_APPLIED can support a linked recovery plan." };
  }
  const { value, expected, artifacts } = records(state, executionId);
  let canCreate = false;
  try { if (!current || role?.name === undefined || current.status.toLowerCase() !== "active") throw new Error(); assertCurrentRunController(state as RepositoryState, value.execution, actorId); canCreate = artifacts.length === 0; }
  catch { canCreate = false; }
  return { profile: "operation-recovery-artifact-history/v1" as const, sourceExecutionId: executionId, intentId: value.intent.id, sourceVersion: value.version,
    factsHash: value.factsHash, state: "CLOSED_NOT_APPLIED" as const, reconciliationId: expected.resolution.id, queryId: expected.resolution.queryId,
    canCreate, dispatchAuthority: false as const, artifacts: artifacts.map(publicArtifact),
    explanation: "This immutable plan records what may be recovered. It cannot dispatch, resume or replay the source run. Any later action needs a new execution and intent, current validation, a new idempotency boundary and fresh independent approval." };
}

export async function createOperationRecoveryArtifact(repository: Repository, executionId: string, user: CurrentUser, raw: unknown) {
  requireStorage(repository);
  const parsed = operationRecoveryCommandSchema.safeParse(raw); if (!parsed.success) deny("Recovery planning requires exact closed-case identities and a fresh idempotency key", 422);
  const command = parsed.data, keyHash = digest(["operation-recovery-artifact/v1", executionId, user.id, command.idempotencyKey]);
  const artifactId = `recovery-${randomBytes(16).toString("hex")}`;
  try { return await repository.mutateExecution(executionId, state => {
    const { value, expected, artifacts } = records(state, executionId), actor = state.users[user.id], role = actor && state.roles[actor.roleId];
    if (!actor || !role || actor.status.toLowerCase() !== "active" || role.name !== user.role || actor.id !== value.execution.startedBy.id) deny("Only the current source-run requester may prepare its recovery plan", 403);
    try { assertCurrentRunController(state, value.execution, user.id); } catch { deny("Current workflow run authority is required", 403); }
    const previous = artifacts.find(item => item.keyHash === keyHash);
    const requestFingerprint = digest({ source: expected.source, actorId: user.id, keyHash });
    if (previous) { if (previous.requestFingerprint !== requestFingerprint) deny("Recovery key belongs to a different source"); return { artifact: publicArtifact(previous), replayed: true }; }
    if (artifacts.length) deny("This operation already has an immutable recovery plan");
    if (command.intentId !== value.intent.id || command.sourceVersion !== value.version || command.factsHash !== value.factsHash || command.reconciliationId !== expected.resolution.id || command.queryId !== expected.resolution.queryId)
      deny("Recovery source changed; reload the exact closed case");
    const unsigned = { profile: "operation-recovery-artifact/v1" as const, id: artifactId, state: "REVIEW_REQUIRED" as const, source: expected.source, action: expected.action,
      createdBy: { id: actor.id, roleId: role.id, role: role.name }, createdAt: new Date().toISOString(),
      requirements: ["current-capability-validation", "fresh-independent-approval", "new-execution-and-intent", "new-idempotency-boundary"] as const,
      dispatchAuthority: false as const, sourceRunUnchanged: true as const, keyHash, requestFingerprint };
    const artifact = artifactSchema.parse({ ...unsigned, artifactHash: digest(unsigned) });
    (value.execution.operationSecret!.recoveries ??= {})[artifact.id] = artifact;
    appendExecutionEvent(state, value.execution, "operation.recovery_artifact_created", { artifactId: artifact.id, sourceReconciliationId: expected.resolution.id, dispatchAuthority: false }, value.intent.nodeId, value.intent.invocationId);
    state.auditLogs.push({ id: `operation-recovery-${randomBytes(12).toString("hex")}`, actor: { id: actor.id, name: actor.name }, action: "operation.recovery_artifact_created",
      resource: { type: "execution", id: executionId }, after: { artifactId: artifact.id, sourceIntentId: value.intent.id, dispatchAuthority: false }, createdAt: artifact.createdAt });
    return { artifact: publicArtifact(artifact), replayed: false };
  }); } catch (error) {
    try { repository.assertAuthority(); } catch { throw new HandlerFailure(503, "Recovery artifact acknowledgement is unconfirmed. Reload authoritative history; do not resubmit with a new key.", { code: "OPERATION_RECOVERY_ACK_UNCONFIRMED" }); }
    throw error;
  }
}
