import { effectiveStepKind, type WorkflowBlueprint } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { parseWorkflowYAMLStrict, resolveVariables } from "../parser/workflow.js";
import { validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { dispatchReadTool, type ReadDispatchContext } from "../tools/read-tool-broker.js";
import type { HandlerServices } from "../http/handlers/common.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import type { RunnerResult } from "./executor.js";
import { ReadCheckpointFailure, ReadRunCancelled, type ReadExecutionHooks } from "./read-checkpoints.js";
import { ErpbridgeMcpToolError } from "../tools/erpbridge-mcp-client.js";

const supported = new Set(["id", "kind", "action", "parameters", "description"]);
/** Explicit first execution profile: sequential reads only. Unsupported logic
 * is rejected before any dispatch, never reinterpreted by an agent. */
export function inspectReadWorkflow(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string): string[] {
  const errors: string[] = [], ids = new Set<string>();
  if (blueprint.steps.length < 1 || blueprint.steps.length > 200) errors.push("Read workflows require 1–200 steps");
  for (const step of blueprint.steps) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id) || ["input", "constructor", "prototype"].includes(step.id) || ids.has(step.id)) errors.push("Step IDs must be unique, reference-safe and non-reserved");
    if (effectiveStepKind(step) !== "tool" || Object.keys(step).some((key) => !supported.has(key))) errors.push(`Step ${step.id} uses unsupported execution semantics`);
    const matches = tools.filter((tool) => tool.name === step.action || tool.mcp_tool_name === step.action);
    const tool = matches.length === 1 ? matches[0] : undefined;
    if (!tool || !tool.tool_id || !tool.mcp_tool_name || !tool.is_read_only || !tool.allowed_roles.includes(role)) errors.push(`Step ${step.id} requires a unique role-granted registered read tool`);
    else errors.push(...validateToolSchemaProfile(tool.input_schema));
    for (const value of parameterStrings(step.parameters ?? {}, errors)) {
      const unmatched = value.replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
        const path = expression.trim();
        if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(path) || path.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part))) errors.push(`Step ${step.id} has an unsupported data reference`);
        const root = path.split(".")[0]!;
        if (root !== "input" && !ids.has(root)) errors.push(`Step ${step.id} has an unavailable or forward data reference`);
        return "";
      });
      if (unmatched.includes("{{") || unmatched.includes("}}")) errors.push(`Step ${step.id} has a malformed data reference`);
    }
    ids.add(step.id);
  }
  return [...new Set(errors)];
}

export async function executeReadWorkflow(services: HandlerServices, actorId: string, yaml: string, input: Record<string, unknown>, token: ValidationToken,
  context: Omit<ReadDispatchContext, "plan" | "beforeDispatch">, hooks?: ReadExecutionHooks): Promise<RunnerResult> {
  if (yaml.length > 200_000) throw new Error("Read workflow exceeds supported source size");
  const blueprint = parseWorkflowYAMLStrict(yaml);
  const actor = await services.repository.effectiveUser(actorId);
  if (actor === null || inspectReadWorkflow(blueprint, services.registries.snapshot().tools, actor.role).length > 0)
    throw new Error("Read workflow does not meet the supported execution profile");
  const result: RunnerResult = { state: { input: structuredClone(input) }, timeline: [], logs: [], tokens: { input: 0, output: 0, total: 0 } };
  for (const [index, step] of blueprint.steps.entries()) {
    const started = new Date();
    try {
      if (context.signal?.aborted) throw new ReadRunCancelled();
      await hooks?.preparing(index, step.id, step.description ?? step.action!, started.toISOString());
      const args = resolveVariables(step.parameters ?? {}, result.state);
      const parameterIssues: string[] = [];
      if (parameterStrings(args, parameterIssues).some((value) => value.includes("{{") || value.includes("}}")) || parameterIssues.length)
        throw new Error("Read arguments contain unresolved references or exceed supported limits");
      const output = await dispatchReadTool(services, actorId, step.action!, args, { ...context, plan: { yaml, stepIndex: index, token },
        ...(hooks === undefined ? {} : { beforeDispatch: (role: string) => hooks.dispatchIntent(index, step.id, role) }) });
      const completed = new Date();
      const entry = { id: `tl_${index + 1}`, nodeId: step.id, label: step.description ?? step.action!, status: "DONE" as const, startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime(), sideEffect: false, output };
      const log = { timestamp: completed.toISOString(), level: "info" as const, nodeId: step.id, message: "Verified read completed", metadata: { action: step.action!, sideEffect: false } };
      // A result is not exposed to the next node until its checkpoint commits.
      await hooks?.completed(index, entry, log);
      result.state[step.id] = output;
      result.timeline.push(entry); result.logs.push(log);
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
  return result;
}

function parameterStrings(value: unknown, errors: string[]): string[] {
  const strings: string[] = [];
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 16) { errors.push("Read parameters exceed supported limits"); return; }
    if (typeof item === "string") { strings.push(item); return; }
    if (item === null || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) errors.push("Read parameters contain reserved keys");
      visit(child, depth + 1);
      if (nodes > 4096) break;
    }
  }
  visit(value, 0);
  return strings;
}
