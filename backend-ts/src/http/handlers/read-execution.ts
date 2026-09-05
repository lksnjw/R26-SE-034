import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ok, fail, type Workflow } from "../../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import { inspectReadWorkflow } from "../../runner/read-workflow.js";
import { appendExecutionEvent, newReadProgress, assertCurrentRunController } from "../../runner/read-checkpoints.js";
import { completeCheckpointedRead } from "../../runner/checkpointed-read.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import type { ValidationToken } from "../../validator/registry-validator.js";
import { appendAudit, HandlerFailure, type CurrentUser, type HandlerServices } from "./common.js";
import { readJobQueue } from "../../runner/read-jobs.js";
import { prepareCompiledExecution } from "../../workflows/read-compilation-lifecycle.js";
import { validateToolInput } from "../../tools/tool-input-schema.js";
import { supportsCollectionReads, readIterationBindingKey } from "../../runner/read-collection-admission.js";
import { newReadIterationLedger } from "../../runner/read-iteration-checkpoints.js";
import { completeCheckpointedCollectionRead } from "../../runner/checkpointed-collection-read.js";

export async function runVerifiedRead(workflow: Workflow, input: Record<string, unknown>, token: ValidationToken, traceId: string,
  request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const blueprint = parseWorkflowYAMLStrict(workflow.yaml);
  const allowCollections = supportsCollectionReads(services);
  const localIssues = inspectReadWorkflow(blueprint, services.registries.snapshot().tools, user.role, allowCollections);
  if (localIssues.length) return reply.status(422).send(fail("Workflow is outside the supported read execution profiles", { code: "UNSUPPORTED_EXECUTION_PROFILE", issues: localIssues, traceId }));
  if (services.erpbridgeSession === undefined) return reply.status(503).send(fail("ERPBridge is not connected; no workflow tools were executed", { code: "ERPBRIDGE_NOT_CONNECTED", traceId }));
  let live;
  try { live = await discoverTools(services.erpbridgeSession, services.registries); }
  catch { return reply.status(503).send(fail("ERPBridge discovery failed; no workflow tools were executed", { code: "ERPBRIDGE_DISCOVERY_FAILED", traceId })); }
  const readinessIssues = inspectReadWorkflow(blueprint, live, user.role, allowCollections);
  if (readinessIssues.length) return reply.status(422).send(fail("Workflow live contracts are unavailable or changed", { code: "LIVE_CONTRACT_NOT_READY", issues: readinessIssues, traceId }));
  const compilation = await services.repository.readAuthoritative(state => {
    const publication = (state.versions[workflow.id] ?? []).findLast(version => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED");
    if (publication?.yaml !== workflow.yaml) throw new HandlerFailure(409, "Publication changed during compilation preflight", { code: "PUBLISHED_SNAPSHOT_REQUIRED" });
    return prepareCompiledExecution(state, services, publication, workflow.yaml, user.role);
  });
  const collection = compilation.plan.ir.schemaVersion === "workflow-read-ir/v4";
  const profile = collection ? "collection-read-v1" as const : compilation.plan.ir.schemaVersion === "workflow-read-ir/v3" ? "structured-read-v1" as const : compilation.plan.ir.flow ? "conditional-read-v1" as const : "sequential-read-v1" as const;
  if (compilation.plan.ir.inputSchema && validateToolInput(compilation.plan.ir.inputSchema, input).length)
    return reply.status(422).send(fail("Workflow input does not meet its declared schema; no run was admitted", { code: "WORKFLOW_INPUT_INVALID", traceId }));
  const queued = (request.body as { mode?: string } | undefined)?.mode === "async-read";
  const queue = queued ? readJobQueue(services) : null;
  const admission = queued ? queue!.prepare(workflow, input, user, String((request.body as { idempotencyKey?: string }).idempotencyKey)) : null;
  const startedAt = new Date().toISOString(), executionId = `run-${randomBytes(8).toString("hex")}`;
  const bindingKey = collection ? readIterationBindingKey(services) : undefined;
  let iterationProgress: ReturnType<typeof newReadIterationLedger> | undefined;
  if (bindingKey) {
    try { iterationProgress = newReadIterationLedger(executionId, compilation.plan, input, user.role, bindingKey); }
    catch { throw new HandlerFailure(422, "Collection input exceeds supported bounds or its declared contract; no run was admitted", { code: "COLLECTION_INPUT_INVALID" }); }
  }
  const initial = await services.repository.mutate((state) => {
    if (admission) {
      const existing = queue!.existing(state, admission, user);
      if (existing) return existing;
      queue!.assertCapacity(state);
    }
    const current = state.workflows[workflow.id];
    if (!current || current.archived || current.yaml !== workflow.yaml || current.publishedVersion !== workflow.publishedVersion)
      throw new HandlerFailure(409, "Workflow changed during execution preflight", { code: "WORKFLOW_CHANGED" });
    const item = state.executions[executionId] = { id: executionId, workflowId: workflow.id, workflowName: workflow.name, status: queued ? "PENDING" : "RUNNING", startedAt, completedAt: null,
      durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: user.id, name: user.name }, traceId,
      readProgress: newReadProgress(services.repository), stepOutputs: {},
      ...(iterationProgress ? { iterationProgress } : {}),
      ...(workflow.chatSessionId === undefined ? {} : { chatSessionId: workflow.chatSessionId }),
      workflowSnapshot: { version: workflow.publishedVersion, contentHash: workflowContentHash(workflow.yaml), registryHash: token.registry_hash,
        yaml: workflow.yaml, input: withoutSecretFields(input) as Record<string, unknown>, executionProfile: profile, compilation: compilation.receipt } };
    try { assertCurrentRunController(state, item, user.id, user.role); }
    catch { throw new HandlerFailure(403, "Current execution authority changed during preflight", { code: "EXECUTION_AUTHORITY_CHANGED" }); }
    const publication = (state.versions[workflow.id] ?? []).findLast((version) => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED");
    if (publication?.yaml !== workflow.yaml) throw new HandlerFailure(409, "Publication changed during execution preflight", { code: "PUBLISHED_SNAPSHOT_REQUIRED" });
    prepareCompiledExecution(state, services, publication, workflow.yaml, user.role, compilation.receipt);
    state.timelines[executionId] = []; state.executionLogs[executionId] = [];
    if (admission) queue!.store(state, item, admission);
    appendExecutionEvent(state, item, queued ? "run.queued" : "run.started", { profile, version: workflow.publishedVersion, persistence: item.readProgress.persistence });
    appendAudit(state, user, queued ? "execution.queued" : "execution.started", "execution", executionId, null, { workflowId: workflow.id, profile }, request);
    return structuredClone(item);
  });
  if (queued) { queue!.kick(); return reply.status(202).send(ok(initial, "Published read run admitted; use its execution ID to follow saved progress", { traceId, executionProfile: profile, admission: "read-job-v1" })); }
  let execution;
  try { execution = collection
    ? await completeCheckpointedCollectionRead(services, initial, input, token, compilation.plan, bindingKey!, request.signal)
    : await completeCheckpointedRead(services, initial, input, token, request.signal, undefined, compilation.plan); }
  catch { return reply.status(503).send(fail("Execution stopped because a checkpoint could not be confirmed. Inspect recovery state; do not automatically retry.", { executionId, code: "CHECKPOINT_NOT_COMMITTED", traceId })); }
  if (["FAILED", "RECOVERY_REQUIRED"].includes(execution.status)) return reply.status(422).send(fail("Read workflow stopped; inspect recorded node outcomes before starting another run", { executionId, status: execution.status, traceId }));
  return reply.send(ok(execution, execution.status === "CANCELLED" ? "Read workflow cancelled at a tool boundary" : "Published read workflow completed", { traceId, executionProfile: profile }));
}
