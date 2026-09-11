export type LatencySummary = Readonly<{
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}>;

export type LatencyBudgetResult = Readonly<{
  name: string;
  budgetP95Ms: number;
  passed: boolean;
  summary: LatencySummary;
}>;

/** Nearest-rank percentile over non-negative finite millisecond samples. */
export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0 || samples.some(value => !Number.isFinite(value) || value < 0))
    throw new Error("latency samples must contain finite non-negative values");
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (ratio: number) => sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)]!;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return Object.freeze({
    samples: sorted.length,
    minMs: round(sorted[0]!),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    p99Ms: round(percentile(0.99)),
    maxMs: round(sorted.at(-1)!),
    meanMs: round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
  });
}

export function evaluateLatencyBudget(name: string, budgetP95Ms: number, samples: readonly number[]): LatencyBudgetResult {
  if (name.trim() === "" || !Number.isFinite(budgetP95Ms) || budgetP95Ms <= 0)
    throw new Error("latency budget requires a name and positive p95 threshold");
  const summary = summarizeLatency(samples);
  return Object.freeze({ name, budgetP95Ms, passed: summary.p95Ms <= budgetP95Ms, summary });
}
