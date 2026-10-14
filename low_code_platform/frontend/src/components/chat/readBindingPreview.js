const types = { string: "Text", number: "Number", integer: "Whole number", boolean: "Yes / No", null: "Explicit null", object: "Fields", array: "List" };
export function contract(schema) {
  if (!schema || typeof schema !== "object") return "Contract unavailable";
  // Keep every declared constraint visible; translating type names must not
  // hide an enum, bound, required field or other part of a proposed contract.
  return { ...schema, type: types[schema.type] || schema.type };
}
function reference(value, owner) {
  const path = Array.isArray(value.path) ? value.path : [];
  const ownItem = value.source === "nodeOutput" && value.nodeId === owner && ["item", "index"].includes(path[0]);
  const root = value.source === "workflowInput" ? "Workflow input" : ownItem ? path[0] === "index" ? "Current item index" : "Current item" : `Node ${value.nodeId}`;
  return [root, ...(ownItem ? path.slice(1) : path)].join(" → ");
}
export function mapping(value, owner, budget, depth = 0) {
  if (--budget.remaining < 0 || depth > 8) return "Nested mapping preserved outside this preview";
  if (!value || typeof value !== "object") return "Mapping unavailable";
  if (value.kind === "literal") return value.value === null ? "Explicit null" : value.value;
  if (value.kind === "ref") return reference(value, owner);
  const child = value => mapping(value, owner, budget, depth + 1);
  if (value.kind === "array" && Array.isArray(value.items)) return value.items.length > 25
    ? { "First 25 items": value.items.slice(0, 25).map(child), "Total mapped items": value.items.length, "Preview only": "Remaining mappings are preserved, not removed" }
    : value.items.map(child);
  if (value.kind === "object" && value.fields && typeof value.fields === "object") {
    const entries = Object.entries(value.fields);
    return { ...Object.fromEntries(entries.slice(0, 25).map(([key, value]) => [key, child(value)])), ...(entries.length > 25 ? { "Preview only": `${entries.length - 25} further mappings are preserved` } : {}) };
  }
  if (value.kind === "template" && Array.isArray(value.parts)) return { "Join these parts in order": value.parts.slice(0, 25).map(part => typeof part === "string" ? part : child(part)), ...(value.parts.length > 25 ? { "Preview only": "Further text parts are preserved" } : {}) };
  return "Mapping cannot be displayed. Reload and review before applying";
}
