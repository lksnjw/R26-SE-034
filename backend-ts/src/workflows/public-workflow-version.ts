import type { StoredRecord } from "../repository/store.js";

/** Explicit version boundary. Full compiled plans and publication seals remain
 * private; existing v1-v8 receipt projections retain their wire format. */
export function publicWorkflowVersion(version: StoredRecord): StoredRecord {
  const { protectedCompilationSecret: _private, ...visible } = version;
  const read = version.compiledRead as { receipt?: unknown } | undefined;
  const operation = version.compiledOperation as { receipt?: unknown } | undefined;
  return structuredClone({ ...visible, ...(read ? { compiledRead: read.receipt } : {}), ...(operation ? { compiledOperation: operation.receipt } : {}) });
}
