import { load, JSON_SCHEMA } from "js-yaml";

// Presentation only. The authenticated backend remains the receipt/authority
// verifier; browser cross-checks prevent mixing items or stale source snapshots.
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const address = (nodeId, frames) => [...frames.flatMap(frame => [frame.loopId, String(frame.index)]), nodeId].join("/");
export const iterationPositionLabel = frames => frames === undefined || Array.isArray(frames) && !frames.length ? "Main sequence" :
  Array.isArray(frames) && frames.length <= 8 && frames.every(frame => idPattern.test(frame?.loopId) && Number.isInteger(frame.index) && frame.index >= 0 && frame.index < 100)
    ? frames.map(frame => `${frame.loopId} · item ${frame.index + 1}`).join(" / ") : "Item position unconfirmed";
const failedModel = execution => ({ executionId: execution?.id, valid: false, nodes: {}, error: "Saved item evidence does not match this workflow snapshot. Refresh the run; no item answers are inferred." });
function sourceWitness(value, budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > 32768 || depth > 40) throw new Error("Source display bound");
  if (Array.isArray(value)) return value.map(child => sourceWitness(child, budget, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sourceWitness(value[key], budget, depth + 1)]));
  return value;
}

export function projectExecutionIterationEvidence(execution, timeline) {
  if (!execution?.iterationProgress && execution?.workflowSnapshot?.executionProfile !== "collection-read-v1") return null;
  try {
    const snapshot = execution.workflowSnapshot;
    if (typeof snapshot?.yaml !== "string" || snapshot.yaml.length > 200000) return failedModel(execution);
    const source = load(snapshot.yaml, { schema: JSON_SCHEMA });
    if (source?.metadata?.controlFlow?.schemaVersion !== "read-control-flow/v3") return failedModel(execution);
    return projectIterationEvidence(execution, timeline, { yaml: snapshot.yaml, sourceHash: snapshot.contentHash, flow: source.metadata.controlFlow.root, steps: source.steps });
  } catch { return failedModel(execution); }
}

export function projectIterationEvidence(execution, timeline, { yaml, sourceHash, flow, steps } = {}) {
  if (!execution?.iterationProgress && execution?.workflowSnapshot?.executionProfile !== "collection-read-v1") return null;
  try {
    const snapshot = execution.workflowSnapshot, ledger = execution.iterationProgress, compilation = snapshot?.compilation;
    if (!execution.id || snapshot?.executionProfile !== "collection-read-v1" || snapshot.yaml !== yaml || snapshot.contentHash !== sourceHash ||
        !hashPattern.test(sourceHash) || ledger?.profile !== "read-iterations/v1" || ledger.sourceHash !== sourceHash ||
        !hashPattern.test(ledger.semanticHash) || compilation?.sourceHash !== sourceHash || compilation.semanticHash !== ledger.semanticHash ||
        compilation.schemaVersion !== "workflow-read-ir/v4" || compilation.compilerVersion !== "read-compiler/v4" ||
        execution.readProgress?.profile !== "read-progress-v1" || !Array.isArray(timeline) || timeline.length > 5000 ||
        !Array.isArray(steps) || steps.length > 200 || !ledger.receipts || typeof ledger.receipts !== "object" || Array.isArray(ledger.receipts)) return failedModel(execution);
    const entries = Object.entries(ledger.receipts);
    if (entries.length > 5000) return failedModel(execution);
    if (typeof yaml !== "string" || yaml.length > 200000) return failedModel(execution);
    const source = load(yaml, { schema: JSON_SCHEMA });
    if (source?.metadata?.controlFlow?.schemaVersion !== "read-control-flow/v3" || !Array.isArray(source.steps) || source.steps.length !== steps.length ||
        source.steps.some((step, index) => step.id !== steps[index]?.id || step.action !== steps[index]?.action) ||
        !same(sourceWitness(source.metadata.controlFlow.root), sourceWitness(flow))) return failedModel(execution);
    const declarations = new Map(steps.map((step, index) => [step.id, index])), nodes = new Map(), ownerLoops = new Map();
    let visits = 0;
    const scan = (block, owners = [], depth = 0) => {
      if (depth > 8 || block?.kind !== "sequence" || !Array.isArray(block.nodes)) throw new Error("Invalid source scope");
      for (const node of block.nodes) {
        if (++visits > 300) throw new Error("Source view limit");
        const id = node.kind === "action" ? node.nodeId : node.id;
        if (!idPattern.test(id) || nodes.has(id)) throw new Error("Invalid source node");
        if (node.kind === "action" && !declarations.has(id) || node.kind !== "action" && declarations.has(id)) throw new Error("Invalid source correspondence");
        nodes.set(id, { id, kind: node.kind, owners, rows: [] });
        if (node.kind === "foreach") {
          if (!Number.isInteger(node.maxItems) || node.maxItems < 1 || node.maxItems > 100) throw new Error("Invalid source count");
          ownerLoops.set(id, node.maxItems); scan(node.body, [...owners, id], depth + 1);
        } else if (node.kind === "if") { scan(node.then, owners, depth + 1); scan(node.else, owners, depth + 1); }
        else if (!["action", "return"].includes(node.kind)) throw new Error("Unsupported source node");
      }
    };
    scan(flow); if (!ownerLoops.size || declarations.size !== steps.length || steps.some(step => nodes.get(step.id)?.kind !== "action")) return failedModel(execution);
    const timelines = new Map();
    for (const [index, entry] of timeline.entries()) if (entry.boundaryKey) {
      if (timelines.has(entry.boundaryKey)) return failedModel(execution);
      timelines.set(entry.boundaryKey, { ...entry, order: index });
    }
    const receipts = new Map(entries), actions = new Set(), values = new Set();
    for (const [key, receipt] of entries) {
      const node = nodes.get(receipt?.nodeId), frames = receipt?.iterations;
      if (!node || !["PREPARING", "DISPATCH_INTENT", "STARTED", "DONE", "FAILED", "UNKNOWN", "CANCELLED", "SKIPPED", "INTERRUPTED"].includes(receipt.status) || !Array.isArray(frames) || frames.length > 8 || !frames.every(frame => idPattern.test(frame?.loopId) && Number.isInteger(frame.index) && frame.index >= 0 && frame.index < (ownerLoops.get(frame.loopId) ?? 0)) ||
          receipt.invocationId !== address(receipt.nodeId, frames) || key !== `${receipt.kind}:${receipt.invocationId}` || !Number.isInteger(receipt.sourceIndex) || receipt.sourceIndex < 0 || receipt.sourceIndex > steps.length) return failedModel(execution);
      const expectedOwners = receipt.kind === "collection-item" ? [...node.owners, node.id] : node.owners;
      const declarationSkip = receipt.kind === "action" && receipt.status === "SKIPPED" && ["empty-collection", "return"].includes(receipt.reason?.kind);
      if (frames.length > expectedOwners.length || !declarationSkip && frames.length !== expectedOwners.length || frames.some((frame, index) => frame.loopId !== expectedOwners[index])) return failedModel(execution);
      const kindMatches = node.kind === "action" ? receipt.kind === "action" : node.kind === "foreach" ? ["collection", "collection-item"].includes(receipt.kind) : node.kind === "if" ? ["condition", "merge"].includes(receipt.kind) : receipt.kind === "return";
      if (!kindMatches || receipt.kind === "action" && declarations.get(node.id) !== receipt.sourceIndex) return failedModel(execution);
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index], ownerAddress = address(frame.loopId, frames.slice(0, index)), collection = receipts.get(`collection:${ownerAddress}`);
        if (!collection || !["STARTED", "DONE"].includes(collection.status) || !Number.isInteger(collection.count) || frame.index >= collection.count) return failedModel(execution);
      }
      const entry = timelines.get(key), identity = entry && entry.nodeId === node.id && entry.invocationId === receipt.invocationId && same(entry.iterations, frames);
      const row = { nodeId: node.id, invocationId: receipt.invocationId, iterations: frames, kind: receipt.kind, status: receipt.status, order: entry?.order ?? Number.MAX_SAFE_INTEGER, confirmed: false };
      if (receipt.kind === "action") {
        actions.add(receipt.invocationId);
        const attempt = execution.readProgress.attempts?.[receipt.invocationId];
        const recovered = ledger.interruptedAt && execution.status === "RECOVERY_REQUIRED" && (receipt.status === "PREPARING" && attempt?.status === "FAILED" || receipt.status === "DISPATCH_INTENT" && attempt?.status === "UNKNOWN");
        const status = recovered ? attempt.status : receipt.status;
        const expectedTimelineStatus = ["PREPARING", "DISPATCH_INTENT"].includes(status) ? "RUNNING" : status;
        row.confirmed = Boolean(identity && attempt && attempt.id === receipt.attemptId && entry.attemptId === attempt.id && attempt.nodeId === node.id && attempt.invocationId === receipt.invocationId && attempt.stepIndex === receipt.sourceIndex && same(attempt.iterations, frames) && (recovered || attempt.status === receipt.status) && entry.status === expectedTimelineStatus);
        row.status = status;
        if (row.confirmed && status === "DONE") {
          const output = execution.stepOutputs?.[receipt.invocationId];
          row.confirmed = output !== undefined && output?.isError !== true && same(output, entry.output);
          if (row.confirmed) row.output = output;
        } else if (row.confirmed && Object.hasOwn(execution.stepOutputs ?? {}, receipt.invocationId)) row.confirmed = false;
        if (row.confirmed && status === "FAILED" && entry.output?.isError === true) row.failureOutput = entry.output;
        if (row.confirmed && status === "SKIPPED") row.reason = receipt.reason;
        row.notDispatched = row.confirmed && entry.outcome === "NOT_DISPATCHED";
      } else {
        values.add(receipt.invocationId);
        row.confirmed = Boolean(identity && entry.status === (receipt.status === "STARTED" ? "RUNNING" : receipt.status));
        if (receipt.kind === "condition") {
          row.confirmed = row.confirmed && (receipt.status === "FAILED" || ["then", "else"].includes(receipt.selected) && entry.selectedBranch === receipt.selected);
          if (row.confirmed && receipt.status === "DONE") row.selected = receipt.selected;
        } else if (row.confirmed && receipt.status === "DONE") {
          const output = execution.valueOutputs?.[receipt.invocationId]; row.confirmed = Boolean(output && Object.hasOwn(output, "value") && same(output, entry.output));
          if (row.confirmed) row.output = output.value;
        }
        if (receipt.kind === "collection") {
          if (receipt.status === "FAILED") row.confirmed = row.confirmed && !Object.hasOwn(execution.valueOutputs ?? {}, receipt.invocationId);
          else { row.count = receipt.count; row.confirmed = row.confirmed && Number.isInteger(row.count) && row.count >= 0 && row.count <= ownerLoops.get(node.id) && entry.count === row.count; }
        }
      }
      if (!row.confirmed) { row.status = "UNCONFIRMED"; delete row.output; delete row.failureOutput; }
      node.rows.push(row);
    }
    if (Object.keys(execution.readProgress.attempts ?? {}).some(key => !actions.has(key)) || Object.keys(execution.stepOutputs ?? {}).some(key => !actions.has(key)) || Object.keys(execution.valueOutputs ?? {}).some(key => !values.has(key))) return failedModel(execution);
    const allRows = [...nodes.values()].flatMap(node => node.rows);
    const invalidate = row => { row.status = "UNCONFIRMED"; row.confirmed = false; delete row.output; };
    // A mismatched child cannot be concealed by an otherwise matching typed
    // item/aggregate. Keep earlier good items, but do not expose their broken
    // enclosing result or a following return as a confirmed complete report.
    for (const node of [...nodes.values()].sort((a, b) => b.owners.length - a.owners.length)) {
      node.rows.sort((a, b) => a.order - b.order);
      for (const row of node.rows.filter(row => row.kind === "collection-item" && row.confirmed && row.status === "DONE")) {
        const descendants = allRows.filter(child => child !== row && child.iterations.length >= row.iterations.length && same(child.iterations.slice(0, row.iterations.length), row.iterations));
        if (descendants.some(child => !child.confirmed || !["DONE", "SKIPPED"].includes(child.status))) invalidate(row);
      }
      for (const row of node.rows.filter(row => row.kind === "collection" && row.confirmed)) {
        const items = node.rows.filter(item => item.kind === "collection-item" && item.iterations.length === row.iterations.length + 1 && same(item.iterations.slice(0, -1), row.iterations));
        row.completedItems = items.filter(item => item.confirmed && item.status === "DONE").length;
        if (row.status === "DONE") {
          const ordered = [...items].sort((a, b) => a.iterations.at(-1).index - b.iterations.at(-1).index);
          if (ordered.length !== row.count || ordered.some((item, index) => !item.confirmed || item.status !== "DONE" || item.iterations.at(-1).index !== index) || !same(row.output, ordered.map(item => item.output))) {
            invalidate(row);
          }
        }
      }
    }
    for (const row of allRows.filter(row => row.kind === "return" && row.confirmed && row.status === "DONE"))
      if (allRows.some(prior => prior.order < row.order && (!prior.confirmed || !["DONE", "SKIPPED"].includes(prior.status)))) invalidate(row);
    const confirmedFinal = [...nodes.values()].flatMap(node => node.rows).filter(row => row.confirmed && row.status === "DONE" && ["action", "return"].includes(row.kind)).sort((a, b) => a.order - b.order).at(-1);
    const hasFinal = Boolean(confirmedFinal && Object.hasOwn(execution, "finalOutput") && same(execution.finalOutput, confirmedFinal.output));
    return { executionId: execution.id, valid: true, nodes: Object.fromEntries([...nodes].map(([id, node]) => [id, node])), error: "", hasFinal,
      finalKind: hasFinal ? confirmedFinal.kind : undefined, ...(hasFinal ? { finalOutput: execution.finalOutput } : {}) };
  } catch { return failedModel(execution); }
}
