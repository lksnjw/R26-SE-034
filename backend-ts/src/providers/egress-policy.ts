export const modelDataClasses = ["public", "internal", "confidential", "restricted"] as const;
export type ModelDataClass = typeof modelDataClasses[number];

export type ModelEgressPolicy = {
  profile: "model-egress-policy/v1";
  approvedOrigin: string;
  runtimeAnalysisDataClasses: ModelDataClass[];
  interactiveDataClasses: ModelDataClass[];
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null;
};

export type ModelEgressDeclaration = { purpose: "interactive" | "runtime_analysis"; dataClass: ModelDataClass };

export function providerOrigin(baseURL: string): string {
  let url: URL;
  try { url = new URL(baseURL); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
  if (url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)))
    throw new Error("Provider base URL must use HTTPS, or HTTP only on loopback, without embedded credentials");
  return url.origin;
}

/** Missing or legacy purpose policy is deliberately deny-by-default. A v1
 * record without interactiveDataClasses retains its reviewed runtime classes
 * but grants no interactive authoring/agent traffic. */
export function normalizeModelEgressPolicy(value: unknown, baseURL: string): ModelEgressPolicy {
  const approvedOrigin = providerOrigin(baseURL);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { profile: "model-egress-policy/v1", approvedOrigin, runtimeAnalysisDataClasses: [], interactiveDataClasses: [], reviewedAt: null, reviewedBy: null };
  const record = value as Record<string, unknown>;
  const interactive = record.interactiveDataClasses === undefined ? [] : record.interactiveDataClasses;
  if (record.profile !== "model-egress-policy/v1" || record.approvedOrigin !== approvedOrigin ||
      !Array.isArray(record.runtimeAnalysisDataClasses) || record.runtimeAnalysisDataClasses.length > modelDataClasses.length ||
      record.runtimeAnalysisDataClasses.some(item => typeof item !== "string" || !modelDataClasses.includes(item as ModelDataClass)) ||
      new Set(record.runtimeAnalysisDataClasses).size !== record.runtimeAnalysisDataClasses.length ||
      !Array.isArray(interactive) || interactive.length > modelDataClasses.length ||
      interactive.some(item => typeof item !== "string" || !modelDataClasses.includes(item as ModelDataClass)) ||
      new Set(interactive).size !== interactive.length ||
      !(record.reviewedAt === null || typeof record.reviewedAt === "string" && Number.isFinite(Date.parse(record.reviewedAt))) ||
      !(record.reviewedBy === null || typeof record.reviewedBy === "object" && !Array.isArray(record.reviewedBy) &&
        typeof (record.reviewedBy as Record<string, unknown>).id === "string" && typeof (record.reviewedBy as Record<string, unknown>).name === "string"))
    throw new Error("Provider model-egress policy is malformed or does not match the provider origin");
  const classes = record.runtimeAnalysisDataClasses as ModelDataClass[], interactiveClasses = interactive as ModelDataClass[];
  if (classes.length + interactiveClasses.length > 0 && (record.reviewedAt === null || record.reviewedBy === null))
    throw new Error("Model egress requires an explicit administrator review");
  return { profile: "model-egress-policy/v1", approvedOrigin, runtimeAnalysisDataClasses: [...classes], interactiveDataClasses: [...interactiveClasses], reviewedAt: record.reviewedAt as string | null,
    reviewedBy: record.reviewedBy === null ? null : { id: String((record.reviewedBy as Record<string, unknown>).id), name: String((record.reviewedBy as Record<string, unknown>).name) } };
}

export function assertModelEgress(policy: ModelEgressPolicy, baseURL: string, declaration: ModelEgressDeclaration): void {
  const current = normalizeModelEgressPolicy(policy, baseURL);
  const allowed = declaration.purpose === "runtime_analysis" ? current.runtimeAnalysisDataClasses : current.interactiveDataClasses;
  if (!allowed.includes(declaration.dataClass))
    throw new Error(`${declaration.purpose === "runtime_analysis" ? "Runtime model analysis" : "Interactive model traffic"} is not approved for ${declaration.dataClass} data at ${current.approvedOrigin}`);
}

export function assertRuntimeAnalysisEgress(policy: ModelEgressPolicy, baseURL: string, dataClass: ModelDataClass): void {
  assertModelEgress(policy, baseURL, { purpose: "runtime_analysis", dataClass });
}
