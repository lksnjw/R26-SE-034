import { expect, test, vi } from "vitest";
// @ts-expect-error JavaScript operator fixture, not production code.
import { concurrencyReportName, observeHeldMutation } from "../scripts/native-functions-concurrency-qa.mjs";

test("native concurrency report labels preserve earlier evidence and refuse paths", () => {
  expect(concurrencyReportName()).toBe("native-held-model-concurrency.json");
  expect(concurrencyReportName("t29-1")).toBe("native-held-model-concurrency-t29-1.json");
  for (const label of ["", "../owner", "a/b", "a\\b", "A", "a".repeat(33), null, 123]) expect(() => concurrencyReportName(label)).toThrow();
});

test("held save gate waits for actual mutation and separate readback before measuring", async () => {
  const order: string[] = [], barrier = { observation: () => ({ released: false }) };
  const result = await observeHeldMutation(barrier, async () => { order.push("save"); return { status: 200 }; }, async () => { order.push("fresh readback"); return true; });
  expect(order).toEqual(["save", "fresh readback"]);
  expect(result).toMatchObject({ savedWhileHeld: true, readWhileHeld: true, visible: true, result: { status: 200 } });
});

test("a save or readback after model release is not accepted as causal concurrency", async () => {
  let released = false; const barrier = { observation: () => ({ released }) };
  const result = await observeHeldMutation(barrier, async () => { released = true; return {}; }, async () => true);
  expect(result.savedWhileHeld).toBe(false); expect(result.readWhileHeld).toBe(false);
  const save = vi.fn(); await expect(observeHeldMutation(barrier, save, async () => true)).rejects.toThrow(); expect(save).not.toHaveBeenCalled();
});
