const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED = new Set(["input", "__proto__", "constructor", "prototype"]);
const SCHEMA_VERSIONS = new Set(["read-control-flow/v1", "read-control-flow/v2", "read-control-flow/v3"]);

const safeIdentifier = (value) => typeof value === "string" && IDENTIFIER.test(value) && !RESERVED.has(value);

function fail() {
  throw new Error("Explicit workflow structure cannot be represented safely by this canvas.");
}

function requireSequence(value) {
  if (!value || typeof value !== "object" || value.kind !== "sequence" || !Array.isArray(value.nodes) || value.nodes.length > 200) fail();
  return value;
}

function predicateText(predicate) {
  if (predicate?.kind === "literal" && typeof predicate.value === "boolean") return predicate.value ? "Always take Yes" : "Always take No";
  if (predicate?.kind !== "ref" || !Array.isArray(predicate.path) || predicate.path.length > 16 || predicate.path.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || RESERVED.has(part))) fail();
  if (predicate.source === "workflowInput") return `Workflow input · ${predicate.path.join(" · ") || "value"}`;
  if (predicate.source === "nodeOutput" && safeIdentifier(predicate.nodeId)) return `${predicate.nodeId} output · ${predicate.path.join(" · ") || "value"}`;
  fail();
}

function structuralData(node) {
  if (node.kind === "if") return { label: `If · ${node.id}`, action: "Condition", description: `${predicateText(node.predicate)}${node.merge ? " · Declares one typed merged output" : ""}`, iconKey: "ShieldCheck", tone: "amber", nodeTypeLabel: "Decision" };
  if (node.kind === "return") return { label: `Return · ${node.id}`, action: "Typed workflow return", description: "Ends the selected path with an explicit typed value.", iconKey: "FileCheck2", tone: "emerald", nodeTypeLabel: "Return" };
  if (node.kind === "foreach") return { label: `For each · ${node.id}`, action: "Bounded collection", description: `Processes at most ${node.maxItems} items using the declared collection scope.`, iconKey: "Boxes", tone: "violet", nodeTypeLabel: "Collection" };
  fail();
}

function actionData(step) {
  const action = step.action ?? step.kind ?? "Unsupported node";
  return {
    label: step.description?.trim() || action.split(".").pop()?.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase()) || "Workflow step",
    action,
    description: step.description ?? "",
    source: step,
    iconKey: "Database",
    role: "governed action",
    status: "idle",
    tone: "blue",
    parameters: step.parameters ?? {},
    nodeTypeLabel: step.kind === "analysis" ? "Analysis" : step.kind === "agent" ? "Agent" : "ERP tool",
  };
}

/** Projects only an explicit backend-owned control-flow record. Edges are a
 * view of saved semantics; they are never compiled back into execution logic. */
export function projectStructuredControlFlow(workflow, markerEnd) {
  const flow = workflow?.metadata?.controlFlow;
  if (flow === undefined) return null;
  if (!flow || typeof flow !== "object" || !SCHEMA_VERSIONS.has(flow.schemaVersion)) fail();
  const root = requireSequence(flow.root);
  const definitions = new Map(workflow.steps.map((step) => [step.id, step]));
  if (definitions.size !== workflow.steps.length) fail();
  const nodes = [], edges = [], actionOrder = [], ids = new Set();
  let row = 0, edgeIndex = 0, structuralCount = 0;
  const edge = (source, target, label) => {
    edges.push({
      id: `structured-${edgeIndex++}-${source}-${target}`,
      source,
      target,
      ...(label ? { label } : {}),
      type: "smoothstep",
      markerEnd: { type: markerEnd },
      style: { stroke: label === "No" ? "#b45309" : label === "Yes" ? "#047857" : "#475569", strokeWidth: 2 },
      labelStyle: { fill: "#334155", fontSize: 11, fontWeight: 700 },
    });
  };
  const add = (id, data, lane) => {
    if (!safeIdentifier(id) || ids.has(id)) fail();
    ids.add(id);
    nodes.push({ id, type: "erpTool", position: { x: 380 + lane * 320, y: 80 + row++ * 170 }, data: { ...data, role: data.role ?? "control flow", status: "idle", structural: !data.source } });
  };
  const visitSequence = (sequence, lane, depth) => {
    if (depth > 8) fail();
    requireSequence(sequence);
    let entry = null, exits = [];
    for (const control of sequence.nodes) {
      if (!control || typeof control !== "object") fail();
      let unit;
      if (control.kind === "action") {
        const step = definitions.get(control.nodeId);
        if (!step) fail();
        add(control.nodeId, actionData(step), lane);
        actionOrder.push(control.nodeId);
        unit = { entry: control.nodeId, exits: [{ id: control.nodeId }] };
      } else {
        if (++structuralCount > 100) fail();
        add(control.id, structuralData(control), lane);
        if (control.kind === "return") {
          if (flow.schemaVersion === "read-control-flow/v1") fail();
          unit = { entry: control.id, exits: [] };
        }
        else if (control.kind === "if") {
          const yes = visitSequence(control.then, lane - 1, depth + 1), no = visitSequence(control.else, lane + 1, depth + 1);
          if (yes.entry) edge(control.id, yes.entry, "Yes");
          if (no.entry) edge(control.id, no.entry, "No");
          unit = { entry: control.id, exits: [...(yes.entry ? yes.exits : [{ id: control.id, label: "Yes" }]), ...(no.entry ? no.exits : [{ id: control.id, label: "No" }])] };
        } else if (control.kind === "foreach") {
          if (flow.schemaVersion !== "read-control-flow/v3") fail();
          if (!Number.isInteger(control.maxItems) || control.maxItems < 1 || control.maxItems > 100) fail();
          const body = visitSequence(control.body, lane + 1, depth + 1);
          if (body.entry) edge(control.id, body.entry, "Each item");
          unit = { entry: control.id, exits: body.entry ? body.exits.map((item) => ({ ...item, label: "Collection complete" })) : [{ id: control.id }] };
        } else fail();
      }
      if (!entry) entry = unit.entry;
      for (const previous of exits) edge(previous.id, unit.entry, previous.label);
      exits = unit.exits;
    }
    return { entry, exits };
  };
  visitSequence(root, 0, 0);
  if (actionOrder.length !== workflow.steps.length || actionOrder.some((id, index) => id !== workflow.steps[index]?.id) || new Set(actionOrder).size !== actionOrder.length) fail();
  return { profile: "structured-control-flow/v1", nodes, edges };
}
