export function stringifyWorkflow(workflow) {
  return Object.entries(workflow)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

export function validateYamlText(text) {
  return {
    valid: Boolean(text?.trim()),
    errors: text?.trim() ? [] : ["YAML content is required."],
  };
}
