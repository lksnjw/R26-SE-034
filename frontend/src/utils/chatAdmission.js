export function requireChatCapability(capabilities, options) {
  if (capabilities?.profile !== "chat-admission-v1" || capabilities.asyncChat !== true || (options.nodeContext && capabilities.nodeProposals !== true) || (options.requestRevision && capabilities.requestRevisions !== true)) {
    throw new Error("This server does not support saved chat admission for this request. No message was sent. Update the server; your draft is kept.");
  }
}

export function requireChatReceipt(result, target, options, text) {
  const op = result?.operation, message = result?.userMessage;
  const valid = op && typeof op.id === "string" && op.id.length > 0 && op.sessionId === target && result.session?.id === target &&
    ["QUEUED", "RUNNING", "ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(op.status) &&
    message?.id === op.userMessageId && message?.operationId === op.id && message?.role === "user" && message?.text === text;
  const expected = options.nodeContext;
  const scopeMatches = expected ? ["workflowId", "nodeId", "baseVersion", "baseHash"].every(key => op?.nodeContext?.[key] === expected[key]) : !op?.nodeContext;
  const revisionMatches = options.requestRevision ? ["messageId", "sourceHash"].every(key => op?.requestRevision?.[key] === options.requestRevision[key] && message?.requestRevision?.[key] === options.requestRevision[key]) : !op?.requestRevision && !message?.requestRevision;
  if (!valid || !scopeMatches || !revisionMatches) throw new Error("Acknowledgement was not confirmed. Your draft and retry identity are kept. Refresh saved progress or retry the same request; do not assume it completed.");
  return result;
}
