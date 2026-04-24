export function workflowToNodes(workflow) {
  return (workflow?.steps ?? []).map((step, index) => ({
    id: step.id ?? `step-${index}`,
    label: step.label ?? step.id,
    x: index * 220,
    y: 80,
  }));
}

export function nodesToWorkflow(nodes) {
  return { steps: nodes.map((node) => ({ id: node.id, label: node.label })) };
}
