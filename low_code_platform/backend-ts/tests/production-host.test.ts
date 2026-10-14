import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const events: string[] = [];
  return { events, signals: new Map<string, () => void>(),
    read: vi.fn(), mutate: vi.fn(), hash: vi.fn(), reconcile: vi.fn(),
    resourcesClose: vi.fn(), runtimeConstruct: vi.fn(), httpBuild: vi.fn(),
    httpClose: vi.fn(), listen: vi.fn(), services: { id: "owned-services" },
  };
});
vi.mock("../src/config/config.js", () => ({ loadConfig: () => ({
  port: 54321, storageDriver: "memory", platformAdminEmail: "admin@example.test", platformAdminPassword: "synthetic-only",
}) }));
vi.mock("../src/entrypoints/application-runtime.js", () => ({ APPLICATION_STORAGE_TIMEOUT_MS: 30_000,
  openApplicationResources: vi.fn(async (input: { onRegistriesLoaded?: () => void }) => {
    host.events.push("resources.open"); input.onRegistriesLoaded?.();
    return { repository: { read: host.read, mutate: host.mutate }, close: host.resourcesClose };
  }), constructApplicationRuntime: host.runtimeConstruct,
}));
vi.mock("../src/authn/password.js", () => ({ hashPassword: host.hash }));
vi.mock("../src/runner/read-checkpoints.js", () => ({ reconcileInterruptedExecutions: host.reconcile }));
vi.mock("../src/http/app.js", () => ({ buildApp: host.httpBuild }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); host.events.length = 0; host.signals.clear();
  for (const mock of [host.read, host.mutate, host.hash, host.reconcile, host.resourcesClose, host.runtimeConstruct,
    host.httpBuild, host.httpClose, host.listen]) mock.mockReset();
  host.read.mockImplementation(async (read: (state: unknown) => unknown) => {
    host.events.push("bootstrap.read"); return read({ users: { fixture: { id: "fixture", email: "admin@example.test" } } });
  });
  host.hash.mockImplementation(async () => { host.events.push("bootstrap.hash"); return "synthetic-hash"; });
  host.mutate.mockImplementation(async (mutate: (state: unknown) => void) => {
    host.events.push("bootstrap.mutate"); const state = { passwordHashes: {} }; mutate(state); return state;
  });
  host.reconcile.mockImplementation(async () => { host.events.push("reconcile"); });
  host.runtimeConstruct.mockImplementation(async () => { host.events.push("runtime.construct"); return { services: host.services }; });
  host.httpBuild.mockImplementation(async () => { host.events.push("http.build"); return { close: host.httpClose, listen: host.listen }; });
  host.httpClose.mockImplementation(async () => { host.events.push("http.close"); });
  host.resourcesClose.mockImplementation(async () => { host.events.push("resources.close"); });
  host.listen.mockImplementation(async () => { host.events.push("http.listen"); });
  const originalOnce = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      host.events.push(`signal.${event}`); host.signals.set(event, listener); return process;
    }
    return originalOnce(event, listener);
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const start = () => import("../src/entrypoints/production.js");

describe("resident production composition root", () => {
  it("bootstraps and reconciles before constructing services, then builds HTTP and listens", async () => {
    await start();
    expect(host.events).toEqual(["resources.open", "bootstrap.read", "bootstrap.hash", "bootstrap.mutate", "reconcile",
      "runtime.construct", "http.build", "signal.SIGINT", "signal.SIGTERM", "http.listen"]);
    expect(host.httpBuild).toHaveBeenCalledWith(host.services);
    expect(host.listen).toHaveBeenCalledWith({ host: "0.0.0.0", port: 54321 });
    await expect(host.mutate.mock.results[0]?.value).resolves.toEqual({ passwordHashes: { fixture: "synthetic-hash" } });
    expect(host.resourcesClose).not.toHaveBeenCalled();
    host.signals.get("SIGTERM")?.();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(host.events.slice(-2)).toEqual(["http.close", "resources.close"]);
  });
  it.each(["bootstrap", "reconciliation", "http-build", "listen"])("closes acquired resources when %s startup fails", async stage => {
    const failure = new Error("startup fixture failure");
    if (stage === "bootstrap") host.hash.mockRejectedValueOnce(failure);
    if (stage === "reconciliation") host.reconcile.mockRejectedValueOnce(failure);
    if (stage === "http-build") host.httpBuild.mockRejectedValueOnce(failure);
    if (stage === "listen") host.listen.mockRejectedValueOnce(failure);
    await expect(start()).rejects.toThrow(/Application startup failed.*details suppressed/);
    expect(host.resourcesClose).toHaveBeenCalledOnce();
    expect(host.httpClose).toHaveBeenCalledTimes(stage === "listen" ? 1 : 0);
    if (stage === "bootstrap" || stage === "reconciliation") expect(host.runtimeConstruct).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(0);
  });
  it("continues shutdown after HTTP close failure and shares cleanup across repeated signals", async () => {
    await start();
    host.httpClose.mockImplementationOnce(async () => { host.events.push("http.close"); throw new Error("HTTP cleanup fixture failure"); });
    host.signals.get("SIGINT")?.(); host.signals.get("SIGTERM")?.();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(host.httpClose).toHaveBeenCalledOnce();
    expect(host.resourcesClose).toHaveBeenCalledOnce();
    expect(host.events.slice(-2)).toEqual(["http.close", "resources.close"]);
  });
  it("preserves startup and cleanup failure evidence rather than masking the initial failure", async () => {
    host.listen.mockRejectedValueOnce(new Error("listener fixture failure"));
    host.httpClose.mockRejectedValueOnce(new Error("HTTP cleanup fixture failure"));
    host.resourcesClose.mockRejectedValueOnce(new Error("storage cleanup fixture failure"));
    await expect(start()).rejects.toMatchObject({ name: "Error", message: expect.stringContaining("upstream details suppressed") });
    expect(host.httpClose).toHaveBeenCalledOnce();
    expect(host.resourcesClose).toHaveBeenCalledOnce();
  });
  it("never exposes raw upstream errors or nested cleanup members to Node startup output", async () => {
    host.listen.mockRejectedValueOnce(new Error("provider credential=SENSITIVE_FIXTURE"));
    host.resourcesClose.mockRejectedValueOnce(new Error("storage credential=ANOTHER_SENSITIVE_FIXTURE"));
    try { await start(); throw new Error("Startup unexpectedly succeeded"); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      const failure = error as Error;
      expect(failure.message).toMatch(/details suppressed/);
      expect(failure.stack).not.toMatch(/SENSITIVE_FIXTURE/);
      expect(failure.cause).toBeUndefined();
      expect(failure).not.toBeInstanceOf(AggregateError);
    }
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("SENSITIVE_FIXTURE"));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("SENSITIVE_FIXTURE"));
  });
});
