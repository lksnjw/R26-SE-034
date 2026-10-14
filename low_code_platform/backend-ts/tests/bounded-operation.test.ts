import { afterEach, expect, test, vi } from "vitest";
import { boundedOperation, OperationDeadlineExceeded } from "../src/core/bounded-operation.js";

afterEach(() => vi.useRealTimers());

test("success and rejection release timers and listeners", async () => {
  vi.useFakeTimers();
  const signal = new AbortController().signal;
  const remove = vi.spyOn(signal, "removeEventListener");
  await expect(boundedOperation(async () => "ok", { timeoutMs: 20, label: "fixture", signal })).resolves.toBe("ok");
  await expect(boundedOperation(async () => { throw new Error("original"); }, { timeoutMs: 20, label: "fixture", signal })).rejects.toThrow("original");
  expect(remove).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});

test.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])("invalid timeout %s never dispatches", async (timeoutMs) => {
  const start = vi.fn(async () => "no");
  await expect(boundedOperation(start, { timeoutMs, label: "fixture" })).rejects.toThrow(/timeout/);
  expect(start).not.toHaveBeenCalled();
});

test("pre-cancelled wait never dispatches or invokes abandonment hook", async () => {
  const controller = new AbortController(); controller.abort();
  const start = vi.fn(async () => "no"), abandon = vi.fn();
  await expect(boundedOperation(start, { timeoutMs: 20, label: "fixture", signal: controller.signal, onAbandon: abandon })).rejects.toMatchObject({ name: "AbortError" });
  expect(start).not.toHaveBeenCalled(); expect(abandon).not.toHaveBeenCalled();
});

test.each([false, true])("deadline observes late rejection=%s without accepting it", async (failed) => {
  vi.useFakeTimers();
  let resolve!: (value: string) => void, reject!: (error: Error) => void;
  const late = vi.fn(), abandon = vi.fn(() => { throw new Error("cleanup cannot mask deadline"); });
  const dependency = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const result = boundedOperation(() => dependency, { timeoutMs: 20, label: "fixture", onAbandon: abandon, onLateSettlement: late });
  const assertion = expect(result).rejects.toBeInstanceOf(OperationDeadlineExceeded);
  await vi.advanceTimersByTimeAsync(20); await assertion;
  expect(abandon).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  if (failed) reject(new Error("late private error")); else resolve("late success");
  await Promise.resolve(); expect(late).toHaveBeenCalledOnce();
});

test("in-flight cancellation is bounded even when dependency ignores signal", async () => {
  vi.useFakeTimers(); const controller = new AbortController(); const abandon = vi.fn();
  const result = boundedOperation(() => new Promise<string>(() => {}), { timeoutMs: 20, label: "fixture", signal: controller.signal, onAbandon: abandon });
  const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort(new Error("private arbitrary reason")); await assertion;
  expect(abandon).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

test("synchronous dependency exception is observed and releases timer", async () => {
  vi.useFakeTimers();
  await expect(boundedOperation(() => { throw new Error("sync"); }, { timeoutMs: 20, label: "fixture" })).rejects.toThrow("sync");
  expect(vi.getTimerCount()).toBe(0);
});
