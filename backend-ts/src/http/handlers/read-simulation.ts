import type { FastifyReply, FastifyRequest } from "fastify";
import type { Workflow } from "../../models/schemas.js";
import { fail, ok } from "../../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "./common.js";
import { assertActorAuthority } from "./model-selection.js";
import { requireWorkflowBase } from "../../workflows/commands.js";
import { boundFixtureData, parseReadFixtures, simulateReadWorkflow } from "../../workflows/read-simulation.js";
import { selectedReadEvidenceYAML } from "../../workflows/read-completion-evidence.js";
import { parseModelFixtures, simulateModelWorkflow } from "../../workflows/model-simulation.js";

/** Bound fixture-bearing bodies before the recursively defined request schema.
 * Legacy non-fixture requests retain their existing validation contract. */
export function boundedReadFixtureRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("simulation" in body) || (body as Record<string, unknown>).simulation === undefined) return true;
  try { boundFixtureData(body); return true; } catch { return false; }
}

export async function handleReadFixtureSimulation(request: FastifyRequest, reply: FastifyReply, services: HandlerServices, user: CurrentUser, workflow: Workflow, raw: unknown, input: Record<string, unknown>, traceId: string) {
  let fixtures;
  const modelFixtures = raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).profile === "model-fixtures/v1";
  try { fixtures = modelFixtures ? parseModelFixtures(raw) : parseReadFixtures(raw); boundFixtureData({ input, outputs: fixtures.outputs }); }
  catch { return reply.status(400).send(fail("Invalid or oversized read simulation fixtures", { code: "SIMULATION_FIXTURES_INVALID", traceId })); }
  try {
    requireWorkflowBase(workflow, fixtures.baseVersion, fixtures.baseHash);
    const registryHash = services.registries.hash(), tools = services.registries.snapshot().tools;
    const validation = services.validator.validatePlan("ReadFixtureSimulation", workflow.yaml, user.role);
    // Parser/rule messages may quote source values. Expose verifier verdicts
    // and bounded categories, not source excerpts or substituted fixture data.
    const publicValidation = { passed: validation.passed, score: validation.score,
      schema_ok: validation.schema_ok, tool_validity_ok: validation.tool_validity_ok, parameters_ok: validation.parameters_ok,
      rbac_ok: validation.rbac_ok, policy_ok: validation.policy_ok, process_order_ok: validation.process_order_ok, risk_ok: validation.risk_ok,
      errors: [...new Set(validation.errors.map(error => /^[A-Z][A-Z0-9_-]{0,63}:/.test(error) ? error.split(":")[0]! : "LOCAL_VERIFIER_REJECTED"))].slice(0, 50),
      warningCount: validation.warnings.length, failedRuleCount: validation.failed_rules.length };
    let result: Awaited<ReturnType<typeof simulateReadWorkflow>> | Awaited<ReturnType<typeof simulateModelWorkflow>>;
    if (!validation.passed) result = { outcome: "PLAN_BLOCKED", issues: ["Original local verifier rejected this draft"], trace: [], stepOutputs: {}, valueOutputs: {}, usedFixtureIds: [], unusedFixtureIds: Object.keys(fixtures.outputs) };
    else {
      const blueprint = parseWorkflowYAMLStrict(workflow.yaml);
      const selected: Parameters<typeof simulateReadWorkflow>[5] = (nodeId, args, prior, visit) => {
        const prefix = selectedReadEvidenceYAML(blueprint, nodeId, args, visit, prior);
        return services.validator.validatePlan("ReadFixtureSelectedPath", prefix, user.role).passed;
      };
      result = fixtures.profile === "model-fixtures/v1" ? await simulateModelWorkflow(workflow.yaml, input, fixtures, tools, user.role, selected) :
        await simulateReadWorkflow(workflow.yaml, input, fixtures, tools, user.role, selected);
    }
    // Local interpretation awaits its driver. Deliver only under the same
    // actor, accessible saved revision and registry used by the simulation.
    try { await services.repository.readAuthoritative(state => {
      const permissions = assertActorAuthority(state, user), current = state.workflows[workflow.id];
      if (!current || current.archived || !permissions.includes("workflow:run") && (!permissions.includes("workflow:run_own") || current.owner.id !== user.id && !(current.assignedUserIds ?? []).includes(user.id))) throw new HandlerFailure(404, "Workflow not found or no longer accessible");
      requireWorkflowBase(current, fixtures.baseVersion, fixtures.baseHash);
      if (current.yaml !== workflow.yaml || workflowContentHash(current.yaml) !== fixtures.baseHash || registryHash !== services.registries.hash()) throw new HandlerFailure(409, "Simulation context changed; reload the draft and test data", { code: "SIMULATION_CONTEXT_CHANGED" });
    }); } catch (error) {
      if (error instanceof HandlerFailure) throw error;
      throw new HandlerFailure(503, "Simulation authority could not be confirmed; reload after storage recovery", { code: "SIMULATION_AUTHORITY_UNAVAILABLE" });
    }
    return reply.send(ok({ dry_run: true, simulation: fixtures.profile === "model-fixtures/v1" ? "fixture-model/v1" : fixtures.profile === "read-fixtures/v2" ? "fixture-read/v2" : "fixture-read/v1", can_execute: false, plan_valid: validation.passed && result.outcome !== "PLAN_BLOCKED", validation: publicValidation, live_readiness: "not_checked", runtime_authorization: "not_checked", capability_admission: "not_checked", erp_calls: 0, model_calls: 0, persisted_run: false,
      ...(modelFixtures ? { model_behavior: "not_tested", model_usage: "not_measured", agent_tool_calls: "not_simulated", approval: "not_granted" } : {}),
      workflowId: workflow.id, baseVersion: fixtures.baseVersion, baseHash: fixtures.baseHash, registryHash, ...result }, "Fixture simulation only; no live service or execution was performed", { traceId }));
  } catch (error) {
    if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
    return reply.status(400).send(fail("Simulation fixtures do not match the supported draft", { code: "SIMULATION_FIXTURES_INVALID", traceId }));
  }
}
