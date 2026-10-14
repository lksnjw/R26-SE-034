/**
 * Keep the task's execution deadline inside both its renewable worker lease and
 * the 300-second Firebase Function timeout. The default 30-second lease keeps
 * its existing 29.9-second behavior; larger catalogs must opt into a larger
 * lease explicitly instead of silently weakening the default failure fence.
 */
export function firebaseReadTaskDeadlineMs(leaseMs: number): number {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 300_000)
    throw new Error("Invalid read worker lease for Firebase task deadline");
  return Math.min(240_000, leaseMs - 100);
}
