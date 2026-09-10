export const modelDataClasses = ["public", "internal", "confidential", "restricted"] as const;
export type ModelDataClass = typeof modelDataClasses[number];

export type ModelEgressPolicy = {
  profile: "model-egress-policy/v1";
  approvedOrigin: string;
  runtimeAnalysisDataClasses: ModelDataClass[];
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null;
};

export function providerOrigin(baseURL: string): string {
  let url: URL;
  try { url = new URL(baseURL); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
  if (url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)))
    throw new Error("Provider base URL must use HTTPS, or HTTP only on loopback, without embedded credentials");
  return url.origin;
}

/** Missing legacy policy is deliberately deny-by-default for runtime analysis.
 * Existing chat/generation paths retain their current behavior until their
 * separate purpose policy migration is completed. */
export function normalizeModelEgressPolicy(value: unknown, baseURL: string): ModelEgressPolicy {
  const approvedOrigin = providerOrigin(baseURL);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { profile: "model-egress-policy/v1", approvedOrigin, runtimeAnalysisDataClasses: [], reviewedAt: null, reviewedBy: null };
  const record = value as Record<string, unknown>;
  if (record.profile !== "model-egress-policy/v1" || record.approvedOrigin !== approvedOrigin ||
      !Array.isArray(record.runtimeAnalysisDataClasses) || record.runtimeAnalysisDataClasses.length > modelDataClasses.length ||
      record.runtimeAnalysisDataClasses.some(item => typeof item !== "string" || !modelDataClasses.includes(item as ModelDataClass)) ||
      new Set(record.runtimeAnalysisDataClasses).size !== record.runtimeAnalysisDataClasses.length ||
      !(record.reviewedAt === null || typeof record.reviewedAt === "string" && Number.isFinite(Date.parse(record.reviewedAt))) ||
      !(record.reviewedBy === null || typeof record.reviewedBy === "object" && !Array.isArray(record.reviewedBy) &&
        typeof (record.reviewedBy as Record<string, unknown>).id === "string" && typeof (record.reviewedBy as Record<string, unknown>).name === "string"))
    throw new Error("Provider model-egress policy is malformed or does not match the provider origin");
  const classes = record.runtimeAnalysisDataClasses as ModelDataClass[];
  if (classes.length > 0 && (record.reviewedAt === null || record.reviewedBy === null))
    throw new Error("Runtime analysis egress requires an explicit administrator review");
  return { profile: "model-egress-policy/v1", approvedOrigin, runtimeAnalysisDataClasses: [...classes], reviewedAt: record.reviewedAt as string | null,
    reviewedBy: record.reviewedBy === null ? null : { id: String((record.reviewedBy as Record<string, unknown>).id), name: String((record.reviewedBy as Record<string, unknown>).name) } };
}

export function assertRuntimeAnalysisEgress(policy: ModelEgressPolicy, baseURL: string, dataClass: ModelDataClass): void {
  const current = normalizeModelEgressPolicy(policy, baseURL);
  if (!current.runtimeAnalysisDataClasses.includes(dataClass))
    throw new Error(`Runtime model analysis is not approved for ${dataClass} data at ${current.approvedOrigin}`);
}
