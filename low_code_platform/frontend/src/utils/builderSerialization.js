import { load, dump, JSON_SCHEMA } from "js-yaml";

export function readCanvasBlueprint(yaml) {
  if (typeof yaml !== "string" || yaml.length > 200000) throw new Error("Workflow source exceeds preview limits.");
  const document = load(yaml, { schema: JSON_SCHEMA });
  if (!document || typeof document !== "object" || !Array.isArray(document.steps) || document.steps.length > 200) throw new Error("Workflow must contain a supported steps list.");
  const ids = new Set();
  for (const step of document.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step) || typeof step.id !== "string" || ids.has(step.id)) throw new Error("Workflow nodes require unique string IDs.");
    ids.add(step.id);
  }
  return document;
}

export function serializeSourceOrderCanvas(workflow, nodes, edges) {
  if (!nodes.length || nodes.length > 200 || new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("Add 1–200 uniquely identified nodes.");
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, []])), outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) throw new Error("Invalid canvas connection.");
    incoming.get(edge.target).push(edge.source); outgoing.get(edge.source).push(edge.target);
  }
  if ([...incoming.values(), ...outgoing.values()].some((links) => links.length > 1)) throw new Error("Branched connections are not supported by this source-order builder. Use the preserved workflow source; branches must not be flattened.");
  const roots = nodes.filter((node) => !incoming.get(node.id).length);
  if (roots.length !== 1 || edges.length !== nodes.length - 1) throw new Error("Connect nodes as one source-order sequence. Disconnected nodes and cycles cannot be published.");
  const ordered = [], visited = new Set(); let current = roots[0];
  while (current) {
    if (visited.has(current.id)) throw new Error("Cycles are not supported by this builder.");
    ordered.push(current); visited.add(current.id); current = nodeById.get(outgoing.get(current.id)[0]);
  }
  if (ordered.length !== nodes.length) throw new Error("Every node must belong to the source-order sequence.");
  const original = workflow.yaml ? readCanvasBlueprint(workflow.yaml) : { name: workflow.name, description: workflow.description, trigger: { type: "manual" }, steps: [] };
  const originals = new Map(original.steps.map((step) => [step.id, step]));
  const steps = ordered.map((node) => semanticStep(node, originals));
  return dump({ ...original, steps }, { noRefs: true, lineWidth: 100 });
}

export function sourceOrderCanvasValidationPayload(workflow, nodes, edges) {
  const original = workflow.yaml ? readCanvasBlueprint(workflow.yaml) : { name: workflow.name, description: workflow.description, trigger: { type: "manual" }, steps: [] };
  const originals = new Map(original.steps.map((step) => [step.id, step]));
  return {
    profile: "source-order-canvas/v1",
    name: workflow.name || original.name || "Untitled workflow",
    ...(workflow.description || original.description ? { description: workflow.description || original.description } : {}),
    trigger: original.trigger ?? { type: "manual" },
    ...(original.metadata === undefined ? {} : { metadata: original.metadata }),
    nodes: nodes.map((node) => semanticStep(node, originals)),
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target })),
  };
}

function semanticStep(node, originals) {
  const source = originals.get(node.id) ?? node.data.source ?? {};
  const next = { ...source, id: node.id };
  if (!source.kind || source.kind === "tool") { next.action = node.data.action; next.parameters = node.data.parameters ?? {}; }
  if (node.data.description || source.description !== undefined) next.description = node.data.description ?? source.description;
  return next;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
export function sameWorkflowSource(a, b) {
  return JSON.stringify(stable(readCanvasBlueprint(a))) === JSON.stringify(stable(readCanvasBlueprint(b)));
}
