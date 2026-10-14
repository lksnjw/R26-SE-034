import { beforeEach, expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { bindExecutionHost } from "../src/runner/execution-host.js";
import { withFunctionResources, withFunctionRuntime } from "../src/firebase/invocation.js";
import { requireOperationTaskAdmission } from "../src/runner/operation-task-outbox.js";
import { requireWorkflowLifecycleAdmission } from "../src/runner/workflow-lifecycle-host.js";
import { FirestoreOwnershipFailure } from "../src/storage/firestore-writer-ownership.js";
const fixtures = vi.hoisted(() => ({ open: vi.fn(), construct: vi.fn(), build: vi.fn() }));
vi.mock("../src/entrypoints/application-runtime.js", () => ({ openApplicationResources: fixtures.open, constructApplicationRuntime: fixtures.construct }));
vi.mock("../src/http/app.js", () => ({ buildApp: fixtures.build }));
beforeEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
async function setup() {
  const events: string[] = [], repository = await Repository.open(null), config = loadConfig({ APP_ENV: "test", MCP_MODE: "mock" });
  const close = vi.fn(async () => { events.push("resources.close"); await repository.close(); });
  const app = { close: vi.fn(async () => { events.push("app.close"); }) }, services = { repository };
  fixtures.open.mockImplementation(async () => { events.push("open"); return { repository, close }; });
  fixtures.construct.mockImplementation(async () => { events.push("construct"); return { services }; });
  fixtures.build.mockImplementation(async () => { events.push("build"); return app; });
  const input = { config, root: process.cwd(), transport: { timeoutMs: 1000, enqueue: vi.fn(async (command: { taskId: string }) => ({ taskId: command.taskId, outcome: "CREATED" as const })) } };
  return { events, repository, close, app, services, input };
}
test("invocation binds a fresh bounded owner, closes app before resources, then returns its result", async () => {
  const f = await setup();
  expect(await withFunctionRuntime(f.input, async context => {
    expect(context.services).toBe(f.services); expect(bindExecutionHost(f.repository)).toBe("bounded-invocation"); f.events.push("work"); return "saved";
  })).toBe("saved");
  expect(f.events).toEqual(["open", "construct", "build", "work", "app.close", "resources.close"]);
  expect(fixtures.open).toHaveBeenCalledWith(expect.objectContaining({ registryPreparation: "existing-only" }));
  expect(fixtures.build).toHaveBeenCalledWith(f.services, { executionHost: "bounded-invocation" });
});
test.each(["work", "app.close", "construct", "build"])("%s failure still disposes the owned resources", async stage => {
  const f = await setup();
  if (stage === "construct") fixtures.construct.mockRejectedValueOnce(new Error(stage));
  if (stage === "build") fixtures.build.mockRejectedValueOnce(new Error(stage));
  if (stage === "app.close") f.app.close.mockRejectedValueOnce(new Error(stage));
  await expect(withFunctionRuntime(f.input, async () => { if (stage === "work") throw new Error(stage); return true; })).rejects.toThrow(stage);
  expect(f.close).toHaveBeenCalledOnce();
});
test("outbox-only invocation never constructs MCP/providers/HTTP or business workers", async () => {
  const f = await setup(); expect(await withFunctionResources(f.input, async () => "reconciled")).toBe("reconciled");
  expect(f.events).toEqual(["open", "resources.close"]); expect(fixtures.construct).not.toHaveBeenCalled(); expect(fixtures.build).not.toHaveBeenCalled();
});

test("operation admission is available only when the owned invocation installs its exact transport", async () => {
  const f = await setup();
  await withFunctionResources(f.input, async () => { expect(() => requireOperationTaskAdmission(f.repository)).toThrow(); });
  const g = await setup();
  await withFunctionResources({ ...g.input, operationTransport: g.input.transport }, async () => { expect(() => requireOperationTaskAdmission(g.repository)).not.toThrow(); });
  expect(g.events).toEqual(["open", "resources.close"]); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("business lifecycle requires both its trusted composition profile and an operation transport", async () => {
  const a = await setup();
  await withFunctionResources({ ...a.input, operationTransport: a.input.transport }, async () => {
    expect(() => requireWorkflowLifecycleAdmission(a.repository)).toThrow();
  });
  const b = await setup();
  await withFunctionResources({ ...b.input, operationTransport: b.input.transport, workflowLifecycle: "workflow-lifecycle/v1" }, async () => {
    expect(() => requireWorkflowLifecycleAdmission(b.repository)).not.toThrow();
  });
  const c = await setup();
  await expect(withFunctionResources({ ...c.input, workflowLifecycle: "workflow-lifecycle/v1" }, async () => "never")).rejects.toThrow();
  expect(c.close).toHaveBeenCalledOnce(); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("an unsupported lifecycle profile cannot construct runtime services or leave its writer open", async () => {
  const f = await setup(), input = { ...f.input, operationTransport: f.input.transport, workflowLifecycle: "model-proposed-profile" };
  await expect(withFunctionRuntime(input as unknown as Parameters<typeof withFunctionRuntime>[0], async () => "never")).rejects.toThrow("Unsupported workflow lifecycle composition");
  expect(f.close).toHaveBeenCalledOnce(); expect(fixtures.construct).not.toHaveBeenCalled(); expect(fixtures.build).not.toHaveBeenCalled();
});
test("invocation cannot return success before pending cleanup finishes", async () => {
  const f = await setup(); let finish!: () => void, settled = false;
  f.app.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const result = withFunctionRuntime(f.input, async () => "done").then(value => { settled = true; return value; });
  await vi.waitFor(() => expect(f.app.close).toHaveBeenCalledOnce()); expect(settled).toBe(false); expect(f.close).not.toHaveBeenCalled();
  finish(); expect(await result).toBe("done"); expect(f.close).toHaveBeenCalledOnce();
});

test.each(["WRITER_HELD", "WRITER_HANDOFF"] as const)("short confirmed %s retries only opening, then runs and closes once", async reason => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  fixtures.open.mockRejectedValueOnce(new Error("Busy", { cause: new FirestoreOwnershipFailure(reason) }));
  const work = vi.fn(async () => "saved");
  expect(await withFunctionResources(f.input, work)).toBe("saved");
  expect(fixtures.open).toHaveBeenCalledTimes(2); expect(work).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});

test.each(["UNCONFIRMED", "ACK_DEADLINE", "ANCHOR_CHANGED", "LEASE_INVALID"] as const)("%s acquisition is never automatically retried", async reason => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  fixtures.open.mockRejectedValue(new Error("Unknown authority", { cause: new FirestoreOwnershipFailure(reason) }));
  const work = vi.fn(); await expect(withFunctionResources(f.input, work)).rejects.toThrow("Unknown authority");
  expect(fixtures.open).toHaveBeenCalledOnce(); expect(work).not.toHaveBeenCalled();
});

test.each(["WRITER_HELD", "WRITER_HANDOFF"] as const)("a %s work failure never reopens resources or repeats admitted work", async reason => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  const work = vi.fn(async () => { throw new Error("Already admitted", { cause: new FirestoreOwnershipFailure(reason) }); });
  await expect(withFunctionResources(f.input, work)).rejects.toThrow("Already admitted");
  expect(fixtures.open).toHaveBeenCalledOnce(); expect(work).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});

test("cancelled acquisition wait never opens a later invocation or starts work", async () => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  fixtures.open.mockRejectedValue(new Error("Busy", { cause: new FirestoreOwnershipFailure("WRITER_HELD") }));
  const controller = new AbortController(), work = vi.fn();
  const result = withFunctionResources({ ...f.input, signal: controller.signal }, work);
  const rejected = expect(result).rejects.toThrow(/cancel/i);
  await vi.waitFor(() => expect(fixtures.open).toHaveBeenCalledOnce()); controller.abort(); await rejected;
  expect(fixtures.open).toHaveBeenCalledOnce(); expect(work).not.toHaveBeenCalled();
});

test("a late acknowledged owner after the five-second admission deadline is closed without starting work", async () => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  f.input.config.functionsWriterAdmissionTimeoutMs = 5000;
  let finish!: (resources: unknown) => void;
  fixtures.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers();
  try {
    const work = vi.fn(), result = withFunctionResources(f.input, work);
    const rejected = expect(result).rejects.toThrow(/5000ms/);
    await vi.advanceTimersByTimeAsync(5001); await rejected;
    expect(work).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
    finish({ repository: f.repository, close: f.close });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.close).toHaveBeenCalledOnce(); expect(work).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

test.each(["WRITER_HELD", "WRITER_HANDOFF"] as const)("confirmed %s can wait beyond five seconds, then execute work exactly once", async reason => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  vi.useFakeTimers();
  try {
    const started = Date.now();
    fixtures.open.mockImplementation(async () => {
      if (Date.now() - started < 6500) throw new Error("Busy", { cause: new FirestoreOwnershipFailure(reason) });
      return { repository: f.repository, close: f.close };
    });
    const work = vi.fn(async () => "saved"), result = withFunctionResources(f.input, work);
    await vi.advanceTimersByTimeAsync(6000); expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); expect(await result).toBe("saved");
    expect(fixtures.open.mock.calls.length).toBeGreaterThan(1); expect(work).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

test("persistent confirmed contention is bounded by the longer deadline and stops opening after timeout", async () => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  fixtures.open.mockRejectedValue(new Error("Busy", { cause: new FirestoreOwnershipFailure("WRITER_HELD") }));
  vi.useFakeTimers();
  try {
    const work = vi.fn(), result = withFunctionResources(f.input, work);
    const rejected = expect(result).rejects.toThrow(/30000ms/);
    await vi.advanceTimersByTimeAsync(29_999); expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2); await rejected;
    const opens = fixtures.open.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixtures.open).toHaveBeenCalledTimes(opens); expect(work).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

test("a late owner after the configured longer deadline is disposed, never used", async () => {
  const f = await setup(); f.input.config.storageDriver = "firestore-records";
  f.input.config.functionsWriterAdmissionTimeoutMs = 60_000;
  let finish!: (resources: unknown) => void;
  fixtures.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers();
  try {
    const work = vi.fn(), result = withFunctionResources(f.input, work);
    const rejected = expect(result).rejects.toThrow(/60000ms/);
    await vi.advanceTimersByTimeAsync(60_001); await rejected;
    finish({ repository: f.repository, close: f.close }); await vi.advanceTimersByTimeAsync(0);
    expect(f.close).toHaveBeenCalledOnce(); expect(work).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
