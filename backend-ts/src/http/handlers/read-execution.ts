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

export async function runVerifiedRead(workflow: Workflow, input: Record<string, unknown>, token: ValidationToken, traceId: string,
  request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const blueprint = parseWorkflowYAMLStrict(workflow.yaml);
  const localIssues = inspectReadWorkflow(blueprint, services.registries.snapshot().tools, user.role);
  if (localIssues.length) return reply.status(422).send(fail("Workflow is outside the supported sequential-read execution profile", { code: "UNSUPPORTED_EXECUTION_PROFILE", issues: localIssues, traceId }));
  if (services.erpbridgeSession === undefined) return reply.status(503).send(fail("ERPBridge is not connected; no workflow tools were executed", { code: "ERPBRIDGE_NOT_CONNECTED", traceId }));
  let live;
  try { live = await discoverTools(services.erpbridgeSession, services.registries); }
  catch { return reply.status(503).send(fail("ERPBridge discovery failed; no workflow tools were executed", { code: "ERPBRIDGE_DISCOVERY_FAILED", traceId })); }
  const readinessIssues = inspectReadWorkflow(blueprint, live, user.role);
  if (readinessIssues.length) return reply.status(422).send(fail("Workflow live contracts are unavailable or changed", { code: "LIVE_CONTRACT_NOT_READY", issues: readinessIssues, traceId }));
  const queued = (request.body as { mode?: string } | undefined)?.mode === "async-read";
  const queue = queued ? readJobQueue(services) : null;
  const admission = queued ? queue!.prepare(workflow, input, user, String((request.body as { idempotencyKey?: string }).idempotencyKey)) : null;
  const startedAt = new Date().toISOString(), executionId = `run-${randomBytes(8).toString("hex")}`;
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
      ...(workflow.chatSessionId === undefined ? {} : { chatSessionId: workflow.chatSessionId }),
      workflowSnapshot: { version: workflow.publishedVersion, contentHash: workflowContentHash(workflow.yaml), registryHash: token.registry_hash,
        yaml: workflow.yaml, input: withoutSecretFields(input) as Record<string, unknown>, executionProfile: "sequential-read-v1" } };
    try { assertCurrentRunController(state, item, user.id, user.role); }
    catch { throw new HandlerFailure(403, "Current execution authority changed during preflight", { code: "EXECUTION_AUTHORITY_CHANGED" }); }
    const publication = (state.versions[workflow.id] ?? []).findLast((version) => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED");
    if (publication?.yaml !== workflow.yaml) throw new HandlerFailure(409, "Publication changed during execution preflight", { code: "PUBLISHED_SNAPSHOT_REQUIRED" });
    state.timelines[executionId] = []; state.executionLogs[executionId] = [];
    if (admission) queue!.store(state, item, admission);
    appendExecutionEvent(state, item, queued ? "run.queued" : "run.started", { profile: "sequential-read-v1", version: workflow.publishedVersion, persistence: item.readProgress.persistence });
    appendAudit(state, user, queued ? "execution.queued" : "execution.started", "execution", executionId, null, { workflowId: workflow.id, profile: "sequential-read-v1" }, request);
    return structuredClone(item);
  });
  if (queued) { queue!.kick(); return reply.status(202).send(ok(initial, "Published read run admitted; use its execution ID to follow saved progress", { traceId, executionProfile: "sequential-read-v1", admission: "read-job-v1" })); }
  let execution;
  try { execution = await completeCheckpointedRead(services, initial, input, token, request.signal); }
  catch { return reply.status(503).send(fail("Execution stopped because a checkpoint could not be confirmed. Inspect recovery state; do not automatically retry.", { executionId, code: "CHECKPOINT_NOT_COMMITTED", traceId })); }
  if (["FAILED", "RECOVERY_REQUIRED"].includes(execution.status)) return reply.status(422).send(fail("Read workflow stopped; inspect recorded node outcomes before starting another run", { executionId, status: execution.status, traceId }));
  return reply.send(ok(execution, execution.status === "CANCELLED" ? "Read workflow cancelled at a tool boundary" : "Published read workflow completed", { traceId, executionProfile: "sequential-read-v1" }));
}
