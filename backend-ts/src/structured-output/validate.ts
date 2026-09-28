/*******************************************************************************
 * Function: validateSchema
 *
 * Returns validation errors for the supported schema structure.
 ******************************************************************************/
export function validateSchema(schema: unknown): string[] {
  const errors: string[] = [];
  inspectSchema(schema, "$", errors);
  return errors;
}

/*******************************************************************************
 * Function: validateValue
 *
 * Validates a value against a supported schema.
 ******************************************************************************/
export function validateValue(schema: unknown, value: unknown): string[] {
  const schemaErrors = validateSchema(schema);
  if (schemaErrors.length > 0) return schemaErrors;
  const errors: string[] = [];
  inspectValue(schema as Record<string, unknown>, value, "$", errors);
  return errors;
}

/*******************************************************************************
 * Function: inspectSchema
 *
 * Recursively checks schema declarations and collects errors.
 ******************************************************************************/
function inspectSchema(schema: unknown, path: string, errors: string[]): void {
  if (!isRecord(schema)) { errors.push(`${path}: schema must be an object`); return; }
  const type = scalarType(schema.type);
  if (typeof type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type)) errors.push(`${path}.type: unsupported or missing schema type`);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 128 ||
      schema.enum.some(item => !matchesScalar(schema.type, item) || typeof item === "string" && item.length > 256) ||
      new Set(schema.enum).size !== schema.enum.length)) errors.push(`${path}.enum: must contain 1 to 128 unique bounded scalar values of the declared type`);
  if (type === "object") {
    if (schema.properties !== undefined && !isRecord(schema.properties)) errors.push(`${path}.properties: must be an object`);
    if (isRecord(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) inspectSchema(child, `${path}.properties.${key}`, errors);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))) errors.push(`${path}.required: must be an array of strings`);
  }
  if (type === "array") {
    if (schema.items === undefined) errors.push(`${path}.items: is required for arrays`); else inspectSchema(schema.items, `${path}.items`, errors);
    if (schema.maxItems !== undefined && (!Number.isInteger(schema.maxItems) || Number(schema.maxItems) < 0 || Number(schema.maxItems) > 100_000))
      errors.push(`${path}.maxItems: must be an integer from 0 to 100000`);
  }
}

/*******************************************************************************
 * Function: inspectValue
 *
 * Recursively checks a value against schema constraints and collects errors.
 ******************************************************************************/
function inspectValue(schema: Record<string, unknown>, value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(schema.enum) && !schema.enum.some(item => item === value)) errors.push(`${path}: value is outside the declared enum`);
  if (Array.isArray(schema.type) && value === null) return;
  const type = scalarType(schema.type);
  if (type === "null") { if (value !== null) errors.push(`${path}: expected null`); return; }
  if (type === "string") { if (typeof value !== "string") errors.push(`${path}: expected string`); return; }
  if (type === "boolean") { if (typeof value !== "boolean") errors.push(`${path}: expected boolean`); return; }
  if (type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected number`); return; }
  if (type === "integer") { if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer`); return; }
  if (type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
    if (Number.isInteger(schema.maxItems) && value.length > Number(schema.maxItems)) errors.push(`${path}: exceeds maxItems ${schema.maxItems}`);
    value.forEach((item, index) => inspectValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`, errors));
    return;
  }
  if (type === "object") {
    if (!isRecord(value)) { errors.push(`${path}: expected object`); return; }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: is required`);
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key];
      if (child !== undefined) inspectValue(child as Record<string, unknown>, item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property is not allowed`);
    }
  }
}

/*******************************************************************************
 * Function: isRecord
 *
 * Checks whether a value is a non-null object other than an array.
 ******************************************************************************/
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Narrow nullable scalar profile, rather than general schema union support.
 * Object/array unions still fail before value validation. */
function scalarType(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length !== 2 || new Set(value).size !== 2 || !value.includes("null")) return undefined;
  const scalar = value.find(item => item !== "null");
  return ["string", "number", "integer", "boolean"].includes(scalar) ? scalar : undefined;
}
function matchesScalar(type: unknown, value: unknown): boolean {
  if (Array.isArray(type) && type.includes("null") && scalarType(type) !== undefined && value === null) return true;
  const resolved = scalarType(type);
  return resolved === "null" ? value === null : resolved === "string" ? typeof value === "string" :
    resolved === "boolean" ? typeof value === "boolean" : resolved === "number" ? typeof value === "number" && Number.isFinite(value) :
    resolved === "integer" ? typeof value === "number" && Number.isInteger(value) : false;
}
