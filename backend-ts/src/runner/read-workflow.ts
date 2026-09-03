import { type WorkflowBlueprint } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { buildReadIR, compileReadWorkflow, resolveReadBinding, assertCompiledReadMatches, type CompiledReadPlan } from "../workflows/compiled-read.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { dispatchReadTool, type ReadDispatchContext } from "../tools/read-tool-broker.js";
import type { HandlerServices } from "../http/handlers/common.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import type { RunnerResult } from "./executor.js";
import { ReadCheckpointFailure, ReadRunCancelled, type ReadExecutionHooks } from "./read-checkpoints.js";
import { ErpbridgeMcpToolError } from "../tools/erpbridge-mcp-client.js";
import { actionOrder, type ReadSequence } from "../workflows/read-control-flow.js";

/** Explicit read profiles: sequential actions and structured boolean branches. Unsupported logic
 * is rejected before any dispatch, never reinterpreted by an agent. */
export function inspectReadWorkflow(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string): string[] {
  return buildReadIR(blueprint, tools, role).issues;
}

export async function executeReadWorkflow(services: HandlerServices, actorId: string, yaml: string, input: Record<string, unknown>, token: ValidationToken,
  context: Omit<ReadDispatchContext, "plan" | "beforeDispatch">, hooks?: ReadExecutionHooks, expectedPlan?: CompiledReadPlan): Promise<RunnerResult> {
  if (yaml.length > 200_000) throw new Error("Read workflow exceeds supported source size");
  const blueprint = parseWorkflowYAMLStrict(yaml);
  const actor = await services.repository.effectiveUser(actorId);
  if (actor === null || inspectReadWorkflow(blueprint, services.registries.snapshot().tools, actor.role).length > 0)
    throw new Error("Read workflow does not meet the supported execution profile");
  const pins = new Map(expectedPlan?.ir.root.nodes.flatMap(node => node.capability.admission ? [[node.capability.toolId, node.capability.admission] as const] : []) ?? []);
  const currentPlan = compileReadWorkflow(yaml, services.registries.snapshot().tools, actor.role, pins);
  if (services.erpbridgeSession?.requiresReviewedRevision && !expectedPlan) throw new Error("Modern workflow execution requires a published compiled artifact");
  if (expectedPlan) assertCompiledReadMatches(expectedPlan, currentPlan);
  const plan = expectedPlan ?? currentPlan;
  if (plan.ir.inputSchema && validateToolInput(plan.ir.inputSchema, input).length) throw new Error("Workflow input does not meet the declared schema");
  const result: RunnerResult = { state: { input: structuredClone(input) }, timeline: [], logs: [], tokens: { input: 0, output: 0, total: 0 } };
  const definitions = new Map(plan.ir.root.nodes.map((node, index) => [node.id, { node, index }]));
  let cursor = 0;
  async function runAction(nodeId: string) {
    const { node, index } = definitions.get(nodeId)!;
    if (cursor !== index) throw new Error("Compiled action order changed");
    const step = blueprint.steps[index]!; // Labels only; executable order/inputs come from IR.
    const started = new Date();
    try {
      if (context.signal?.aborted) throw new ReadRunCancelled();
      await hooks?.preparing(index, step.id, step.description ?? step.action!, started.toISOString());
      const args = resolveReadBinding(node.inputs, result.state) as Record<string, unknown>;
      const admissionPin = node.capability.admission;
      const output = await dispatchReadTool(services, actorId, node.capability.action, args, { ...context, plan: { yaml, stepIndex: index, token, contractHash: node.capability.contractHash, toolId: node.capability.toolId, ...(admissionPin ? { admissionPin } : {}) },
        ...(hooks === undefined ? {} : { beforeDispatch: (role: string) => hooks.dispatchIntent(index, step.id, role) }) });
      const completed = new Date();
      const entry = { id: `tl_${index + 1}`, nodeId: step.id, label: step.description ?? step.action!, status: "DONE" as const, startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime(), sideEffect: false, output };
      const log = { timestamp: completed.toISOString(), level: "info" as const, nodeId: step.id, message: "Verified read completed", metadata: { action: step.action!, sideEffect: false } };
      // A result is not exposed to the next node until its checkpoint commits.
      await hooks?.completed(index, entry, log);
      result.state[step.id] = output;
      result.timeline.push(entry); result.logs.push(log);
      cursor = index + 1;
    } catch (cause) {
      if (cause instanceof ReadCheckpointFailure || cause instanceof ReadRunCancelled) {
        Object.defineProperty(cause, "runnerResult", { value: result }); throw cause;
      }
      const completed = new Date();
      // Do not reflect arbitrary remote exception strings/credentials to users.
      const error = new Error(`Read step ${step.id} failed or was blocked; no automatic replay was performed`, { cause });
      // A failure receipt belongs to this attempt, never stepOutputs/finalOutput
      // or a dependent node's successful data bindings.
      const entry = { id: `tl_${index + 1}`, nodeId: step.id, label: step.description ?? step.action!, status: "FAILED" as const, startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime(), sideEffect: false,
        ...(cause instanceof ErpbridgeMcpToolError ? { output: cause.result } : {}) };
      const log = { timestamp: completed.toISOString(), level: "error" as const, nodeId: step.id, message: error.message, metadata: { action: step.action!, sideEffect: false } };
      await hooks?.failed(index, entry, log, cause instanceof ErpbridgeMcpToolError);
      result.timeline.push(entry); result.logs.push(log);
      Object.defineProperty(error, "runnerResult", { value: result });
      throw error;
    }
  }
  async function skip(block: ReadSequence, conditionId: string, selected: "then" | "else") {
    for (const nodeId of actionOrder(block)) {
      if (context.signal?.aborted) throw new ReadRunCancelled();
      const { index } = definitions.get(nodeId)!;
      if (cursor !== index) throw new Error("Compiled branch order changed");
      const step = blueprint.steps[index]!;
      if (hooks && !hooks.skipped) throw new Error("Conditional execution requires skip checkpoints");
      await hooks?.skipped?.(index, nodeId, step.description ?? step.action!, conditionId, selected, actor!.role);
      cursor = index + 1;
    }
  }
  async function visit(block: ReadSequence) {
    for (const node of block.nodes) {
      if (context.signal?.aborted) throw new ReadRunCancelled();
      if (node.kind === "action") { await runAction(node.nodeId); continue; }
      if (hooks && !hooks.condition) throw new Error("Conditional execution requires decision checkpoints");
      let value: unknown;
      try { value = resolveReadBinding(node.predicate, result.state); } catch { /* Missing is not false. */ }
      if (typeof value !== "boolean") {
        await hooks?.condition?.(cursor, node.id, undefined, actor!.role);
        throw new Error(`Condition ${node.id} failed: predicate requires a present boolean; no implicit branch or tool dispatch`);
      }
      await hooks?.condition?.(cursor, node.id, value, actor!.role);
      const outer = new Set(Object.keys(result.state));
      if (value) { await visit(node.then); await skip(node.else, node.id, "then"); }
      else { await skip(node.then, node.id, "else"); await visit(node.else); }
      for (const key of Object.keys(result.state)) if (!outer.has(key)) delete result.state[key];
    }
  }
  await visit(plan.ir.flow ?? { kind: "sequence", nodes: plan.ir.root.nodes.map(node => ({ kind: "action", nodeId: node.id })) });
  return result;
}
