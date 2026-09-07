// Journal metadata is not business output. Never synthesize answers/status from
// events; authoritative execution/timeline snapshots are fetched separately.
export function reconcileExecutionEvents(events, cursor, page, executionId) {
  if (!page || !Array.isArray(page.events) || page.events.length > 100 ||
      !Number.isSafeInteger(page.cursor) || !Number.isSafeInteger(page.lastSequence) ||
      page.cursor < cursor || page.lastSequence < page.cursor || typeof page.hasMore !== "boolean" ||
      typeof page.status !== "string" || !["read-progress-v1", "legacy-no-journal"].includes(page.profile))
    throw new Error("Run history response is invalid. Refresh to replay saved evidence.");
  if (page.profile === "legacy-no-journal" && (page.events.length || page.cursor || page.lastSequence || page.hasMore))
    throw new Error("Legacy execution has no sequenced journal; evidence cannot be inferred.");
  const next = [...events];
  let position = cursor;
  for (const event of page.events) {
    if (!event || event.version !== 1 || event.executionId !== executionId ||
        !Number.isSafeInteger(event.sequence) || event.sequence <= 0 || event.sequence > page.lastSequence ||
        typeof event.type !== "string" || typeof event.timestamp !== "string")
      throw new Error("Run history contains invalid or unrelated evidence.");
    if (event.sequence <= position) {
      const previous = next.find((item) => item.sequence === event.sequence);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("Run history has conflicting evidence. Refresh to replay it.");
      continue;
    }
    if (event.sequence !== position + 1) throw new Error("Run history has a sequence gap. Refresh to replay saved evidence.");
    next.push(event); position = event.sequence;
    // Keep a bounded display window without freezing long collection runs.
    // The sequence cursor still covers every acknowledged server event.
    if (next.length > 2000) next.splice(0, next.length - 2000);
  }
  if (page.cursor !== position || page.hasMore !== (position < page.lastSequence) || (page.hasMore && position === cursor))
    throw new Error("Run history cursor is inconsistent. Refresh to replay saved evidence.");
  return { events: next, cursor: position };
}

const eventNames = {
  "operation.readback_queued": "ERP status query queued · original action unchanged",
  "operation.readback_started": "Checking reviewed ERP state",
  "operation.readback_dispatch_intent": "Status-query dispatch recorded · no answer yet",
  "operation.readback_answered": "ERP status observation saved · no delivery or resume confirmation",
  "operation.readback_cancel_requested": "Status-query cancellation requested · original action unchanged",
  "operation.readback_cancelled": "Status query cancelled before dispatch",
  "operation.readback_failed": "Status query stopped · no qualified observation",
  "operation.readback_recovery_required": "Status-query answer unconfirmed · no automatic replay",
  "run.queued": "Read job queued",
  "run.started": "Run started", "node.preparing": "Checking node", "node.dispatch_intent": "Read dispatch recorded — answer not yet saved",
  "node.completed": "Node answer saved", "node.failed": "Node stopped", "node.outcome_unknown": "Node outcome unknown",
  "node.interrupted": "Node interrupted before dispatch", "node.cancelled": "Node cancelled before dispatch",
  "node.not_dispatched": "Node stopped before dispatch",
  "run.cancel_requested": "Cancellation requested", "run.completed": "Run finished", "run.recovery_required": "Run requires recovery review",
  "iteration.action.preparing": "Checking item read", "iteration.action.dispatch_intent": "Item dispatch recorded — answer not yet saved",
  "iteration.action.completed": "Item answer saved", "iteration.action.failed": "Item read stopped", "iteration.action.stopped": "Item read stopped before dispatch",
  "iteration.action.outcome_unknown": "Item read outcome unknown", "iteration.skip.skipped": "Item action not evaluated",
  "iteration.condition.done": "Item condition decision saved", "iteration.condition.failed": "Item condition failed",
  "iteration.merge.done": "Selected item branch value saved", "iteration.merge.failed": "Item branch value invalid",
  "iteration.collection.started": "Collection started", "iteration.collection.done": "Collection aggregate saved", "iteration.collection.failed": "Collection stopped",
  "iteration.collection-item.done": "Typed item value saved", "iteration.collection-item.failed": "Typed item value invalid",
  "iteration.return.done": "Workflow return saved", "iteration.return.failed": "Workflow return invalid",
};
export function executionEventLabel(event) {
  if (event.type === "operation.reconciliation_recorded") return event.payload?.outcome === "UNRESOLVED" ? "External evidence saved · outcome still unresolved" : "Operator outcome attestation saved · no resume or replay";
  if (event.type === "run.queued" && event.payload?.profile === "operation-job/v1") return "Operation queued";
  if (event.type === "node.dispatch_intent" && event.payload?.sideEffect === true) return "Operation dispatch recorded — outcome not yet saved";
  if (event.type === "node.completed" && ["operation-accepted", "operation-confirmed"].includes(event.payload?.outcome)) return event.payload.outcome === "operation-accepted" ? "Tool acceptance saved · delivery not independently verified" : "Tool-reported operation confirmation saved";
  const operationEvents = { "approval.requested": "Exact operation approval requested", "approval.granted": "Exact approval recorded", "approval.rejected": "Exact operation rejected", "approval.consumed": "Exact approval bound to dispatch intent", "run.done": "Run finished", "run.failed": "Run stopped", "run.cancelled": "Run cancelled", "run.reconciliation_required": "ERP outcome requires reconciliation" };
  return operationEvents[event.type] ?? eventNames[event.type] ?? "Unrecognized run event";
}
export function isActiveExecution(status) { return ["RUNNING", "PENDING", "AWAITING_APPROVAL"].includes(status); }
