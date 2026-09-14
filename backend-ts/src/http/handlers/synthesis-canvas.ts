import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import { requestTraceId } from "../../trace/request-trace.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import type { RouteDefinition } from "../generated-routes.js";
import {
  bodyRecord,
  HandlerFailure,
  type CurrentUser,
  type HandlerServices,
  stringValue,
  validateWorkflow,
} from "./common.js";
import {
  assertActorAuthority,
  requestedModel,
  selectProvider,
} from "./model-selection.js";
import { CanvasConversionFailure, canvasStepErrors, convertSourceOrderCanvas } from "../../workflows/canvas-source-order.js";
import { validateWorkspaceDraft } from "../../workflows/draft-validation.js";

export const SYNTHESIS_CANVAS_UNHANDLED = Symbol("synthesis-canvas-unhandled");

/** Owns workflow synthesis, explanation, preview, and canvas validation. */
export async function handleSynthesisCanvasRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof SYNTHESIS_CANVAS_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/synthesis/validate`)
    return synthesisValidate(request, reply, user, services);
  if (route.path === `${base}/synthesis/preview-flow`)
    return synthesisPreview(request, reply);
  if (route.path === `${base}/synthesis/explain`)
    return synthesisExplain(request, reply);
  if (route.path === `${base}/synthesis`)
    return synthesis(request, reply, user, services);
  if (route.path === `${base}/canvas/validate-workflow`)
    return canvasValidate(request, reply, user, services);
  return SYNTHESIS_CANVAS_UNHANDLED;
}

async function synthesis(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null || stringValue(body.prompt).trim() === "")
    throw new HandlerFailure(400, "prompt is required");
  if (services.synthesis === undefined)
    throw new HandlerFailure(502, "Workflow synthesis service is not configured");

  const provider = selectProvider(services, requestedModel(body.model));
  try {
    const liveTools = await discoverTools(
      services.erpbridgeSession ?? null,
      services.registries,
    );
    const result = await services.synthesis.synthesize({
      prompt: stringValue(body.prompt),
      userRole: user.role,
      user: { id: user.id, role: user.role, department: user.departmentId },
      ...(provider === undefined ? {} : { providerRuntime: provider }),
      signal: request.signal,
      liveTools,
    });
    await services.repository.read((state) => assertActorAuthority(state, user));
    const meta = result.canExecute
      ? null
      : {
          failed_rules: result.validation.failed_rules,
          errors: result.validation.errors,
        };
    return reply.send(
      ok(
        result,
        result.canExecute
          ? "Workflow candidate generated and validated"
          : "Workflow candidate rejected by validation",
        meta,
      ),
    );
  } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    throw new HandlerFailure(502, errorText(error));
  }
}

async function synthesisValidate(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const body = bodyRecord(request) ?? {};
  const gate = await validateWorkflow(
    services,
    "SynthesisValidate",
    stringValue(body.yaml),
    user,
    { traceId: requestTraceId(request) },
  );
  return reply.send(
    ok(
      gate.result,
      gate.result.passed ? "Workflow is valid" : "Workflow is invalid",
      null,
    ),
  );
}

async function synthesisPreview(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = bodyRecord(request) ?? {};
  let blueprint;
  try {
    blueprint = parseWorkflowYAMLStrict(stringValue(body.yaml));
  } catch (error) {
    throw new HandlerFailure(422, "Cannot preview invalid YAML", {
      error: errorText(error),
    });
  }
  return reply.send(
    ok(canvasFromBlueprint("preview", blueprint), "Flow preview generated", null),
  );
}

async function synthesisExplain(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = bodyRecord(request) ?? {};
  let blueprint;
  try {
    blueprint = parseWorkflowYAMLStrict(stringValue(body.yaml));
  } catch (error) {
    throw new HandlerFailure(422, "Cannot explain invalid YAML", {
      error: errorText(error),
    });
  }
  return reply.send(
    ok(
      {
        summary: blueprint.description ?? blueprint.name,
        steps: blueprint.steps.map((step) => ({
          id: step.id,
          action: step.kind === "analysis" ? "analysis" : (step.action ?? ""),
          purpose: step.description ?? step.instruction ?? "",
        })),
      },
      "Workflow explanation generated",
      null,
    ),
  );
}

async function canvasValidate(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  let yaml = stringValue(body.yaml), conversion: ReturnType<typeof convertSourceOrderCanvas> | null = null;
  const hasGraph = Object.hasOwn(body, "profile") || Object.hasOwn(body, "nodes") || Object.hasOwn(body, "edges");
  if (yaml.trim() !== "" && hasGraph) throw new HandlerFailure(400, "Provide either yaml or one source-order canvas graph, not both");
  if (yaml.trim() === "") {
    try { conversion = convertSourceOrderCanvas(body); yaml = conversion.yaml; }
    catch (error) {
      if (error instanceof CanvasConversionFailure)
        throw new HandlerFailure(422, "Canvas graph cannot be converted without changing its meaning", {
          code: "CANVAS_GRAPH_INVALID", issues: error.issues,
          suggested_fix: "Use one connected source-order chain, or author explicit branch/control-flow semantics in the workflow editor",
        });
      throw error;
    }
  }
  const gate = await validateWorkflow(
    services,
    "CanvasValidateWorkflow",
    yaml,
    user,
    { traceId: requestTraceId(request) },
  );
  const blueprint = conversion?.blueprint ?? (() => { try { return parseWorkflowYAMLStrict(yaml); } catch { return null; } })();
  const workspace = validateWorkspaceDraft("CanvasValidateWorkflow", yaml, user.role, services.validator, services.registries.snapshot().tools);
  const validation = { ...gate.result,
    passed: gate.result.passed && workspace.passed,
    schema_ok: gate.result.schema_ok && workspace.schema_ok,
    score: Math.min(gate.result.score, workspace.score),
    failed_rules: [...new Set([...gate.result.failed_rules, ...workspace.failed_rules])].sort(),
    errors: [...new Set([...gate.result.errors, ...workspace.errors])],
    metadata: { ...gate.result.metadata, ...workspace.metadata },
  };
  const stepErrors = blueprint ? canvasStepErrors(blueprint.steps, validation.errors) : validation.errors.map(message => ({ scope: "workflow", node_id: null, action: null, message }));
  return reply.send(
    ok(
      { validation, step_errors: stepErrors,
        conversion: conversion ? { profile: conversion.profile, node_order: conversion.nodeOrder, source_hash: workflowContentHash(yaml) } : null },
      validation.passed ? "Workflow is valid" : "Workflow is invalid",
      null,
    ),
  );
}

function canvasFromBlueprint(
  id: string,
  blueprint: ReturnType<typeof parseWorkflowYAMLStrict>,
): Record<string, unknown> {
  const nodes = blueprint.steps.map((step, index) => ({
    id: step.id,
    label: step.description ?? step.action ?? step.id,
    type: step.kind === undefined || step.kind === "" ? "tool" : step.kind,
    position: { x: 80 + index * 260, y: 120 },
    status: "idle",
    config: { action: step.action ?? "", parameters: step.parameters ?? {} },
  }));
  return {
    workflowId: id,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge_${index + 1}`,
      source: nodes[index]!.id,
      target: node.id,
      type: "default",
      label: null,
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
