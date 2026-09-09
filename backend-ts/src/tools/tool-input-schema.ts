import { validateSchema, validateValue } from "../structured-output/validate.js";

// Explicit, bounded phase-0 JSON Schema profile. Unknown constraints block
// dispatch rather than silently passing through a partial validator.
const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "maxItems", "$schema", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
export function validateToolSchemaProfile(schema: unknown): string[] {
  let nodes = 0;
  const errors: string[] = [];
  function inspect(input: unknown, depth: number): void {
    if (++nodes > 512 || depth > 16) { errors.push("Tool schema exceeds supported limits"); return; }
    if (input === null || typeof input !== "object" || Array.isArray(input)) { errors.push("Unsupported tool schema"); return; }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowed.has(key))) errors.push("Tool schema contains unsupported constraints");
    if (("properties" in record || "required" in record || "additionalProperties" in record) && record.type !== "object") errors.push("Object constraints require object type");
    if ("items" in record && record.type !== "array") errors.push("Items require array type");
    if ("maxItems" in record && (record.type !== "array" || !Number.isInteger(record.maxItems) || Number(record.maxItems) < 0 || Number(record.maxItems) > 100_000)) errors.push("maxItems requires an array and an integer from 0 to 100000");
    if ("additionalProperties" in record && typeof record.additionalProperties !== "boolean") errors.push("Schema-valued additionalProperties is not supported");
    if (record.properties !== null && typeof record.properties === "object" && !Array.isArray(record.properties)) {
      const children = Object.values(record.properties);
      if (children.length > 128) { errors.push("Too many tool schema properties"); return; }
      for (const child of children) inspect(child, depth + 1);
    }
    if ("items" in record) inspect(record.items, depth + 1);
  }
  inspect(schema, 0);
  return errors.length ? errors : validateSchema(schema);
}

export function validateToolInput(schema: unknown, value: unknown): string[] {
  const errors = validateToolSchemaProfile(schema);
  let nodes = 0;
  function inspectValue(item: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 16) { errors.push("Tool arguments exceed supported limits"); return; }
    if (item === null || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) errors.push("Tool arguments contain reserved keys");
      inspectValue(child, depth + 1);
      if (nodes > 4096) break;
    }
  }
  inspectValue(value, 0);
  return errors.length ? errors : validateValue(schema, value);
}
