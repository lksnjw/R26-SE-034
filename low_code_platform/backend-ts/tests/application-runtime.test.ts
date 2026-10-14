import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { openApplicationResources, constructApplicationRuntime } from "../src/entrypoints/application-runtime.js";

const fixtures = vi.hoisted(() => {
  const events: string[] = [];
  return { events,
    registry: { hash: () => "fixture", snapshot: () => ({ tools: [], rules: [] }), replaceReviewedTools: vi.fn(() => { events.push("capabilities.restore"); }) },
    repository: { mutate: vi.fn(), assertAuthority: vi.fn(), readAuthoritative: vi.fn(async (read: (state: { capabilityAdmissions: Record<string, never> }) => unknown) => read({ capabilityAdmissions: {} })), close: vi.fn(async () => { events.push("repository.close"); }) },
    ensure: vi.fn(async () => { events.push("registries.ensure"); }),
    registryLoad: vi.fn(), repositoryOpen: vi.fn(), mcpOpen: vi.fn(),
    mcp: { session: { id: "first" }, stop: vi.fn(async () => { events.push("mcp.stop"); }) },
    boundaryClose: vi.fn(() => { events.push("boundary.close"); }),
    providerActivate: vi.fn(async () => { events.push("provider.activate"); }),
    governanceInitialize: vi.fn(async () => { events.push("governance.initialize"); }),
    httpBuild: vi.fn(),
  };
});
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(),
  access: vi.fn(async () => { fixtures.events.push("context.access"); }),
  mkdir: vi.fn(async () => { fixtures.events.push("context.mkdir"); }),
  copyFile: vi.fn(async () => { fixtures.events.push("context.copy"); }),
}));
vi.mock("../src/registry/service.js", () => ({ ensureRuntimeRegistries: fixtures.ensure,
  RegistryService: { load: fixtures.registryLoad } }));
vi.mock("../src/storage/open-repository.js", () => ({ openApplicationRepository: fixtures.repositoryOpen }));
vi.mock("../src/tools/mcp-connection-runtime.js", () => ({ McpConnectionManager: { open: fixtures.mcpOpen } }));
vi.mock("../src/tools/executor-tool-boundary.js", () => ({ createExecutorToolBoundary: vi.fn(() => {
  fixtures.events.push("boundary.create"); return { registry: {}, close: fixtures.boundaryClose };
}) }));
vi.mock("../src/providers/runtime.js", () => ({ ProviderRuntime: class {
  activateStoredOrStatic = fixtures.providerActivate;
} }));
vi.mock("../src/governance/service.js", () => ({ GovernanceService: class {
  initialize = fixtures.governanceInitialize;
} }));
vi.mock("../src/http/app.js", () => ({ buildApp: fixtures.httpBuild }));

beforeEach(() => {
  vi.clearAllMocks(); fixtures.events.length = 0;
  for (const mock of [fixtures.registryLoad, fixtures.repositoryOpen, fixtures.mcpOpen, fixtures.repository.close,
    fixtures.mcp.stop, fixtures.boundaryClose, fixtures.providerActivate, fixtures.governanceInitialize, fixtures.repository.readAuthoritative, fixtures.registry.replaceReviewedTools]) mock.mockReset();
  fixtures.repository.readAuthoritative.mockImplementation(async read => read({ capabilityAdmissions: {} }));
  fixtures.registry.replaceReviewedTools.mockImplementation(() => { fixtures.events.push("capabilities.restore"); });
  fixtures.registryLoad.mockImplementation(async () => { fixtures.events.push("registries.load"); return fixtures.registry; });
  fixtures.repositoryOpen.mockImplementation(async () => { fixtures.events.push("repository.open"); return fixtures.repository; });
  fixtures.mcpOpen.mockImplementation(async () => { fixtures.events.push("mcp.open"); return fixtures.mcp; });
  fixtures.repository.close.mockImplementation(async () => { fixtures.events.push("repository.close"); });
  fixtures.mcp.stop.mockImplementation(async () => { fixtures.events.push("mcp.stop"); });
  fixtures.boundaryClose.mockImplementation(() => { fixtures.events.push("boundary.close"); });
  fixtures.providerActivate.mockImplementation(async () => { fixtures.events.push("provider.activate"); });
  fixtures.governanceInitialize.mockImplementation(async () => { fixtures.events.push("governance.initialize"); });
});

const config = () => loadConfig({ APP_ENV: "test", MCP_MODE: "mock" });
const open = () => openApplicationResources({ config: config(), root: process.cwd() });

describe("owned application service construction", () => {
  it("existing-only assets do not bootstrap or copy files before opening storage", async () => {
    const resources = await openApplicationResources({ config: config(), root: process.cwd(), registryPreparation: "existing-only" });
    expect(fixtures.events).toEqual(["context.access", "registries.load", "repository.open"]);
    expect(fixtures.ensure).not.toHaveBeenCalled(); await resources.close();
  });
  it("rejects unknown registry preparation policy before any initialization", async () => {
    await expect(openApplicationResources({ config: config(), root: process.cwd(), registryPreparation: "implicit-repair" as never })).rejects.toThrow("registry preparation");
    expect(fixtures.events).toEqual([]);
  });
  it("opens resources, then services, without HTTP, signals, bootstrap or execution", async () => {
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const resources = await open();
    expect(fixtures.events).toEqual(["registries.ensure", "context.mkdir", "context.copy", "registries.load", "repository.open"]);
    expect(fixtures.mcpOpen).not.toHaveBeenCalled();
    const runtime = await constructApplicationRuntime(resources);
    expect(fixtures.events.slice(5)).toEqual(["capabilities.restore", "mcp.open", "boundary.create", "provider.activate", "governance.initialize"]);
    expect(runtime.services.repository).toBe(resources.repository);
    expect(runtime.services.erpbridgeSession).toBe(fixtures.mcp.session);
    const nextSession = { id: "replacement" }; fixtures.mcp.session = nextSession;
    expect(runtime.services.erpbridgeSession).toBe(nextSession);
    expect(fixtures.repository.mutate).not.toHaveBeenCalled();
    expect(fixtures.httpBuild).not.toHaveBeenCalled();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
    await runtime.close();
  });
  it("retains the configured provider settings and bounded activation timeout", async () => {
    const settings = loadConfig({ APP_ENV: "test", MCP_MODE: "mock", GENERATION_BASE_URL: "https://provider.example.test",
      GENERATION_API_KEY: "synthetic", GENERATION_MODEL_PRIMARY: "fixture-1", GENERATION_MODEL_FALLBACK: "fixture-2", GENERATION_TIMEOUT_MS: "1234", GENERATION_TEMPERATURE: "0.4" });
    const resources = await openApplicationResources({ config: settings, root: process.cwd() });
    const runtime = await constructApplicationRuntime(resources);
    expect(fixtures.providerActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "provider_static", baseURL: settings.generationBaseURL,
      apiKey: "synthetic", model: "fixture-1", fallbackModel: "fixture-2", timeoutMs: 1234, temperature: 0.4 }), 1234);
    await runtime.close();
  });
  it("rejects the unreviewed remote legacy profile before opening MCP and closes storage", async () => {
    const resources = await openApplicationResources({ config: { ...config(), mcpMode: "remote", mcpTransport: "bridge-v1" }, root: process.cwd() });
    await expect(constructApplicationRuntime(resources)).rejects.toThrow(/no reviewed/);
    expect(fixtures.mcpOpen).not.toHaveBeenCalled();
    expect(fixtures.repository.close).toHaveBeenCalledOnce();
    await resources.close();
    expect(fixtures.repository.close).toHaveBeenCalledOnce();
  });
  it.each(["mcp", "provider", "governance"])("cleans all acquired owners when %s initialization fails", async stage => {
    const failed = new Error(`${stage} setup failed`);
    if (stage === "mcp") fixtures.mcpOpen.mockRejectedValueOnce(failed);
    if (stage === "provider") fixtures.providerActivate.mockRejectedValueOnce(failed);
    if (stage === "governance") fixtures.governanceInitialize.mockRejectedValueOnce(failed);
    const resources = await open();
    await expect(constructApplicationRuntime(resources)).rejects.toBe(failed);
    await resources.close();
    expect(fixtures.repository.close).toHaveBeenCalledOnce();
    expect(fixtures.mcp.stop).toHaveBeenCalledTimes(stage === "mcp" ? 0 : 1);
    expect(fixtures.boundaryClose).toHaveBeenCalledTimes(stage === "mcp" ? 0 : 1);
    if (stage !== "mcp") expect(fixtures.events.slice(-3)).toEqual(["boundary.close", "mcp.stop", "repository.close"]);
  });
  it("shares one awaited close across concurrent callers and continues after disposer failures", async () => {
    const resources = await open(), runtime = await constructApplicationRuntime(resources);
    let finishStop!: () => void;
    fixtures.boundaryClose.mockImplementationOnce(() => { throw new Error("boundary close failed"); });
    fixtures.mcp.stop.mockImplementationOnce(() => new Promise<void>(resolveStop => { finishStop = resolveStop; }));
    const first = runtime.close(), second = resources.close();
    expect(first).toBe(second);
    const check = expect(first).rejects.toThrow(/cleanup could not be fully confirmed/);
    await vi.waitFor(() => expect(fixtures.mcp.stop).toHaveBeenCalledOnce());
    expect(fixtures.repository.close).not.toHaveBeenCalled();
    finishStop(); await check;
    await expect(runtime.close()).rejects.toThrow(/cleanup/);
    expect(fixtures.repository.close).toHaveBeenCalledOnce();
    expect(fixtures.boundaryClose).toHaveBeenCalledOnce();
    expect(fixtures.mcp.stop).toHaveBeenCalledOnce();
  });
  it("preserves initialization and cleanup errors while still closing storage", async () => {
    fixtures.providerActivate.mockRejectedValueOnce(new Error("activation failed"));
    fixtures.boundaryClose.mockImplementationOnce(() => { throw new Error("unsubscribe failed"); });
    const resources = await open();
    await expect(constructApplicationRuntime(resources)).rejects.toMatchObject({ name: "AggregateError", message: expect.stringContaining("construction failed") });
    expect(fixtures.mcp.stop).toHaveBeenCalledOnce();
    expect(fixtures.repository.close).toHaveBeenCalledOnce();
  });
  it("awaits an in-progress acquisition before closing it and refuses to return a closed runtime", async () => {
    let releaseMcp!: () => void;
    fixtures.mcpOpen.mockImplementationOnce(() => new Promise(resolveOpen => {
      releaseMcp = () => resolveOpen(fixtures.mcp);
    }));
    const resources = await open();
    const constructing = constructApplicationRuntime(resources);
    const rejected = expect(constructing).rejects.toThrow(/closing or closed/);
    await vi.waitFor(() => expect(releaseMcp).toEqual(expect.any(Function)));
    const closing = resources.close();
    expect(fixtures.repository.close).not.toHaveBeenCalled();
    releaseMcp(); await rejected; await closing;
    expect(fixtures.mcp.stop).toHaveBeenCalledOnce();
    expect(fixtures.repository.close).toHaveBeenCalledOnce();
    expect(fixtures.providerActivate).not.toHaveBeenCalled();
  });
  it("fails closed and disposes storage when imported-contract restoration fails", async () => {
    const resources = await open();
    fixtures.repository.readAuthoritative.mockRejectedValueOnce(new Error("Imported contracts unavailable"));
    await expect(constructApplicationRuntime(resources)).rejects.toThrow("Imported contracts unavailable");
    expect(fixtures.mcpOpen).not.toHaveBeenCalled(); expect(fixtures.repository.close).toHaveBeenCalledOnce();
  });
  it("closing during imported-contract restoration never acquires an MCP session", async () => {
    let releaseRestore!: () => void;
    fixtures.repository.readAuthoritative.mockImplementationOnce(async read => new Promise(resolveRead => {
      releaseRestore = () => resolveRead(read({ capabilityAdmissions: {} }));
    }));
    const resources = await open(), constructing = constructApplicationRuntime(resources);
    const rejected = expect(constructing).rejects.toThrow(/closing or closed/);
    await vi.waitFor(() => expect(releaseRestore).toEqual(expect.any(Function)));
    const closing = resources.close(); releaseRestore(); await rejected; await closing;
    expect(fixtures.mcpOpen).not.toHaveBeenCalled(); expect(fixtures.repository.close).toHaveBeenCalledOnce();
  });
  it("waits for provider initialization before disposing MCP and storage", async () => {
    let releaseProvider!: () => void;
    fixtures.providerActivate.mockImplementationOnce(() => new Promise<void>(resolveActivation => { releaseProvider = resolveActivation; }));
    const resources = await open(), constructing = constructApplicationRuntime(resources);
    const rejected = expect(constructing).rejects.toThrow(/closing or closed/);
    await vi.waitFor(() => expect(fixtures.providerActivate).toHaveBeenCalledOnce());
    const closing = resources.close();
    expect(fixtures.mcp.stop).not.toHaveBeenCalled();
    expect(fixtures.repository.close).not.toHaveBeenCalled();
    releaseProvider(); await rejected; await closing;
    expect(fixtures.events.slice(-3)).toEqual(["boundary.close", "mcp.stop", "repository.close"]);
    expect(fixtures.governanceInitialize).not.toHaveBeenCalled();
  });
  it("refuses duplicate construction or construction from closed resources", async () => {
    const resources = await open(), runtime = await constructApplicationRuntime(resources);
    await expect(constructApplicationRuntime(resources)).rejects.toThrow(/already been constructed/);
    expect(fixtures.mcpOpen).toHaveBeenCalledOnce();
    await runtime.close();
    await expect(constructApplicationRuntime(resources)).rejects.toThrow(/closing or closed/);
    const unused = await open(); await unused.close();
    await expect(constructApplicationRuntime(unused)).rejects.toThrow(/closing or closed/);
  });
});
