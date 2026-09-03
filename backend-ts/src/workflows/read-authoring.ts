import type { WorkflowBlueprint } from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { buildReadIR, type ReadReference } from "./compiled-read.js";
import { validateReadControlFlow } from "./read-control-flow.js";
import { isSecretField } from "../redact/secrets.js";

type Schema = Record<string, unknown>;
type Source = { label: string; expression: string; binding: ReadReference; schema: Schema };
const reserved = new Set(["__proto__", "constructor", "prototype"]);
const safeID = (id: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && id !== "input" && !reserved.has(id);

/** Offline authoring hints, never discovery or dispatch authority. Schema
 * annotations/defaults/examples can contain business data or credentials and
 * are deliberately omitted. No result samples or connection secrets enter it. */
export function readAuthoringContract(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, registryHash: string) {
  let schemaNodes = 0, sourceNodes = 0;
  const project = (raw: unknown): Schema | undefined => {
    if (validateToolSchemaProfile(raw).length) return undefined;
    const visit = (schema: Schema, inheritedSensitive = false): Schema => {
      if (++schemaNodes > 4096) throw new Error("Authoring schema budget exceeded");
      const result: Schema = { type: schema.type };
      const sensitive = inheritedSensitive || schema.writeOnly === true;
      if (sensitive) result.writeOnly = true;
      if (schema.type === "object") {
        const entries = Object.entries(schema.properties as Record<string, Schema> ?? {});
        if (entries.some(([key]) => reserved.has(key))) throw new Error("Reserved schema field");
        result.properties = Object.fromEntries(entries.map(([key, child]) => [key, visit(child, sensitive || isSecretField(key))]));
        if (schema.required) result.required = [...schema.required as string[]];
        if (schema.additionalProperties !== undefined) result.additionalProperties = schema.additionalProperties;
      }
      if (schema.type === "array") result.items = visit(schema.items as Schema, sensitive);
      return result;
    };
    try { return visit(raw as Schema); } catch { return undefined; }
  };
  const sources = (schema: Schema | undefined, root: ReadReference, label: string): Source[] => {
    const result: Source[] = [];
    const visit = (value: Schema, path: string[]) => {
      if (value.writeOnly === true || result.length >= 128 || sourceNodes >= 8192) return;
      // Do not suggest a whole object containing fields marked writeOnly.
      const sensitive = (item: Schema): boolean => item.writeOnly === true || Object.values(item.properties as Record<string, Schema> ?? {}).some(sensitive) || !!item.items && sensitive(item.items as Schema);
      if (!sensitive(value)) {
        sourceNodes++;
        const binding = { ...root, path }, expression = `{{${[root.source === "workflowInput" ? "input" : root.nodeId!, ...path].join(".")}}}`;
        const displayPath = root.source === "nodeOutput" ? path.slice(root.path.length) : path;
        result.push({ label: [label, ...displayPath].join(" · "), expression, binding, schema: value });
      }
      if (value.type === "object") for (const [key, child] of Object.entries(value.properties as Record<string, Schema> ?? {}))
        if (/^[A-Za-z0-9_-]+$/.test(key) && !reserved.has(key)) visit(child, [...path, key]);
    };
    if (schema) visit(schema, root.path);
    return result;
  };
  const declaredInput = blueprint.trigger.config?.inputSchema as Schema | undefined;
  const inputSchema = declaredInput?.type === "object" ? project(declaredInput) : undefined;
  const upstream = sources(inputSchema, { kind: "ref", source: "workflowInput", path: [] }, "Workflow input");
  const compiled = blueprint.metadata?.controlFlow === undefined ? undefined : buildReadIR(blueprint, tools, role);
  const scopes = compiled?.ir.flow && !compiled.issues.length ? validateReadControlFlow(compiled.ir.flow, compiled.ir, new Map()).scopes : undefined;
  let prefix = blueprint.trigger.type === "manual" && Object.keys(blueprint.trigger.config ?? {}).every(key => key === "inputSchema"), seen = new Set<string>();
  const nodes = blueprint.steps.slice(0, 200).map(step => {
    const matches = tools.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action), tool = matches.length === 1 ? matches[0] : undefined;
    const granted = !!tool && !!tool.tool_id.trim() && !!tool.mcp_tool_name.trim() && tool.input_schema.type === "object" && tool.is_read_only && tool.allowed_roles.includes(role) && effectiveStepKind(step) === "tool";
    const schema = granted ? project(tool.input_schema) : undefined;
    const validScope = prefix && safeID(step.id) && !seen.has(step.id) && Object.keys(step).every(key => ["id", "kind", "action", "parameters", "description"].includes(key));
    const result = { nodeId: step.id, sourceAction: step.action ?? "", state: schema ? "LOCAL_CONTRACT" : "UNAVAILABLE",
      ...(schema && tool ? { inputSchema: schema, contractHash: capabilityContractHash(tool), actions: [tool.name, tool.mcp_tool_name] } : {}),
      dataSources: validScope && (!compiled || scopes) ? upstream.filter(source => !scopes || source.binding.source === "workflowInput" || scopes.get(step.id)?.has(source.binding.nodeId!)).slice(-32).map(source => structuredClone(source)) : [],
      reason: schema ? "Local schema guidance only; live admission and runtime checks are separate" : "No supported role-granted local read schema; existing values are preserved" };
    prefix = validScope && granted && !!schema;
    if (prefix && tool?.bridge_contract?.output_schema) {
      const output = project(tool.bridge_contract.output_schema);
      upstream.push(...sources(output, { kind: "ref", source: "nodeOutput", nodeId: step.id, path: ["structuredContent"] }, `Node ${step.id}`));
    }
    seen.add(step.id);
    return result;
  });
  const value = { profile: "read-authoring/v1", registryHash, ...(inputSchema ? { inputSchema } : {}), nodes, ...(compiled?.ir.flow && !compiled.issues.length ? { controlFlow: compiled.ir.flow } : {}) };
  if (canonicalJSONBytes(value).length > 1_000_000) return { profile: "read-authoring/v1", registryHash, nodes: [], ...(value.controlFlow ? { controlFlow: value.controlFlow } : {}), reason: "Schema guidance exceeds supported size; values remain preserved" };
  return value;
}
