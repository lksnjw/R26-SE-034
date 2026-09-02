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
    if (next.length > 2000) throw new Error("Run history exceeds this preview's supported size.");
  }
  if (page.cursor !== position || page.hasMore !== (position < page.lastSequence) || (page.hasMore && position === cursor))
    throw new Error("Run history cursor is inconsistent. Refresh to replay saved evidence.");
  return { events: next, cursor: position };
}

const eventNames = {
  "run.queued": "Read job queued",
  "run.started": "Run started", "node.preparing": "Checking node", "node.dispatch_intent": "Read dispatch recorded — answer not yet saved",
  "node.completed": "Node answer saved", "node.failed": "Node stopped", "node.outcome_unknown": "Node outcome unknown",
  "node.interrupted": "Node interrupted before dispatch", "node.cancelled": "Node cancelled before dispatch",
  "run.cancel_requested": "Cancellation requested", "run.completed": "Run finished", "run.recovery_required": "Run requires recovery review",
};
export function executionEventLabel(event) { return eventNames[event.type] ?? "Unrecognized run event"; }
export function isActiveExecution(status) { return status === "RUNNING" || status === "PENDING"; }
