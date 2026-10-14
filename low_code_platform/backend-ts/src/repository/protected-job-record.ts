import { z } from "zod";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import type { Execution } from "./store.js";

const id = z.string().min(1).max(256), sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const jobSchema = z.object({ profile: z.literal("protected-operation-job/v1"), actorId: id, roleId: id, admittedRole: id, departmentId: z.string().nullable(),
  permissionsHash: sha, publicationId: id, idempotencyScope: sha, requestFingerprint: sha, createdAt: z.string().datetime(), admissionSeal: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["QUEUED", "CLAIMED", "WAITING", "FINISHED", "RECOVERY_REQUIRED"]),
  lease: z.object({ id, workerId: id, expiresAt: z.number().int().positive() }).strict().optional() }).strict();
export type ProtectedOperationJob = z.infer<typeof jobSchema>;

/** Storage consistency only. Does not authenticate admission, continuation,
 * current actor, reviewer policy, worker claim or any dispatch permission. */
export function assertProtectedJobShape(run: Execution): void {
  if (!Object.hasOwn(run, "protectedJobSecret")) return;
  assertBoundedFiniteJSON(run.protectedJobSecret, 64_000);
  const job = jobSchema.parse(run.protectedJobSecret), snapshot = run.workflowSnapshot, ledger = run.protectedInvocationSecret;
  if (!ledger || !snapshot || snapshot.executionProfile !== "protected-operation-v1" || !snapshot.protectedCompilation || run.operationSecret ||
      job.actorId !== run.startedBy.id || ledger.identity.actorId !== job.actorId || ledger.identity.roleId !== job.roleId || ledger.identity.admittedRole !== job.admittedRole ||
      ledger.identity.operationHash !== snapshot.protectedCompilation.semanticHash || ledger.identity.machineHash !== snapshot.protectedCompilation.machineHash ||
      snapshot.protectedCompilation.versionId !== job.publicationId || snapshot.protectedCompilation.workflowId !== run.workflowId ||
      snapshot.protectedCompilation.version !== snapshot.version || snapshot.protectedCompilation.sourceHash !== snapshot.contentHash ||
      snapshot.protectedCompilation.registryHash !== snapshot.registryHash || job.createdAt !== run.startedAt ||
      job.state === "QUEUED" && run.status !== "PENDING" || job.state === "CLAIMED" && run.status !== "RUNNING" ||
      job.state === "WAITING" && (!["AWAITING_APPROVAL", "BLOCKED"].includes(run.status) || run.completedAt !== null) ||
      job.state === "FINISHED" && !["DONE", "FAILED", "CANCELLED"].includes(run.status) || job.state === "RECOVERY_REQUIRED" && run.status !== "RECOVERY_REQUIRED" ||
      job.state === "CLAIMED" && !job.lease || job.state !== "CLAIMED" && job.lease)
    throw new Error("Protected job differs from immutable execution/publication ownership");
  if (job.state === "WAITING") {
    const records = run.protectedApprovalSecret, record = records?.activeId && records.records[records.activeId];
    if (!record || record.binding.sequence !== ledger.nextSequence || record.state !== (run.status === "AWAITING_APPROVAL" ? "PENDING" : "APPROVED") ||
        ledger.intents[record.binding.intentKey]?.state !== "PREPARING")
      throw new Error("Protected wait lacks its exact never-entered pending or approved record");
  }
}
