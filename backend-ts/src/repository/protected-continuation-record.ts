import { z } from "zod";

/** Private DATA envelope only. Storage validates identity/shape; only the
 * server codec authenticates its contents against current run evidence.
 * Neither validation nor persistence grants dispatch/recovery authority. */
export const protectedContinuationRecordSchema = z.object({
  profile: z.literal("protected-continuation/v1"),
  executionId: z.string().min(1).max(256),
  ciphertext: z.string().min(1).max(5_400_000),
}).strict();
export type ProtectedContinuation = z.infer<typeof protectedContinuationRecordSchema>;

export function assertProtectedContinuation(value: unknown, executionId: string): asserts value is ProtectedContinuation {
  const parsed = protectedContinuationRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.executionId !== executionId)
    throw new Error("Invalid private protected continuation identity or bounds");
  const bytes = Buffer.from(parsed.data.ciphertext, "base64");
  if (bytes.length < 40 || bytes.toString("base64") !== parsed.data.ciphertext)
    throw new Error("Invalid private protected continuation ciphertext envelope");
}
