import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { canReadExecution } from "../http/execution-scope.js";
import { workflowContentHash } from "../parser/workflow.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { toolSchema } from "../registry/schemas.js";
import type { Execution, Repository, RepositoryState } from "../repository/store.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { resolveReadBinding } from "../workflows/compiled-read.js";
import type { StoredOperationCompilation } from "../workflows/operation-compilation-lifecycle.js";
import { validateHistoricalOperationReadback } from "./operation-readback-evidence.js";
import { readbackEvaluationSchema } from "./operation-readback-state.js";
import { appendExecutionEvent } from "./read-checkpoints.js";
import { runtimeApprovalEvidence } from "./runtime-approvals.js";

const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const id = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const evidenceSchema = z.object({ kind: z.enum(["erp-record", "delivery-audit", "external-support"]),
  reference: z.string().trim().min(1).max(500), note: z.string().trim().min(1).max(2000), observedAt: z.string().datetime() }).strict();
const commandBase = z.object({ intentId: id, baseVersion: z.number().int().positive(), factsHash: hash,
  decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) });
const operatorCommandSchema = commandBase.extend({ outcome: z.enum(["APPLIED", "NOT_APPLIED", "UNRESOLVED"]), evidence: evidenceSchema }).strict();
const queryCommandSchema = commandBase.extend({ queryId: id }).strict();
export const reconciliationCommandSchema = z.union([operatorCommandSchema, queryCommandSchema]);
const recordBase = z.object({ id, profile: z.literal("operation-reconciliation/v1"), intentId: id, baseVersion: z.number().int().positive(), factsHash: hash,
  outcome: z.enum(["APPLIED", "NOT_APPLIED", "UNRESOLVED"]), keyHash: hash, fingerprint: hash, actorId: id, roleId: id, recordedAt: z.string().datetime() });
const operatorRecordSchema = recordBase.extend({ basis: z.literal("operator-attestation"), evidence: evidenceSchema }).strict();
const queryRecordSchema = recordBase.extend({ basis: z.literal("queried-operation-state"), queryId: id, observation: readbackEvaluationSchema }).strict();
const recordSchema = z.union([operatorRecordSchema, queryRecordSchema]);
export type OperationReconciliationRecord = z.infer<typeof recordSchema>;
function deny(message: string, status = 409): never { throw new HandlerFailure(status, message, { code: "OPERATION_RECONCILIATION_DENIED" }); }
function currentActor(state: Readonly<RepositoryState>, actorId: string) {
  const actor = state.users[actorId], role = actor && state.roles[actor.roleId];
  if (!actor || actor.status.toLowerCase() !== "active" || !role) deny("Current reconciliation access is unavailable", 404);
  return { actor, role, permissions: [...role.permissions, ...actor.permissionOverrides] };
}
function canRecord(state: Readonly<RepositoryState>, execution: Execution, actorId: string) {
  const current = currentActor(state, actorId);
  return current.permissions.includes("execution:reconcile") && current.actor.id !== execution.startedBy.id;
}
function requireStorage(repository: Repository) {
  const storage = repository.persistence;
  if (storage && (storage.readQueueDurability !== "encrypted-single-writer" || storage.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !storage.saveExecutionCheckpoint))
    deny("Reconciliation requires qualified encrypted scoped checkpoints", 503);
  repository.assertAuthority();
}

/** Historical proof, not current dispatch authority. Expired approvals or a
 * disconnected/revoked connector do not erase an uncertain business outcome.
 * The original arguments, publication, approval and intent must still agree. */
export function operationCaseEvidence(state: Readonly<RepositoryState>, executionId: string) {
  const execution = state.executions[executionId], job = execution?.operationSecret, snapshot = execution?.workflowSnapshot;
  if (!execution || !job || job.profile !== "operation-job/v1" || snapshot?.executionProfile !== "sequential-operation-v1") deny("Operation reconciliation not found", 404);
  if (!["RECONCILIATION_REQUIRED", "RECONCILED"].includes(execution.status) || execution.completedAt === null || job.lease ||
      job.state !== (execution.status === "RECONCILED" ? "FINISHED" : "RECOVERY_REQUIRED")) deny("Only a fenced uncertain operation can be reconciled");
  const uncertain = Object.values(job.intents).filter(item => item.state === "UNKNOWN");
  if (uncertain.length !== 1 || !uncertain[0]!.approvalId) deny("This case requires the sequential effect journal; uncertain reads use read recovery");
  const intent = uncertain[0]!, attempt = execution.readProgress?.attempts[intent.nodeId], record = runtimeApprovalEvidence(execution, intent.approvalId!);
  const binding = record.binding, receipt = snapshot.operationCompilation;
  const publication = state.versions[execution.workflowId]?.findLast(item => item.version === snapshot.version && item.artifactState === "PUBLISHED");
  const compiled = publication?.compiledOperation as StoredOperationCompilation | undefined;
  const node = compiled?.plan?.ir?.root?.nodes?.[attempt?.stepIndex ?? -1], pin = node?.capability.admission;
  const revision = state.capabilityRevisions[binding.capabilityRevision], tool = toolSchema.safeParse(revision?.definition);
  if (!attempt || attempt.status !== "UNKNOWN" || attempt.id !== intent.invocationId || !attempt.dispatchIntentAt || !attempt.completedAt ||
      attempt.dispatchIntentAt !== intent.preparedAt || execution.readProgress!.nextStepIndex !== attempt.stepIndex || execution.readProgress!.epoch <= binding.workerEpoch ||
      record.state !== "CONSUMED" || record.consumption?.intentId !== intent.id || binding.nodeId !== intent.nodeId || binding.invocationId !== intent.invocationId ||
      binding.operationKey !== intent.operationKey || binding.argumentHash !== intent.argumentHash || binding.executionId !== executionId || binding.workflowId !== execution.workflowId ||
      binding.requesterId !== execution.startedBy.id || job.actorId !== binding.requesterId || job.roleId !== binding.requesterRoleId ||
      !receipt || snapshot.contentHash !== workflowContentHash(snapshot.yaml) || receipt.sourceHash !== snapshot.contentHash || receipt.sourceHash !== binding.sourceHash || receipt.semanticHash !== binding.semanticHash ||
      publication?.yaml !== snapshot.yaml || !compiled || compiled.plan.sourceHash !== binding.sourceHash || compiled.plan.semanticHash !== binding.semanticHash ||
      digest(compiled.plan.ir) !== binding.semanticHash || !canonicalJSONBytes(compiled.receipt).equals(canonicalJSONBytes(receipt)) ||
      !node || node.id !== intent.nodeId || node.effectClass === "read" || !pin || pin.capabilityId !== binding.capabilityId || pin.connectionId !== binding.connectionId ||
      pin.revisionId !== binding.capabilityRevision || pin.contractHash !== binding.contractHash || pin.admissionVersion !== binding.admissionVersion ||
      revision?.connectionBinding !== binding.connectionBinding || revision.capabilityId !== binding.capabilityId || revision.connectionId !== binding.connectionId || revision.contractHash !== binding.contractHash ||
      !tool.success || capabilityContractHash(tool.data) !== binding.contractHash || tool.data.is_read_only || !tool.data.operation_contract ||
      node.capability.toolId !== tool.data.tool_id || node.capability.contractHash !== binding.contractHash || node.effectClass !== tool.data.operation_contract.effect_class ||
      compiled.verifiedRole !== job.admittedRole || job.intents[intent.nodeId] !== intent)
    deny("Historical operation, approval, publication or capability evidence changed");
  const rawArgs = resolveReadBinding(node.inputs, { input: snapshot.input, ...execution.stepOutputs });
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) deny("Exact historical arguments must be an object");
  const args = rawArgs as Record<string, unknown>;
  if (digest(args) !== intent.argumentHash || !canonicalJSONBytes(args).equals(canonicalJSONBytes(record.arguments)) ||
      !canonicalJSONBytes(args).equals(canonicalJSONBytes(withoutSecretFields(args)))) deny("Exact historical arguments are unavailable or changed");
  const { reconciliationId: _resolution, ...originalIntent } = intent;
  const facts = { executionId, workflowId: execution.workflowId, snapshotHash: snapshot.contentHash, compilation: receipt, attempt,
    workerEpoch: execution.readProgress!.epoch, completedAt: execution.completedAt, intent: originalIntent, approval: record, arguments: args };
  const raw = job.reconciliations ?? {};
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 1000) deny("Reconciliation journal is malformed");
  const history = Object.entries(raw).map(([key, value]) => {
    const parsed = recordSchema.safeParse(value); if (!parsed.success || key !== parsed.data.id || !Object.values(job.intents).some(item => item.id === parsed.data.intentId)) deny("Stored reconciliation record is malformed");
    return parsed.data;
  }).filter(item => item.intentId === intent.id).sort((a, b) => a.baseVersion - b.baseVersion);
  const historyHash = (prior: OperationReconciliationRecord[]) => digest({ facts, history: prior.map(item => ({ id: item.id, fingerprint: item.fingerprint })) });
  for (const [index, item] of history.entries()) {
    const { id: _id, profile: _profile, basis: _basis, fingerprint, actorId, roleId: _role, recordedAt: _at, ...command } = item;
    let evidenceTime = item.basis === "operator-attestation" ? item.evidence.observedAt : item.observation.observedAt;
    if (item.basis === "queried-operation-state") {
      const rawQuery = job.readbacks?.[item.queryId];
      let checked;
      try { checked = validateHistoricalOperationReadback(state, rawQuery, { execution, intent, node, connectionBinding: binding.connectionBinding, tool: tool.data, args,
        history: history.slice(0, index), resolved: false, version: index + 1, factsHash: item.factsHash,
        factsHashes: [...history.slice(0, index).map(record => record.factsHash), item.factsHash] }); }
      catch { deny("Query-backed reconciliation evidence changed"); }
      if (checked.job.state !== "ANSWERED" || !checked.job.completedAt || !checked.job.evaluation?.settled || checked.job.evaluation.outcome === "UNRESOLVED" ||
          checked.job.intentId !== item.intentId || checked.job.evaluation.outcome !== item.outcome ||
          !canonicalJSONBytes(checked.job.evaluation).equals(canonicalJSONBytes(item.observation)) || Date.parse(checked.job.completedAt) > Date.parse(item.recordedAt))
        deny("Query-backed reconciliation evidence is inconsistent");
    }
    if (item.baseVersion !== index + 1 || item.factsHash !== historyHash(history.slice(0, index)) || fingerprint !== digest({ ...command, actorId }) ||
        item.actorId === execution.startedBy.id || index < history.length - 1 && item.outcome !== "UNRESOLVED" ||
        Date.parse(evidenceTime) < Date.parse(intent.preparedAt) || Date.parse(evidenceTime) > Date.parse(item.recordedAt) + 30000)
      deny("Reconciliation evidence chain is inconsistent");
  }
  const resolved = history.at(-1)?.outcome !== undefined && history.at(-1)!.outcome !== "UNRESOLVED";
  if (resolved !== (execution.status === "RECONCILED") || (resolved ? intent.reconciliationId !== history.at(-1)!.id : intent.reconciliationId !== undefined)) deny("Reconciliation state disagrees with its evidence");
  const currentFactsHash = historyHash(history);
  return { execution, intent, node, connectionBinding: binding.connectionBinding, tool: tool.data, args, history, resolved, version: history.length + 1, factsHash: currentFactsHash,
    factsHashes: [...history.map(item => item.factsHash), currentFactsHash] };
}
const publicRecord = (record: OperationReconciliationRecord) => record.basis === "operator-attestation" ?
  ({ id: record.id, outcome: record.outcome, evidence: record.evidence, actorId: record.actorId, recordedAt: record.recordedAt, basis: record.basis }) :
  ({ id: record.id, outcome: record.outcome, queryId: record.queryId, observation: record.observation, actorId: record.actorId, recordedAt: record.recordedAt, basis: record.basis });
export const hasOperationReconciliation = (execution: Execution) => execution.workflowSnapshot?.executionProfile === "sequential-operation-v1" &&
  Object.values(execution.operationSecret?.intents ?? {}).some(intent => intent.state === "UNKNOWN" && !!intent.approvalId);
export function operationReconciliationView(state: Readonly<RepositoryState>, executionId: string, actorId: string) {
  // Scope access before reading exact arguments, including self-review denial.
  const execution = state.executions[executionId], current = currentActor(state, actorId);
  if (!execution || !(current.permissions.includes("execution:reconcile") || current.permissions.some(key => ["workflow:read", "execution:read_own"].includes(key)) && canReadExecution({ id: actorId, permissions: current.permissions }, execution)))
    deny("Operation reconciliation not found", 404);
  const value = operationCaseEvidence(state, executionId);
  return { id: executionId, workflowId: execution.workflowId, workflowName: execution.workflowName, status: execution.status, operationReconciliation: {
    profile: "operation-reconciliation/v1", intentId: value.intent.id, nodeId: value.intent.nodeId, invocationId: value.intent.invocationId, operationKey: value.intent.operationKey,
    preparedAt: value.intent.preparedAt, requesterId: execution.startedBy.id, toolName: value.tool.name, remoteToolName: exactBridgeName(value.tool),
    arguments: structuredClone(value.args), version: value.version, factsHash: value.factsHash, state: value.resolved ? "RESOLVED" : "OPEN",
    history: value.history.map(publicRecord), canRecord: !value.resolved && value.history.length < 100 && canRecord(state, execution, actorId),
    basis: "operator-attestation", canResume: false, noReplay: true,
    explanation: "Record independently checked external evidence. This does not create a tool-confirmed answer, execute, resend, resume later nodes or verify recipient delivery." } };
}
function receipt(execution: Execution, record: OperationReconciliationRecord, version: number, replayed: boolean) {
  return { executionId: execution.id, intentId: record.intentId, recordId: record.id, version, outcome: record.outcome, state: record.outcome === "UNRESOLVED" ? "OPEN" : "RESOLVED",
    basis: record.basis, replayed, canResume: false, noReplay: true, toolWasCalled: false };
}
export async function recordOperationReconciliation(repository: Repository, executionId: string, user: CurrentUser, raw: unknown) {
  requireStorage(repository);
  const parsed = reconciliationCommandSchema.safeParse(raw); if (!parsed.success) deny("Reconciliation requires one exact case revision and either external evidence or one saved status query", 422);
  const command = parsed.data, keyHash = digest([executionId, user.id, command.intentId, command.decisionKey]);
  const recordId = `reconciliation-${randomBytes(16).toString("hex")}`;
  try { return await repository.mutateExecution(executionId, state => {
    const execution = state.executions[executionId], current = currentActor(state, user.id);
    if (!execution || !canRecord(state, execution, user.id) || current.role.name !== user.role || !user.permissions.includes("execution:reconcile")) deny("Current independent execution:reconcile authority is required", 403);
    const value = operationCaseEvidence(state, executionId);
    let basis: OperationReconciliationRecord["basis"], outcome: OperationReconciliationRecord["outcome"], details: Record<string, unknown>;
    if ("queryId" in command) {
      const rawQuery = execution.operationSecret?.readbacks?.[command.queryId];
      let checked;
      try { checked = validateHistoricalOperationReadback(state, rawQuery, value); }
      catch { deny("The saved status query no longer matches this exact operation case"); }
      if (checked.job.state !== "ANSWERED" || !checked.job.completedAt || !checked.job.evaluation?.settled || checked.job.evaluation.outcome === "UNRESOLVED")
        deny("Only a saved, settled APPLIED or NOT_APPLIED status observation can resolve this case");
      basis = "queried-operation-state"; outcome = checked.job.evaluation.outcome;
      details = { queryId: checked.job.id, observation: checked.job.evaluation };
    } else {
      basis = "operator-attestation"; outcome = command.outcome; details = { evidence: command.evidence };
    }
    const businessCommand = { intentId: command.intentId, baseVersion: command.baseVersion, factsHash: command.factsHash, outcome, ...details, keyHash };
    const fingerprint = digest({ ...businessCommand, actorId: user.id }), previous = value.history.find(item => item.keyHash === keyHash);
    if (previous) { if (previous.fingerprint !== fingerprint) deny("Reconciliation key already belongs to different evidence"); return receipt(execution, previous, previous.baseVersion + 1, true); }
    if (command.intentId !== value.intent.id || command.baseVersion !== value.version || command.factsHash !== value.factsHash || value.resolved || value.history.length >= 100)
      deny("Reconciliation case changed or is closed; reload exact evidence before recording");
    const now = new Date().toISOString();
    const observedAt = "evidence" in command ? command.evidence.observedAt : (details.observation as z.infer<typeof readbackEvaluationSchema>).observedAt;
    if (Date.parse(observedAt) < Date.parse(value.intent.preparedAt) || Date.parse(observedAt) > Date.parse(now) + 30000)
      deny("Evidence must have been observed after this intent and not in the future", 422);
    const record = recordSchema.parse({ ...businessCommand, id: recordId, profile: "operation-reconciliation/v1", basis, fingerprint,
      actorId: user.id, roleId: current.role.id, recordedAt: now });
    (execution.operationSecret!.reconciliations ??= {})[record.id] = record;
    if (record.outcome !== "UNRESOLVED") {
      value.intent.reconciliationId = record.id;
      execution.status = "RECONCILED"; execution.operationSecret!.state = "FINISHED";
      execution.agentSummary = record.basis === "queried-operation-state" ?
        "An independent reviewer accepted a saved, qualified ERP status observation. This run is closed, not successfully completed or resumed. The original SDK outcome remains unacknowledged; no action was replayed." :
        "An independent operator recorded external outcome evidence. This run is closed, not successfully completed or resumed. The original SDK outcome remains unacknowledged; no action was replayed.";
      const entry = state.timelines[executionId]?.find(item => item.attemptId === value.intent.invocationId);
      if (entry) entry.reconciliation = publicRecord(record);
    }
    appendExecutionEvent(state, execution, "operation.reconciliation_recorded", { recordId, outcome: record.outcome, basis: record.basis, noReplay: true }, value.intent.nodeId, value.intent.invocationId);
    state.auditLogs.push({ id: `reconciliation-audit-${randomBytes(12).toString("hex")}`, actor: { id: current.actor.id, name: current.actor.name }, action: "operation.reconciliation_recorded",
      resource: { type: "execution", id: executionId }, after: { recordId, intentId: value.intent.id, factsHash: command.factsHash, outcome: record.outcome, basis: record.basis,
        ...(record.basis === "queried-operation-state" ? { queryId: record.queryId } : {}) }, createdAt: now });
    // Check the resulting history/state before its durable acknowledgement.
    operationCaseEvidence(state, executionId);
    return receipt(execution, record, value.version + 1, false);
  }); } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    throw new HandlerFailure(503, "Reconciliation acknowledgement is unconfirmed. Reload authoritative state before another decision; nothing was replayed.", { code: "OPERATION_RECONCILIATION_UNCONFIRMED" });
  }
}
