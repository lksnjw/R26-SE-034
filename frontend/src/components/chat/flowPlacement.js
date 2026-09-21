// A bounded authoring projection only. Edges, drag payloads and these labels
// never authorize execution; the server rechecks the saved source and scope.
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const nodeID = node => node.kind === "action" ? node.nodeId : node.id;
const invalid = () => ({ valid: false, nodes: new Map(), placements: [], error: "Canvas placement is unavailable until the saved structure is confirmed. Existing source is preserved." });

export function flowPlacementModel(flow, steps, hasStructuralSource = false) {
  if (!Array.isArray(steps) || steps.length > 200 || !flow && hasStructuralSource) return invalid();
  const definitions = new Map(steps.map(step => [step.id, step]));
  if (definitions.size !== steps.length || steps.some(step => typeof step.id !== "string" || !idPattern.test(step.id) || step.source && step.source.id !== step.id)) return invalid();
  const root = flow || { kind: "sequence", nodes: steps.map(step => ({ kind: "action", nodeId: step.id })) };
  const nodes = new Map(), placements = [], actions = [];
  let controls = 0;
  const visit = (block, scopeKey, label, destination, owners, depth) => {
    if (depth > 8 || block?.kind !== "sequence" || !Array.isArray(block.nodes)) throw new Error("Invalid scope");
    const subtree = [];
    block.nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") throw new Error("Invalid node");
      const id = nodeID(node);
      if (typeof id !== "string" || !idPattern.test(id) || nodes.has(id) || nodes.size >= 300) throw new Error("Invalid identity");
      const entry = { id, kind: node.kind, label: node.kind === "action" ? definitions.get(id)?.source?.description || id : `${node.kind === "if" ? "Condition" : node.kind === "foreach" ? "Collection" : node.kind === "protect" ? "Protected group" : "Return"} ${id}`, scopeKey, scopeLabel: label, index, subtreeIds: [id] };
      nodes.set(id, entry);
      placements.push({ key: `${scopeKey}|${id}`, scopeKey, label: `${label} · before ${entry.label}`, beforeNodeId: id, destination, owners, index });
      if (node.kind === "action") {
        if (!definitions.has(id)) throw new Error("Missing action");
        actions.push(id);
      } else {
        if (++controls > 100 || definitions.has(id)) throw new Error("Invalid structural identity");
        const nextOwners = [...owners, id];
        if (node.kind === "if") {
          const predicate = node.predicate;
          if (!predicate || (predicate.kind === "literal" ? typeof predicate.value !== "boolean" : predicate.kind !== "ref" || !["workflowInput", "nodeOutput"].includes(predicate.source) || predicate.source === "nodeOutput" && typeof predicate.nodeId !== "string" || !Array.isArray(predicate.path) || predicate.path.some(part => typeof part !== "string"))) throw new Error("Invalid condition");
          for (const branch of ["then", "else"]) entry.subtreeIds.push(...visit(node[branch], `${id}:${branch}`, `${label} → ${id} · ${branch === "then" ? "If yes" : "If no"}`, { conditionId: id, branch }, nextOwners, depth + 1));
        } else if (node.kind === "foreach") {
          if (!Number.isInteger(node.maxItems) || node.maxItems < 1 || node.maxItems > 100 || node.items?.schema?.type !== "array" || !node.items.value || !node.collect?.schema || !node.collect.value) throw new Error("Invalid collection");
          entry.subtreeIds.push(...visit(node.body, `${id}:body`, `${label} → ${id} · collection body`, { loopId: id, scope: "body" }, nextOwners, depth + 1));
        } else if (node.kind === "protect") {
          if (node.onError?.code !== "ERP_RESOURCE_NOT_FOUND" || !node.body?.nodes?.length || !node.output?.schema || !node.output.success || !node.output.handled) throw new Error("Invalid protection");
          for (const scope of ["body", "handler"]) entry.subtreeIds.push(...visit(node[scope], `${id}:${scope}`, `${label} → ${id} · protected ${scope}`, { protectedId: id, scope }, nextOwners, depth + 1));
        } else if (node.kind !== "return" || !node.output?.schema || !node.output.value) throw new Error("Unsupported node");
      }
      subtree.push(...entry.subtreeIds);
    });
    placements.push({ key: `${scopeKey}|$end`, scopeKey, label: `${label} · end`, beforeNodeId: null, destination, owners, index: block.nodes.length });
    return subtree;
  };
  try {
    visit(root, "root", "Main sequence", undefined, [], 0);
    if (actions.length !== steps.length || actions.some((id, index) => id !== steps[index].id)) return invalid();
    return { valid: true, nodes, placements, error: "" };
  } catch { return invalid(); }
}

export function canPlaceNode(model, nodeId, placementKey) {
  const entry = model.nodes.get(nodeId), target = model.placements.find(item => item.key === placementKey);
  if (!model.valid || !entry || !target || entry.subtreeIds.includes(target.beforeNodeId) || target.owners.some(id => entry.subtreeIds.includes(id))) return false;
  const nextIndex = target.index - (entry.scopeKey === target.scopeKey && target.index > entry.index ? 1 : 0);
  return entry.scopeKey !== target.scopeKey || nextIndex !== entry.index;
}

// IDs cannot contain '|', so named empty-scope ends cannot collide with an
// action/structural ID. Preserve the existing before-ID and root-end values.
export const insertionPositionValue = target => target.beforeNodeId ?? (target.destination ? target.key : "");

export function insertionPlacementPreview(model, value) {
  const target = model.valid && model.placements.find(item => insertionPositionValue(item) === value);
  if (!target) throw new Error("This insertion position is no longer confirmed. Reload and select it again.");
  return { placement: { beforeNodeId: target.beforeNodeId, ...(target.destination ? { destination: target.destination } : {}) }, location: target.label };
}

export function movePlacementPreview(model, nodeId, placementKey) {
  if (!canPlaceNode(model, nodeId, placementKey)) throw new Error("This position would not move the node or would put it inside its own contents.");
  const entry = model.nodes.get(nodeId), target = model.placements.find(item => item.key === placementKey);
  return {
    command: { type: "moveNode", nodeId, beforeNodeId: target.beforeNodeId, ...(target.destination ? { destination: target.destination } : {}) },
    before: { step: entry.label, location: `${entry.scopeLabel} · position ${entry.index + 1}` },
    after: { step: entry.label, location: target.label, preservedNodes: entry.subtreeIds },
    movedNodeIds: entry.subtreeIds,
  };
}
