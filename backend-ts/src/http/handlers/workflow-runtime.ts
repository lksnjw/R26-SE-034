import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { fail, ok, runWorkflowRequestSchema, type Workflow } from "../../models/schemas.js";
import { parseWorkflowYAMLStrict } from "../../parser/workflow.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import type { Execution, User } from "../../repository/store.js";
import { operationJobQueue } from "../../runner/operation-jobs.js";
import { readJobQueue } from "../../runner/read-jobs.js";
import { inspectReadWorkflow } from "../../runner/read-workflow.js";
import { isTraceId, requestTraceId } from "../../trace/request-trace.js";
import { canViewWorkflow } from "../../workflows/commands.js";
import type { ApplicationServices } from "../application-services.js";
import { INVALID_JSON_BODY } from "../request-body.js";
import { stringValue, validateWorkflow as validateWithGovernance } from "./common.js";
import { runVerifiedRead } from "./read-execution.js";
import { boundedReadFixtureRequest, handleReadFixtureSimulation } from "./read-simulation.js";

export async function listWorkflows(
  _request: FastifyRequest,
  reply: FastifyReply,
  user: User & { permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  const state = await services.repository.snapshot();
  const all = Object.values(state.workflows).filter((item) => !item.archived);
  const visible = all.filter((item) => canViewWorkflow(item, user));
  return reply.send(ok(visible.map(publicWorkflow), "OK", {
    page: 1,
    limit: 20,
    total: visible.length,
    totalPages: visible.length === 0 ? 0 : 1,
    sort: "updatedAt",
    relevance: "relevant",
  }));
}

export async function createWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string },
  services: ApplicationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const parsed = z.object({
    name: z.string().default(""),
    description: z.string().default(""),
    yaml: z.string().optional(),
    candidate: z.object({
      yaml: z.string(),
      candidate_id: z.string().optional(),
      id: z.string().optional(),
      chatSessionId: z.string().optional(),
      chatMessageId: z.string().optional(),
      traceId: z.string().optional(),
    }).passthrough().optional(),
    tags: z.array(z.string()).optional(),
    chatSessionId: z.string().optional(),
    chatMessageId: z.string().optional(),
    traceId: z.string().optional(),
  }).strict().safeParse(request.body);
  if (!parsed.success)
    return reply.status(400).send(fail("Workflow YAML is required", null));
  const rawYAML = parsed.data.candidate?.yaml ?? parsed.data.yaml ?? "";
  if (rawYAML.trim() === "")
    return reply.status(400).send(fail("Workflow YAML is required", null));
  const chatSessionId = (parsed.data.chatSessionId ?? parsed.data.candidate?.chatSessionId ?? "").trim();
  const chatMessageId = (parsed.data.chatMessageId ?? parsed.data.candidate?.chatMessageId ?? "").trim();
  const linkedTraceId = (parsed.data.traceId ?? parsed.data.candidate?.traceId ?? "").trim();
  if (linkedTraceId !== "" && !isTraceId(linkedTraceId))
    return reply.status(400).send(fail("Invalid trace ID", null));
  const traceId = requestTraceId(request, linkedTraceId === "" ? undefined : linkedTraceId);
  if ((chatSessionId === "") !== (chatMessageId === ""))
    return reply.status(400).send(fail("Chat session and message IDs must be provided together", null));
  if (chatSessionId !== "") {
    const originExists = await services.repository.read((state) => {
      const chat = state.chats[chatSessionId];
      if (chat === undefined || (chat.ownerId !== user.id && !(user as User & { permissions?: string[] }).permissions?.includes("workflow:read")))
        return false;
      return chat.messages.some((message) => message.id === chatMessageId && stringValue(message.role) === "user");
    });
    if (!originExists)
      return reply.status(400).send(fail("Chat candidate origin not found", null));
  }
  let blueprint;
  try { blueprint = parseWorkflowYAMLStrict(rawYAML); }
  catch (error) {
    return reply.status(422).send(fail("Workflow validation failed", { error: errorText(error) }));
  }
  const gate = await validateWithGovernance(services, "CreateWorkflow", rawYAML, user, {
    traceId,
    ...(chatSessionId === "" ? {} : { sessionId: chatSessionId }),
    ...(chatMessageId === "" ? {} : { messageId: chatMessageId }),
    candidateId: parsed.data.candidate?.candidate_id ?? parsed.data.candidate?.id,
  });
  if (!gate.result.passed)
    return reply.status(422).send(fail("Workflow validation failed", { ...gate.result, traceId }));
  const workflow = await services.repository.mutate((state) => {
    state.counter += 1;
    const id = `wf_${state.counter}_${randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    const requestedName = parsed.data.name.trim();
    const requestedDescription = parsed.data.description.trim();
    const item: Workflow = {
      id,
      name: requestedName === "" ? blueprint.name : requestedName,
      description: requestedDescription === "" ? (blueprint.description ?? "") : requestedDescription,
      owner: { id: user.id, name: user.name },
      assignedUserIds: [],
      status: "PENDING",
      trigger: blueprint.trigger as unknown as Record<string, unknown>,
      steps: blueprint.steps.length,
      successRate: 0,
      lastRunAt: null,
      publishedVersion: 0,
      draftVersion: 1,
      tags: parsed.data.tags ?? [],
      domainTags: [],
      canRun: false,
      createdAt: now,
      updatedAt: now,
      yaml: rawYAML,
      archived: false,
      ...(chatSessionId === "" ? {} : { chatSessionId, chatMessageId }),
      ...(linkedTraceId === "" ? {} : { traceId }),
    };
    state.workflows[id] = item;
    if (parsed.data.candidate !== undefined) {
      state.counter += 1;
      state.versions[id] = [{
        id: `ver_${state.counter}_${randomBytes(4).toString("hex")}`,
        workflowId: id,
        version: 1,
        artifactState: "DRAFT",
        versionNote: "Validated generated candidate",
        yaml: rawYAML,
        sourceCandidateId: parsed.data.candidate.candidate_id ?? parsed.data.candidate.id ?? "",
        createdAt: now,
        createdBy: { id: user.id, name: user.name },
      }];
    }
    return item;
  });
  return reply.status(201).send(ok(publicWorkflow(workflow), "Workflow created", null));
}

export async function getWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  const item = await services.repository.read((state) => state.workflows[param(request, "id")] ?? null);
  if (item === null || !canViewWorkflow(item, user))
    return reply.status(404).send(fail("Workflow not found", null));
  return reply.send(ok(publicWorkflow(item), "OK", null));
}

export async function validateWorkflowRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string },
  services: ApplicationServices,
): Promise<unknown> {
  const item = await services.repository.read((state) => state.workflows[param(request, "id")] ?? null);
  if (item === null)
    return reply.status(404).send(fail("Workflow not found", null));
  const raw = isRecord(request.body) && typeof request.body.yaml === "string" ? request.body.yaml : item.yaml;
  const traceId = requestTraceId(request, item.traceId);
  const gate = await validateWithGovernance(services, "ValidateWorkflow", raw, user, { traceId, workflowId: item.id });
  return reply.send(ok(gate.result, gate.result.passed ? "Workflow is valid" : "Workflow is invalid", { traceId }));
}

export async function runWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string; permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  if (!boundedReadFixtureRequest(request.body))
    return reply.status(400).send(fail("Invalid or oversized read simulation fixtures", { code: "SIMULATION_FIXTURES_INVALID" }));
  if (!runWorkflowRequestSchema.safeParse(request.body ?? {}).success)
    return reply.status(400).send(fail("Invalid request body", null));
  const workflow = await services.repository.read((state) => state.workflows[param(request, "id")] ?? null);
  if (workflow === null)
    return reply.status(404).send(fail("Workflow not found", null));
  return runWorkflowFor(workflow, request, reply, user, services);
}

export async function runWorkflowFor(
  workflow: Workflow,
  request: FastifyRequest,
  reply: FastifyReply,
  user: User & { role: string; permissions: string[] },
  services: ApplicationServices,
): Promise<unknown> {
  workflow = structuredClone(workflow);
  if (!boundedReadFixtureRequest(request.body))
    return reply.status(400).send(fail("Invalid or oversized read simulation fixtures", { code: "SIMULATION_FIXTURES_INVALID" }));
  const parsed = runWorkflowRequestSchema.safeParse(request.body ?? {});
  if (!parsed.success)
    return reply.status(400).send(fail("Invalid request body", null));
  const traceId = requestTraceId(request, workflow.traceId);
  if (!user.permissions.some((permission) => ["workflow:run", "workflow:run_own"].includes(permission)))
    return reply.status(403).send(fail("Permission denied", { requiredAny: ["workflow:run", "workflow:run_own"] }));
  if (!user.permissions.includes("workflow:run") && workflow.owner.id !== user.id && !(workflow.assignedUserIds ?? []).includes(user.id))
    return reply.status(403).send(fail("Workflow is not assigned to the current user", null));
  if (workflow.yaml.length > 200_000)
    return reply.status(422).send(fail("Workflow source exceeds supported limits", { traceId }));
  if (parsed.data.simulation !== undefined && !parsed.data.dryRun)
    return reply.status(400).send(fail("Fixture simulation requires dryRun; test data cannot be used for real execution", { code: "SIMULATION_MODE_REQUIRED", traceId }));
  const operationPublication = await services.repository.read((state) => (state.versions[workflow.id] ?? []).findLast((version) => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED"));
  if (operationPublication?.compiledOperation || parsed.data.mode === "async-operation") {
    if (!["", "execute", "async-read", "async-operation"].includes(parsed.data.mode))
      return reply.status(422).send(fail("Unsupported operation execution mode", { code: "UNSUPPORTED_EXECUTION_MODE", traceId }));
    if (parsed.data.dryRun)
      return reply.send(ok({ dry_run: true, simulation: "static-operation-plan", can_execute: false, live_readiness: "not_checked", requires_independent_approval: true,
        planned_steps: withoutSecretFields(parseWorkflowYAMLStrict(workflow.yaml).steps) }, "Static operation plan only; no ERP calls or effects occurred", { traceId }));
    const admission = await operationJobQueue(services).admit(workflow, parsed.data.input ?? {}, user, parsed.data.idempotencyKey, traceId);
    return reply.status(202).send(ok(admission.execution, admission.replayed ? "Existing operation run; no additional run admitted" : "Operation queued; verification and independent approvals are required before writes", { traceId, admission: "operation-job/v1", replayed: admission.replayed }));
  }
  const asyncRead = parsed.data.mode === "async-read";
  if (asyncRead) {
    if (parsed.data.dryRun)
      return reply.status(422).send(fail("Async admission is not a dry-run mode", { code: "UNSUPPORTED_EXECUTION_MODE", traceId }));
    const queue = readJobQueue(services);
    const admission = queue.prepare(workflow, parsed.data.input ?? {}, user, parsed.data.idempotencyKey);
    const existing = await services.repository.read((state) => queue.existing(state, admission, user));
    if (existing)
      return reply.status(202).send(ok(existing, "Existing read run for this idempotency key; no additional run was admitted", { traceId, admission: "read-job-v1", replayed: true }));
  }
  if (!["", "execute", "deterministic-read", "async-read"].includes(parsed.data.mode) || (!asyncRead && parsed.data.idempotencyKey !== ""))
    return reply.status(422).send(fail("Requested execution mode or idempotency contract is not implemented", { code: "UNSUPPORTED_EXECUTION_MODE", traceId }));
  if (parsed.data.dryRun) {
    if (parsed.data.simulation !== undefined)
      return handleReadFixtureSimulation(request, reply, services, user, workflow, parsed.data.simulation, parsed.data.input ?? {}, traceId);
    const validation = services.validator.validatePlan("ReadWorkflowSimulation", workflow.yaml, user.role);
    let issues: string[] = [];
    try { issues = inspectReadWorkflow(parseWorkflowYAMLStrict(workflow.yaml), services.registries.snapshot().tools, user.role); }
    catch { issues = ["Workflow could not be parsed"]; }
    return reply.send(ok({ dry_run: true, simulation: "static-read-plan", can_execute: false,
      plan_valid: validation.passed && issues.length === 0, validation, issues, live_readiness: "not_checked",
      planned_steps: (() => { try { return withoutSecretFields(parseWorkflowYAMLStrict(workflow.yaml).steps); } catch { return []; } })() },
      "Static simulation only; no live discovery or execution was performed", { traceId }));
  }
  if (workflow.pendingGenerationApproval && workflow.pendingGenerationApproval.steps.length > 0)
    return reply.status(409).send(fail("This workflow has a pending approval — resolve it in chat before running", { pendingGenerationApproval: workflow.pendingGenerationApproval }));
  const localValidation = asyncRead ? services.validator.validatePlan("QueueReadWorkflow", workflow.yaml, user.role) : null;
  const gate = asyncRead ? null : await validateWithGovernance(services, "RunWorkflow", workflow.yaml, user, { traceId, workflowId: workflow.id });
  const validation = localValidation ?? gate!.result;
  if (!validation.passed)
    return reply.status(422).send(fail("Workflow validation failed", { ...validation, traceId }));
  const checkedBlueprint = parseWorkflowYAMLStrict(workflow.yaml);
  if (checkedBlueprint.steps.some((step) => step.kind === "approval"))
    return reply.status(409).send(fail("Runtime approval checkpoints require the safe checkpoint executor; this legacy run is blocked", { code: "RUNTIME_APPROVAL_EXECUTOR_REQUIRED", traceId }));
  if (workflow.publishedVersion < 1)
    return reply.status(409).send(fail("Publish the validated draft before execution", { code: "WORKFLOW_NOT_PUBLISHED", traceId }));
  const publication = await services.repository.read((state) => (state.versions[workflow.id] ?? []).findLast((version) => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED"));
  if (publication === undefined || typeof publication.yaml !== "string" || publication.yaml !== workflow.yaml)
    return reply.status(409).send(fail("A current verified publication snapshot is required; legacy or edited drafts need explicit publication", { code: "PUBLISHED_SNAPSHOT_REQUIRED", traceId }));
  if (!asyncRead && gate!.token === null)
    return reply.status(422).send(fail("Execution verification receipt is unavailable", { traceId }));
  return runVerifiedRead(workflow, parsed.data.input ?? {}, gate?.token ?? null, traceId, request, reply, user, services);
}

export async function resumeWorkflowApproval(
  execution: Execution,
  _note: string,
  _request: FastifyRequest,
  reply: FastifyReply,
  _user: User & { role: string; permissions: string[] },
  _services: ApplicationServices,
): Promise<unknown> {
  if (execution.status !== "AWAITING_APPROVAL" || !execution.pendingApproval)
    return reply.status(409).send(fail("This execution is not awaiting approval", null));
  return reply.status(409).send(fail("Runtime approval resume requires the safe checkpoint executor", {
    code: "RUNTIME_APPROVAL_EXECUTOR_REQUIRED", executionId: execution.id,
  }));
}

function publicWorkflow(workflow: Workflow): Omit<Workflow, "yaml" | "archived"> {
  const { yaml: _yaml, archived: _archived, ...publicPart } = workflow;
  return publicPart;
}

function param(request: FastifyRequest, name: string): string {
  return String((request.params as Record<string, unknown>)[name] ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
