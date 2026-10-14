import { load, JSON_SCHEMA } from "js-yaml";

// This is a draft inspector, not an execution validator or graph compiler.
export function parseWorkflowPreview(source) {
  if (typeof source !== "string" || !source.trim()) return { steps: [], error: "No workflow draft selected." };
  if (source.length > 200000) return { steps: [], error: "This draft is too large to preview. Inspect its source instead." };
  try {
    const document = load(source, { schema: JSON_SCHEMA });
    if (!document || typeof document !== "object" || !Array.isArray(document.steps)) {
      return { steps: [], error: "This draft has no supported steps list. Its source is preserved below." };
    }
    if (document.steps.length > 200) return { steps: [], error: "This draft exceeds the 200-step preview limit." };
    const ids = new Set();
    const steps = document.steps.map((step, index) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error("Each step must be an object.");
      const id = String(step.id ?? `step-${index + 1}`);
      if (ids.has(id)) throw new Error(`Duplicate step ID: ${id}`);
      ids.add(id);
      return { id, label: String(step.name ?? step.id ?? `Step ${index + 1}`), action: String(step.action ?? step.kind ?? "Unspecified action"), source: step };
    });
    return { name: String(document.name ?? "Workflow draft"), steps, description: document.description, trigger: document.trigger, metadata: document.metadata, error: "" };
  } catch (error) {
    return { steps: [], error: `Cannot preview this draft: ${error.message}` };
  }
}

export function workflowArtifacts(messages = []) {
  return messages.flatMap((message, index) => {
    const artifact = message.artifacts;
    const workflowId = artifact?.workflowId ?? artifact?.proposal?.workflowId;
    const hasSource = typeof workflowSource(artifact) === "string" && workflowSource(artifact).trim();
    if (!hasSource && !(typeof workflowId === "string" && workflowId.trim())) return [];
    return [{ key: String(message.id ?? index), artifact: workflowId && artifact?.workflowId !== workflowId ? { ...artifact, workflowId } : artifact }];
  });
}

export function workflowSource(artifact) {
  return artifact?.selected_workflow_yaml || artifact?.yaml;
}
