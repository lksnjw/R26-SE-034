import { expect, test, vi } from "vitest";
// @ts-expect-error JavaScript operator fixture, not production code.
import { cancellationReportName, completionBarrier } from "../scripts/native-functions-cancellation-qa.mjs";

test("cancellation fixture releases only the original held completion once", async () => {
  const barrier = completionBarrier(1000);
  let settled = false;
  const holding = barrier.hold().then(() => { settled = true; });
  await barrier.started; expect(settled).toBe(false); expect(barrier.observation()).toMatchObject({ entered: true, released: false, expired: false });
  barrier.release(); await holding; const first = barrier.observation(); barrier.release();
  expect(first).toEqual(barrier.observation()); expect(first.expired).toBe(false); await expect(barrier.hold()).rejects.toThrow();
});

test("fixture hold deadline is bounded below the unchanged real provider deadline", async () => {
  vi.useFakeTimers();
  try {
    const barrier = completionBarrier(25_000), holding = barrier.hold();
    await vi.advanceTimersByTimeAsync(24_999); expect(barrier.observation().released).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await holding; expect(barrier.observation()).toMatchObject({ released: true, expired: true });
  } finally { vi.useRealTimers(); }
});

test("fixture refuses unbounded holds and can be safely closed before entry", async () => {
  for (const timeout of [0, 9, 25_001, Infinity, NaN, 12.5]) expect(() => completionBarrier(timeout)).toThrow();
  const barrier = completionBarrier(); barrier.release(); await expect(barrier.hold()).rejects.toThrow();
});

test("native retests use a bounded exclusive new report name instead of overwriting the failed gate", () => {
  expect(cancellationReportName()).toBe("native-held-model-cancellation.json");
  expect(cancellationReportName("control-plane-1")).toBe("native-held-model-cancellation-control-plane-1.json");
  for (const label of ["", "../owner", "a/b", "a\\b", "/absolute", "A", "a".repeat(33), null, 123]) expect(() => cancellationReportName(label)).toThrow();
});
