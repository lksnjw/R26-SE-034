import { expect, test } from "vitest";
import { evaluateLatencyBudget, summarizeLatency } from "../src/performance/latency-report.js";

test("latency summaries use nearest-rank percentiles without hiding the tail", () => {
  const summary = summarizeLatency(Array.from({ length: 100 }, (_, index) => index + 1));
  expect(summary).toEqual({ samples: 100, minMs: 1, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100, meanMs: 50.5 });
});

test("latency budgets fail exactly when measured p95 exceeds the declared threshold", () => {
  expect(evaluateLatencyBudget("draft_save", 95, Array.from({ length: 100 }, (_, index) => index + 1)).passed).toBe(true);
  expect(evaluateLatencyBudget("draft_save", 94.999, Array.from({ length: 100 }, (_, index) => index + 1)).passed).toBe(false);
});

test.each([
  { samples: [] },
  { samples: [1, Number.NaN] },
  { samples: [-1] },
  { samples: [Number.POSITIVE_INFINITY] },
])("invalid latency samples fail closed: $samples", ({ samples }) => {
  expect(() => summarizeLatency(samples)).toThrow(/finite non-negative/);
});
