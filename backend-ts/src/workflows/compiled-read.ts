import { createHash } from "node:crypto";
import type { WorkflowBlueprint } from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { validateToolInput, validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";

export type ReadReference = { kind: "ref"; source: "workflowInput" | "nodeOutput"; nodeId?: string; path: string[] };
export type ReadBinding = ReadReference | { kind: "literal"; value: string | number | boolean | null } |
  { kind: "object"; fields: Record<string, ReadBinding> } | { kind: "array"; items: ReadBinding[] } |
  { kind: "template"; parts: Array<string | ReadReference> };
export type ReadAdmissionPin = { connectionId: string; capabilityId: string; revisionId: string; admissionVersion: number; contractHash: string };
export type ReadIR = { schemaVersion: "workflow-read-ir/v1"; compilerVersion: "read-compiler/v1"; trigger: { kind: "manual" };
  inputSchema?: Record<string, unknown>; root: { kind: "sequence"; nodes: Array<{ id: string; kind: "action";
    capability: { toolId: string; action: string; remoteName: string; contractHash: string; admission?: ReadAdmissionPin };
    inputs: ReadBinding }> } };
export type CompiledReadPlan = { ir: ReadIR; semanticHash: string; sourceHash: string };
export type ReadCompilationReceipt = { schemaVersion: ReadIR["schemaVersion"]; compilerVersion: ReadIR["compilerVersion"]; semanticHash: string; sourceHash: string;
  registryHash: string; origin: "PUBLICATION" | "LEGACY_PREFLIGHT"; admissionMode: "reviewed" | "fixture-legacy" };
export function readCompilationReceipt(plan: CompiledReadPlan, registryHash: string, origin: ReadCompilationReceipt["origin"], admissionMode: ReadCompilationReceipt["admissionMode"]): ReadCompilationReceipt {
  return { schemaVersion: plan.ir.schemaVersion, compilerVersion: plan.ir.compilerVersion, semanticHash: plan.semanticHash, sourceHash: plan.sourceHash, registryHash, origin, admissionMode };
}
const reserved = new Set(["__proto__", "constructor", "prototype"]);
const supported = new Set(["id", "kind", "action", "parameters", "description"]);
const hashIR = (ir: ReadIR) => `sha256:${createHash("sha256").update(canonicalJSONBytes(ir)).digest("hex")}`;

/** Pure executable projection. YAML/presentation labels are not runtime logic.
 * Missing output/input schemas require concrete runtime guards, not inferred
 * types or model-supplied values. Other control-flow profiles remain explicit
 * compiler errors until their structured semantics are implemented. */
export function buildReadIR(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, pins: ReadonlyMap<string, ReadAdmissionPin> = new Map()):
  { ir: ReadIR; semanticHash: string; issues: string[] } {
  const issues: string[] = [], ids = new Set<string>(), outputs = new Map<string, Record<string, unknown>>();
  let bindingNodes = 0;
  const inputSchema = blueprint.trigger.config?.inputSchema;
  if (blueprint.trigger.type !== "manual" || Object.keys(blueprint.trigger.config ?? {}).some(key => key !== "inputSchema")) issues.push("Compiled read workflows require a manual trigger and supported input configuration");
  if (inputSchema !== undefined && ((inputSchema as Record<string, unknown> | null)?.type !== "object" || validateToolSchemaProfile(inputSchema).length)) issues.push("Workflow input schema is unsupported");
  const ir: ReadIR = { schemaVersion: "workflow-read-ir/v1", compilerVersion: "read-compiler/v1", trigger: { kind: "manual" },
    ...(inputSchema === undefined ? {} : { inputSchema: structuredClone(inputSchema) as Record<string, unknown> }), root: { kind: "sequence", nodes: [] } };
  if (blueprint.steps.length < 1 || blueprint.steps.length > 200) issues.push("Read workflows require 1–200 steps");
  for (const step of blueprint.steps.slice(0, 200)) {
    let localNodes = 0;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id) || step.id === "input" || reserved.has(step.id) || ids.has(step.id)) issues.push("Step IDs must be unique, reference-safe and non-reserved");
    if (effectiveStepKind(step) !== "tool" || Object.keys(step).some(key => !supported.has(key))) issues.push(`Step ${step.id} uses unsupported execution semantics`);
    const matches = tools.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action), tool = matches.length === 1 ? matches[0] : undefined;
    if (!tool || !tool.tool_id || !tool.mcp_tool_name || !tool.is_read_only || !tool.allowed_roles.includes(role)) issues.push(`Step ${step.id} requires a unique role-granted registered read tool`);
    else issues.push(...validateToolSchemaProfile(tool.input_schema));
    const reference = (expression: string): ReadReference => {
      const path = expression.trim().split("."), root = path.shift()!;
      if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(expression.trim()) || [root, ...path].some(part => reserved.has(part))) issues.push(`Step ${step.id} has an unsupported data reference`);
      if (root !== "input" && !ids.has(root)) issues.push(`Step ${step.id} has an unavailable or forward data reference`);
      return root === "input" ? { kind: "ref", source: "workflowInput", path } : { kind: "ref", source: "nodeOutput", nodeId: root, path };
    };
    const binding = (value: unknown, depth: number): ReadBinding => {
      if (++localNodes > 4096 || ++bindingNodes > 32768 || depth > 16) { issues.push("Read parameters exceed supported limits"); return { kind: "literal", value: null }; }
      if (typeof value === "string") {
        const exact = /^\{\{([\s\S]*?)\}\}$/.exec(value.trim()); if (exact) return reference(exact[1]!);
        const parts: Array<string | ReadReference> = []; let end = 0;
        for (const match of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) { parts.push(value.slice(end, match.index), reference(match[1]!)); end = match.index + match[0].length; }
        parts.push(value.slice(end));
        if (parts.some(part => typeof part === "string" && (part.includes("{{") || part.includes("}}")))) issues.push(`Step ${step.id} has a malformed data reference`);
        return parts.length > 1 ? { kind: "template", parts } : { kind: "literal", value };
      }
      if (Array.isArray(value)) return { kind: "array", items: value.slice(0, 4097).map(child => binding(child, depth + 1)) };
      if (value !== null && typeof value === "object") {
        const entries = Object.entries(value); if (entries.some(([key]) => reserved.has(key))) issues.push("Read parameters contain reserved keys");
        return { kind: "object", fields: Object.fromEntries(entries.slice(0, 4097).map(([key, child]) => [key, binding(child, depth + 1)])) };
      }
      if (value !== null && !(typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))) { issues.push("Read parameters must be finite JSON values"); return { kind: "literal", value: null }; }
      return { kind: "literal", value: value as number | boolean | null };
    };
    const inputs = binding(step.parameters ?? {}, 0);
    if (tool) {
      checkBinding(inputs, tool.input_schema, `Step ${step.id}`, issues, ref => {
        const schema = ref.source === "workflowInput" ? ir.inputSchema : outputs.get(ref.nodeId!);
        return schemaAt(schema, ref.path);
      });
      ir.root.nodes.push({ id: step.id, kind: "action", capability: { toolId: tool.tool_id, action: tool.name, remoteName: exactBridgeName(tool), contractHash: capabilityContractHash(tool),
        ...(pins.has(tool.tool_id) ? { admission: structuredClone(pins.get(tool.tool_id)!) } : {}) }, inputs });
      if (tool.bridge_contract?.output_schema) {
        issues.push(...validateToolSchemaProfile(tool.bridge_contract.output_schema));
        outputs.set(step.id, { type: "object", properties: { structuredContent: tool.bridge_contract.output_schema }, required: ["structuredContent"] });
      }
    }
    ids.add(step.id);
  }
  // Bound the projection as well as its source: reference expansion/metadata
  // cannot turn a bounded YAML file into an unbounded saved artifact.
  if (canonicalJSONBytes(ir).length > 1_000_000) issues.push("Compiled read artifact exceeds supported size");
  return { ir, semanticHash: hashIR(ir), issues: [...new Set(issues)] };
}

export function compileReadWorkflow(yaml: string, tools: readonly ToolDefinition[], role: string, pins?: ReadonlyMap<string, ReadAdmissionPin>): CompiledReadPlan {
  if (Buffer.byteLength(yaml) > 200_000) throw new Error("Read workflow exceeds supported source size");
  const built = buildReadIR(parseWorkflowYAMLStrict(yaml), tools, role, pins);
  if (built.issues.length) throw new Error(`Read compilation failed: ${built.issues.join("; ")}`);
  return { ir: built.ir, semanticHash: built.semanticHash, sourceHash: workflowContentHash(yaml) };
}

export function assertCompiledReadMatches(expected: CompiledReadPlan, actual: CompiledReadPlan) {
  if (expected.sourceHash !== actual.sourceHash || expected.semanticHash !== actual.semanticHash || hashIR(expected.ir) !== expected.semanticHash)
    throw new Error("Compiled workflow source, semantic identity or capability pins changed");
}

export function resolveReadBinding(binding: ReadBinding, state: Record<string, unknown>): unknown {
  if (binding.kind === "literal") return binding.value;
  if (binding.kind === "object") return Object.fromEntries(Object.entries(binding.fields).map(([key, value]) => [key, resolveReadBinding(value, state)]));
  if (binding.kind === "array") return binding.items.map(value => resolveReadBinding(value, state));
  if (binding.kind === "template") return binding.parts.map(part => {
    if (typeof part === "string") return part;
    const value = resolveReadBinding(part, state); if (typeof value !== "string") throw new Error("String templates require string references; no implicit conversion is allowed"); return value;
  }).join("");
  const root = binding.source === "workflowInput" ? "input" : binding.nodeId!;
  if (!Object.hasOwn(state, root)) throw new Error("Compiled data reference is unavailable");
  let current: unknown = state[root];
  for (const part of binding.path) {
    if (reserved.has(part) || current === null || typeof current !== "object" || !Object.hasOwn(current, part)) throw new Error("Compiled data reference is unavailable");
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) throw new Error("Compiled data reference is unavailable");
  return structuredClone(current);
}

function schemaAt(schema: Record<string, unknown> | undefined, path: string[]): Record<string, unknown> | undefined {
  let current = schema;
  for (const part of path) {
    if (current?.type === "array" && /^(0|[1-9][0-9]*)$/.test(part)) current = current.items as Record<string, unknown> | undefined;
    else current = (current?.properties as Record<string, Record<string, unknown>> | undefined)?.[part];
  }
  return current;
}
function checkBinding(binding: ReadBinding, schema: Record<string, unknown> | undefined, label: string, issues: string[], referenceSchema: (ref: ReadReference) => Record<string, unknown> | undefined) {
  if (!schema) return; // Unknown reference types must be checked at runtime.
  if (binding.kind === "ref") {
    const source = referenceSchema(binding);
    if (source && !compatibleSchemas(source, schema)) issues.push(`${label} has an incompatible typed reference`);
    return;
  }
  if (binding.kind === "template") {
    if (schema.type !== "string") issues.push(`${label} has an incompatible string template`);
    for (const part of binding.parts) if (typeof part !== "string" && referenceSchema(part)?.type !== undefined && referenceSchema(part)?.type !== "string") issues.push(`${label} requires an explicit string conversion`);
    return;
  }
  if (binding.kind === "literal") { if (validateToolInput(schema, binding.value).length) issues.push(`${label} has an invalid literal input`); return; }
  if (binding.kind === "array") {
    if (schema.type !== "array") issues.push(`${label} has an incompatible array input`);
    else for (const child of binding.items) checkBinding(child, schema.items as Record<string, unknown>, label, issues, referenceSchema);
    return;
  }
  if (schema.type !== "object") { issues.push(`${label} has an incompatible object input`); return; }
  const required = schema.required as string[] | undefined, properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  for (const key of required ?? []) if (!Object.hasOwn(binding.fields, key)) issues.push(`${label} is missing required input ${key}`);
  for (const [key, child] of Object.entries(binding.fields)) {
    if (!properties?.[key] && schema.additionalProperties === false) issues.push(`${label} contains unsupported input ${key}`);
    checkBinding(child, properties?.[key], label, issues, referenceSchema);
  }
}

function compatibleSchemas(source: Record<string, unknown>, target: Record<string, unknown>, depth = 0): boolean {
  if (!source || !target) return false;
  if (depth > 16 || source.type !== target.type && !(source.type === "integer" && target.type === "number")) return false;
  if (source.type === "array" && target.type === "array") return compatibleSchemas(source.items as Record<string, unknown>, target.items as Record<string, unknown>, depth + 1);
  if (source.type === "object" && target.type === "object") {
    const from = source.properties as Record<string, Record<string, unknown>> | undefined, to = target.properties as Record<string, Record<string, unknown>> | undefined;
    for (const key of target.required as string[] | undefined ?? []) if (!from?.[key] && source.additionalProperties === false) return false;
    for (const [key, schema] of Object.entries(to ?? {})) if (from?.[key] && !compatibleSchemas(from[key], schema, depth + 1)) return false;
  }
  return true; // Optional presence/unknown additional fields remain runtime guards.
}
