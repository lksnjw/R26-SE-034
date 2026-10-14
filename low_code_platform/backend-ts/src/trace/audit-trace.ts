export type TraceAuditMetadata = {
  traceId?: string | undefined;
  sessionId?: string | undefined;
  messageId?: string | undefined;
  candidateId?: string | undefined;
  workflowId?: string | undefined;
  executionId?: string | undefined;
  actor?: { id: string; role: string } | undefined;
};

/*******************************************************************************
 * Function: definedMetadata
 *
 * Removes undefined fields from trace audit metadata.
 ******************************************************************************/
export function definedTraceAuditMetadata(metadata: TraceAuditMetadata): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}
