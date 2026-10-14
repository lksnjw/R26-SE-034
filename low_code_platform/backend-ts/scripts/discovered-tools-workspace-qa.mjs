// Operator-only normal runtime: empty local catalog, real selected model and
// the existing loopback Docker MockERP. No upstream resource/source edits.
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, parseAdditionalModelIds } from "../src/config/config.ts";
import { openApplicationResources, constructApplicationRuntime } from "../src/entrypoints/application-runtime.ts";
import { hashPassword } from "../src/authn/password.ts";
import { buildApp } from "../src/http/app.ts";
import { assertRealProviderQaConfiguration } from "./erpbridge-workspace-qa.mjs";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";

export const discoveredQaPort = 31882;

export function assertDiscoveredWorkspaceScope(environment) {
  assertRealProviderQaConfiguration(environment);
  parseAdditionalModelIds(environment.GENERATION_ADDITIONAL_MODELS);
  if (environment.LCWE_DISCOVERED_QA !== "unreviewed-docker-only")
    throw new Error("Explicit unreviewed Docker-only scope is required; credentials suppressed");
}

export async function createDiscoveredToolsWorkspace(environment = process.env) {
  assertDiscoveredWorkspaceScope(environment);
  const token = await readQaBridgeToken(), directory = await mkdtemp(resolve(tmpdir(), "lcwe-discovered-workspace-"));
  const files = [resolve(directory, "tools.json"), resolve(directory, "rules.json"), resolve(directory, "registry_context.md")];
  let resources, runtime, app, closing;
  const close = () => closing ??= (async () => {
    const failures = [];
    for (const dispose of [() => app?.close(), () => runtime?.close(), () => resources?.close()]) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    for (const file of files) {
      try { await unlink(file); } catch (error) { if (error.code !== "ENOENT") failures.push(error); }
    }
    try { await rmdir(directory); } catch (error) { if (error.code !== "ENOENT") failures.push(error); }
    if (failures.length) throw new Error("Discovered workspace cleanup could not be fully confirmed; details suppressed");
  })();
  try {
    await writeFile(files[0], "[]", { flag: "wx" }); await writeFile(files[1], "[]", { flag: "wx" });
    await writeFile(files[2], "# LOCAL QA\nNo local tool definitions or permissions have been imported.\n", { flag: "wx" });
    const config = loadConfig({ APP_ENV: "development", PORT: String(discoveredQaPort), JWT_SECRET: randomBytes(48).toString("hex"), STORAGE_DRIVER: "memory",
      TOOL_REGISTRY_PATH: files[0], RULE_REGISTRY_PATH: files[1], MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
      ERPBRIDGE_BASE_URL: qaBaseURL, ERPBRIDGE_MCP_TOKEN: token, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"admin"}',
      CORS_ORIGINS: "http://127.0.0.1:5174,http://localhost:5174" });
    resources = await openApplicationResources({ config, root: process.cwd(), registryPreparation: "existing-only" });
    const timestamp = new Date().toISOString(), passwordHash = await hashPassword("Local-QA-only-2026!");
    await resources.repository.mutate(state => {
      state.users.qa = { id: "qa", name: "LOCAL unknown-tool QA", email: "qa@example.test", roleId: "role_admin", permissionOverrides: [],
        status: "Active", initials: "QA", departmentId: null, createdAt: timestamp, lastLoginAt: null };
      state.passwordHashes.qa = passwordHash;
    });
    runtime = await constructApplicationRuntime(resources);
    app = await buildApp(runtime.services);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } });
    if (login.statusCode !== 200) throw new Error("Synthetic operator authentication failed");
    const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
    const request = async (method, url, payload, expected = 200) => {
      const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
      if (response.body.includes(environment.GENERATION_API_KEY)) throw new Error("Provider secret escaped public projection");
      if (response.statusCode !== expected) throw new Error(`QA request ${method} ${url} returned ${response.statusCode}; response body suppressed`);
      return response.json().data;
    };
    const status = await request("GET", "/api/settings/mcp-connections"), connection = status.connections[0];
    await request("POST", `/api/settings/mcp-connections/${connection.id}/connect`, { baseRevision: connection.revision, requestId: "unknown-tools-explicit-connect-0001" });
    const provider = await request("POST", "/api/providers", { name: "REAL DeepSeek · unknown synthetic Docker-only QA", type: "openai_compatible",
      baseUrl: environment.GENERATION_BASE_URL, apiKey: environment.GENERATION_API_KEY, model: environment.GENERATION_MODEL_PRIMARY, temperature: 0,
      additionalModels: parseAdditionalModelIds(environment.GENERATION_ADDITIONAL_MODELS),
      egressPolicy: { approvedOrigin: "https://openrouter.ai", confirmed: true, interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [] } }, 201);
    await request("POST", `/api/providers/${provider.id}/activate`, {});
    if (runtime.services.registries.snapshot().tools.length || Object.keys((await resources.repository.snapshot()).capabilityAdmissions).length)
      throw new Error("Unknown-tool QA must start without preconfigured or admitted tools");
    return { app, services: runtime.services, repository: resources.repository, headers, request, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--serve-unreviewed-docker") throw new Error("Explicit operator mode required");
    process.env.LCWE_REAL_MODEL_QA = "synthetic-docker-only"; process.env.LCWE_DISCOVERED_QA = "unreviewed-docker-only";
    const workspace = await createDiscoveredToolsWorkspace();
    try { await workspace.app.listen({ host: "127.0.0.1", port: discoveredQaPort }); } catch (error) { await workspace.close(); throw error; }
    console.log(`LOCAL unknown-tool QA 127.0.0.1:${discoveredQaPort} · empty local catalog · real selected model · existing Docker MockERP · memory only`);
    console.log("Synthetic login qa@example.test / Local-QA-only-2026! · imports require visible explicit review · no pre-generated workflow/answers");
    let stopping; for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
      stopping ??= workspace.close(); stopping.catch(() => { process.exitCode = 1; });
    });
  } catch { console.error("Unknown-tool operator workspace was not confirmed; inspect exact synthetic QA prerequisites. Credentials suppressed."); process.exitCode = 1; }
}
