export type OperationIntent = { id: string; nodeId: string; invocationId: string; operationKey: string; argumentHash: string; approvalId?: string;
  state: "DISPATCH_INTENT" | "ACKNOWLEDGED" | "UNKNOWN"; preparedAt: string; completedAt?: string; evidenceMeaning?: "operation-accepted" | "operation-confirmed"; reconciliationId?: string };
export type OperationJournal = { profile: "operation-job/v1"; actorId: string; roleId: string; admittedRole: string;
  state: "QUEUED" | "CLAIMED" | "WAITING" | "FINISHED" | "RECOVERY_REQUIRED"; idempotencyScope: string; requestFingerprint: string;
  createdAt: string; lease?: { id: string; workerId: string; expiresAt: number }; intents: Record<string, OperationIntent>;
  reconciliations?: Record<string, import("./operation-reconciliation.js").OperationReconciliationRecord> };
