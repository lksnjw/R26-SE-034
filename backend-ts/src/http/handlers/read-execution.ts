import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ok, fail, type Workflow } from "../../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import { inspectReadWorkflow, executeReadWorkflow } from "../../runner/read-workflow.js";
import { partialResult, type RunnerResult } from "../../runner/executor.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import type { ValidationToken } from "../../validator/registry-validator.js";
import { appendAudit, HandlerFailure, type CurrentUser, type HandlerServices } from "./common.js";

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
  const startedAt = new Date().toISOString(), executionId = `run-${randomBytes(8).toString("hex")}`;
  await services.repository.mutate((state) => {
    const current = state.workflows[workflow.id];
    if (!current || current.archived || current.yaml !== workflow.yaml || current.publishedVersion !== workflow.publishedVersion)
      throw new HandlerFailure(409, "Workflow changed during execution preflight", { code: "WORKFLOW_CHANGED" });
    state.executions[executionId] = { id: executionId, workflowId: workflow.id, workflowName: workflow.name, status: "RUNNING", startedAt, completedAt: null,
      durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: user.id, name: user.name }, traceId,
      ...(workflow.chatSessionId === undefined ? {} : { chatSessionId: workflow.chatSessionId }),
      workflowSnapshot: { version: workflow.publishedVersion, contentHash: workflowContentHash(workflow.yaml), registryHash: token.registry_hash,
        yaml: workflow.yaml, input: withoutSecretFields(input) as Record<string, unknown>, executionProfile: "sequential-read-v1" } };
    appendAudit(state, user, "execution.started", "execution", executionId, null, { workflowId: workflow.id, profile: "sequential-read-v1" }, request);
  });
  let result: RunnerResult, failed = false;
  try { result = await executeReadWorkflow(services, user.id, workflow.yaml, input, token, { traceId, sessionId: workflow.chatSessionId, workflowId: workflow.id, executionId, signal: request.signal }); }
  catch (error) {
    failed = true;
    result = partialResult(error) ?? { state: {}, timeline: [], logs: [], tokens: { input: 0, output: 0, total: 0 } };
  }
  const execution = await services.repository.mutate((state) => {
    const item = state.executions[executionId]!;
    item.status = failed ? "FAILED" : "DONE";
    item.completedAt = new Date().toISOString();
    item.durationMs = Math.max(0, Date.parse(item.completedAt) - Date.parse(item.startedAt));
    item.stepOutputs = Object.fromEntries(Object.entries(result.state).filter(([key]) => key !== "input"));
    item.finalOutput = result.timeline.findLast((entry) => entry.status === "DONE")?.output;
    item.agentSummary = failed ? "Read workflow did not complete. No automatic replay was performed." : "Published read workflow completed with deterministic execution.";
    if (failed) item.failure = { failureCategory: "READ_EXECUTION_FAILED", failedStepId: result.timeline.at(-1)?.nodeId ?? "preflight" };
    state.timelines[executionId] = result.timeline.map((entry) => ({ ...entry, traceId }));
    state.executionLogs[executionId] = result.logs.map((entry, index) => ({ ...entry, id: `log_${index + 1}`, executionId, traceId }));
    appendAudit(state, user, "execution.completed", "execution", executionId, null, { workflowId: workflow.id, status: item.status }, request);
    return structuredClone(item);
  });
  if (failed) return reply.status(422).send(fail("Read workflow failed or was blocked", { executionId, status: execution.status, traceId }));
  return reply.send(ok(execution, "Published read workflow completed", { traceId, executionProfile: "sequential-read-v1" }));
}
