import type { ReadBinding, ReadReference } from "./compiled-read.js";
import { validateToolInput } from "../tools/tool-input-schema.js";

export function schemaAt(schema: Record<string, unknown> | undefined, path: string[]): Record<string, unknown> | undefined {
  let current = schema;
  for (const part of path) {
    if (current?.type === "array" && /^(0|[1-9][0-9]*)$/.test(part)) current = current.items as Record<string, unknown> | undefined;
    else current = (current?.properties as Record<string, Record<string, unknown>> | undefined)?.[part];
  }
  return current;
}
export function checkBinding(binding: ReadBinding, schema: Record<string, unknown> | undefined, label: string, issues: string[], referenceSchema: (ref: ReadReference) => Record<string, unknown> | undefined) {
  if (!schema) return;
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
  return true;
}
