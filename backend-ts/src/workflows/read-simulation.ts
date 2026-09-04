import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "../registry/schemas.js";
import { compileReadWorkflow, resolveReadBinding, type CompiledReadPlan } from "./compiled-read.js";
import { interpretReadPlan } from "./read-interpreter.js";
import { safeMcpResult } from "../tools/mcp-result.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { structuralNodes } from "./read-control-flow.js";

const fixtureSchema = z.object({ profile: z.literal("read-fixtures/v1"), baseVersion: z.number().int().min(1), baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), outputs: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(value => !["input", "__proto__", "constructor", "prototype"].includes(value)), z.unknown()) }).strict();
export function boundFixtureData(raw: unknown): void {
  let count = 0;
  const bound = (value: unknown, depth: number): void => {
    if (++count > 32768 || depth > 32) throw new Error("Fixture input exceeds structural limits");
    if (value !== null && typeof value === "object") for (const child of Object.values(value)) bound(child, depth + 1);
    else if (value !== null && !["string", "boolean", "number"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new Error("Fixture input must be finite JSON");
  };
  bound(raw, 0);
  if (canonicalJSONBytes(raw).length > 512_000) throw new Error("Fixture input exceeds byte limits");
}
export function parseReadFixtures(raw: unknown) {
  boundFixtureData(raw);
  const parsed = fixtureSchema.parse(raw);
  if (Object.keys(parsed.outputs).length > 200) throw new Error("Too many fixture outputs");
  return parsed;
}
export type ReadFixtures = ReturnType<typeof parseReadFixtures>;
export type SimulationEntry = { nodeId: string; kind: "action" | "condition" | "merge" | "return"; outcome: string; sourceIndex: number; arguments?: unknown; output?: unknown; selectedBranch?: "then" | "else"; conditionId?: string; returnId?: string; reason?: string };
class SimulationStop extends Error { constructor(readonly code: string) { super(code); } }

/** No live services are accepted. Fixture outputs are supplied test data,
 * never ERP evidence, capability grants or persisted execution checkpoints. */
export async function simulateReadWorkflow(yaml: string, input: Record<string, unknown>, fixtures: ReadFixtures, tools: readonly ToolDefinition[], role: string,
  validateSelected?: (nodeId: string, args: Record<string, unknown>, prior: readonly { nodeId: string; args: Record<string, unknown> }[]) => boolean) {
  const trace: SimulationEntry[] = [], stepOutputs: Record<string, unknown> = {}, valueOutputs: Record<string, { value: unknown }> = {}, used = new Set<string>();
  const completed: Array<{ nodeId: string; args: Record<string, unknown> }> = [];
  boundFixtureData({ input, outputs: fixtures.outputs });
  let plan: CompiledReadPlan;
  try { plan = compileReadWorkflow(yaml, tools, role); }
  catch { return { outcome: "PLAN_BLOCKED", issues: ["Workflow does not meet the supported compiled read profile"], trace, stepOutputs, valueOutputs, usedFixtureIds: [], unusedFixtureIds: Object.keys(fixtures.outputs) }; }
  if (Object.keys(fixtures.outputs).some(id => !plan.ir.root.nodes.some(node => node.id === id))) throw new Error("Fixture names must match declared action IDs");
  const valueSchemas = new Map(plan.ir.flow ? structuralNodes(plan.ir.flow).map(node => [node.id, node.kind === "return" ? node.output.schema : node.merge?.schema] as const) : []);
  const fixtureHash = `sha256:${createHash("sha256").update(canonicalJSONBytes({ input, fixtures: fixtures.outputs })).digest("hex")}`;
  let bytes = 0, failedNodeId: string | undefined, finalOutput: unknown, hasFinal = false;
  const append = (entry: SimulationEntry) => {
    bytes += canonicalJSONBytes(entry).length;
    if (trace.length >= 400 || bytes > 1_000_000) throw new SimulationStop("SIMULATION_OUTPUT_LIMIT");
    trace.push(entry);
  };
  const fail = (entry: SimulationEntry, code: string): never => { append({ ...entry, outcome: code }); throw new SimulationStop(code); };
  const state: Record<string, unknown> = { input: structuredClone(input) };
  try {
    if (plan.ir.inputSchema && validateToolInput(plan.ir.inputSchema, input).length) throw new SimulationStop("WORKFLOW_INPUT_INVALID");
    await interpretReadPlan(plan, state, {
      action: async (node, sourceIndex) => {
        failedNodeId = node.id;
        const entry: SimulationEntry = { nodeId: node.id, kind: "action", sourceIndex, outcome: "SIMULATED" };
        let args: Record<string, unknown>;
        try { args = resolveReadBinding(node.inputs, state) as Record<string, unknown>; } catch { return fail(entry, "BINDING_UNAVAILABLE_OR_LIMITED"); }
        const tool = tools.find(tool => tool.tool_id === node.capability.toolId)!;
        if (validateToolInput(tool.input_schema, args).length) return fail(entry, "ARGUMENTS_INVALID");
        entry.arguments = withoutSecretFields(args);
        if (validateSelected && !validateSelected(node.id, args, completed)) return fail(entry, "SELECTED_PATH_RULE_BLOCKED");
        if (!Object.hasOwn(fixtures.outputs, node.id)) return fail(entry, "MISSING_FIXTURE");
        let output: Record<string, unknown>;
        try { output = safeMcpResult(fixtures.outputs[node.id], tool.bridge_contract?.output_schema); } catch { return fail(entry, "FIXTURE_OUTPUT_INVALID"); }
        used.add(node.id);
        if (output.isError === true) return fail({ ...entry, output }, "FIXTURE_TOOL_ERROR");
        append({ ...entry, output }); stepOutputs[node.id] = output; finalOutput = output; hasFinal = true; completed.push({ nodeId: node.id, args });
        return output;
      },
      condition: async (sourceIndex, id, predicate) => {
        failedNodeId = id;
        const entry: SimulationEntry = { nodeId: id, kind: "condition", sourceIndex, outcome: "SIMULATED_DECISION" };
        if (predicate === undefined) return fail(entry, "PREDICATE_INVALID");
        append({ ...entry, selectedBranch: predicate ? "then" : "else" });
      },
      skipped: async (sourceIndex, id, reason) => { failedNodeId = id; append({ nodeId: id, kind: "action", sourceIndex, outcome: reason.kind === "return" ? "AFTER_RETURN" : "NOT_SELECTED", ...(reason.kind === "return" ? { returnId: reason.returnId } : { conditionId: reason.conditionId, selectedBranch: reason.selected }) }); },
      value: async (sourceIndex, id, kind, value, valid) => {
        failedNodeId = id;
        const entry: SimulationEntry = { nodeId: id, kind, sourceIndex, outcome: "SIMULATED_VALUE" };
        if (!valid) return fail(entry, "VALUE_INVALID");
        const safe = withoutSecretFields({ value }) as { value: unknown };
        if (!valueSchemas.get(id) || validateToolInput(valueSchemas.get(id)!, safe.value).length) return fail(entry, "VALUE_INVALID");
        append({ ...entry, output: safe.value }); valueOutputs[id] = safe;
        if (kind === "return") { finalOutput = safe.value; hasFinal = true; }
        return safe;
      },
    });
    return { outcome: "SIMULATED_COMPLETE", trace, stepOutputs, valueOutputs, ...(hasFinal ? { finalOutput } : {}), usedFixtureIds: [...used], unusedFixtureIds: Object.keys(fixtures.outputs).filter(id => !used.has(id)), fixtureHash, sourceHash: plan.sourceHash, semanticHash: plan.semanticHash };
  } catch (error) {
    return { outcome: "SIMULATED_STOPPED", reason: error instanceof SimulationStop ? error.code : "SIMULATION_EVALUATION_FAILED", ...(failedNodeId ? { failedNodeId } : {}), trace, stepOutputs, valueOutputs, ...(hasFinal ? { finalOutput } : {}), usedFixtureIds: [...used], unusedFixtureIds: Object.keys(fixtures.outputs).filter(id => !used.has(id)), fixtureHash, sourceHash: plan.sourceHash, semanticHash: plan.semanticHash };
  }
}
