export type OperationIntent = { id: string; nodeId: string; invocationId: string; operationKey: string; argumentHash: string; approvalId?: string;
  dispatchKind?: "tool" | "analysis" | "agent-model" | "agent-tool";
  state: "DISPATCH_INTENT" | "ACKNOWLEDGED" | "UNKNOWN"; preparedAt: string; completedAt?: string; evidenceMeaning?: "operation-accepted" | "operation-confirmed" | "read-tool-error" | "analysis-structured-output" | "agent-model-turn" | "agent-tool-result" | "agent-structured-output"; reconciliationId?: string; reportResolutionId?: string;
  /** Historical reviewed error evidence, not a grant for handler entry/retry. */
  readBusinessFailure?: import("../tools/read-business-error.js").ReviewedReadBusinessFailure };
export type OperationJournal = { profile: "operation-job/v1"; actorId: string; roleId: string; admittedRole: string;
  state: "QUEUED" | "CLAIMED" | "WAITING" | "FINISHED" | "RECOVERY_REQUIRED"; idempotencyScope: string; requestFingerprint: string;
  createdAt: string; lease?: { id: string; workerId: string; expiresAt: number }; intents: Record<string, OperationIntent>;
  /** Private immutable-selection evidence. Not approval, retry or tool output. */
  protectedScopes?: Record<string, OperationProtectedReceipt>;
  analysisProvider?: { configuration: import("../providers/runtime.js").RuntimeProviderConfiguration; configurationRevision: string };
  agentProvider?: { configuration: import("../providers/runtime.js").RuntimeProviderConfiguration; configurationRevision: string };
  reconciliations?: Record<string, import("./operation-reconciliation.js").OperationReconciliationRecord>;
  readbacks?: Record<string, import("./operation-readback-state.js").OperationReadbackJob>;
  recoveries?: Record<string, import("./operation-recovery-artifacts.js").OperationRecoveryArtifact>;
  reportPageResolutions?: Record<string, import("./report-page-resolution.js").ReportPageResolutionRecord> };

export type OperationProtectedSelection = { code: "ERP_RESOURCE_NOT_FOUND"; failedNodeId: string; failedIndex: number;
  intentKey: string; intentId: string; argumentHash: string; selectedAt: string };
export type OperationProtectedReceipt = { profile: "operation-protected/v1"; startedAt: string; startIndex: number;
  selection?: OperationProtectedSelection;
  completion?: { outcome: "SUCCEEDED" | "HANDLED_ERROR" | "RETURNED" | "FAILED"; index: number; completedAt: string } };
