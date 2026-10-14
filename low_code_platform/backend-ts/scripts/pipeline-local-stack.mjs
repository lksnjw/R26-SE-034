// Local acceptance host: separate Compose projects, actual API/agent/MCP,
// synthetic users only. It leaves the services running for the requested UI run.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { applyPipelineTools } from "./pipeline-bridge-tools.mjs";
import { loadConfig } from "../src/config/config.ts";
import { openApplicationResources, constructApplicationRuntime } from "../src/entrypoints/application-runtime.ts";
import { buildApp } from "../src/http/app.ts";
import { hashPassword } from "../src/authn/password.ts";
import { importDiscoveredCapability } from "../src/registry/capability-import.ts";
import { remoteContractHash } from "../src/registry/discovered-contract.ts";

const root = resolve(".."), stateDir = resolve(root, "tmp/pipeline-local"),
  statePath = resolve(stateDir, "session.json");
const run = promisify(execFile);
const pipelineCompose = resolve(root, "DATA_TRANSFORM/erp-data-transformation-pipeline/docker-compose.yml");
const bridgeCompose = resolve(root, "ops/erpbridge/compose.pipeline.local.yml");
let session;
if (["--resume", "--rebuild-pipeline", "--services-only"].includes(process.argv[2])) session = JSON.parse(await readFile(statePath, "utf8"));
else {
  if (process.argv[2] !== "--start") throw new Error("Use --start for a fresh local stack or --resume for its saved session");
  let exists = false; try { await access(statePath); exists = true; } catch {}
  if (exists) throw new Error("An existing local session is present; use --resume");
  session = { PIPELINE_DB_PASSWORD: randomBytes(24).toString("hex"), ERP_API_KEY: randomBytes(32).toString("hex"),
    ERP_FILTER_TOKEN_KEY: randomBytes(32).toString("hex"), PIPELINE_QA_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
    jwt: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
  await mkdir(stateDir, {recursive: true});
  await writeFile(statePath, JSON.stringify(session), {flag: "wx", mode: 0o600});
  await writeFile(resolve(stateDir, "empty.env"), "", {flag: "wx"});
}
const environment = {...process.env, ...session};
async function compose(file, project) {
  try { await run("docker", ["compose", "--env-file", resolve(stateDir, "empty.env"), "-p", project, "-f", file,
    "up", "-d", "--build", "--wait", "--wait-timeout", "240"], {env: environment, windowsHide: true, maxBuffer: 16000000}); }
  catch (error) { console.error(String(error.stderr ?? "").split(/\r?\n/).slice(-15).join("\n")); throw new Error(`Startup failed for ${project}`); }
}
console.log("Starting pipeline, PostgreSQL and Qdrant in lcwe-pipeline-local...");
await compose(pipelineCompose, "lcwe-pipeline-local");
if (process.argv[2] === "--rebuild-pipeline") {
  console.log("Pipeline rebuilt and healthy; durable uploads/database/vector volumes retained.");
  process.exit(0);
}
console.log("Starting separate ERPBridge deployment in lcwe-pipeline-bridge-local...");
await compose(bridgeCompose, "lcwe-pipeline-bridge-local");
const resourcesApplied = await applyPipelineTools({bridgeURL: "http://127.0.0.1:18080",
  pipelineURL: "http://host.docker.internal:8000", token: session.PIPELINE_QA_BRIDGE_TOKEN});
console.log(`Applied and read back ${resourcesApplied.length} pipeline tools in ERPBridge.`);
if (!session.mcpToken) {
  const issued = await fetch("http://127.0.0.1:18080/api/auth/tokens", {method: "POST",
    headers: {Authorization: `Bearer ${session.PIPELINE_QA_BRIDGE_TOKEN}`, "Content-Type": "application/json"},
    body: JSON.stringify({name: "pipeline-local-synthetic-qa", scopes: ["mcp"], roles: ["platform_admin", "client"],
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString()}), signal: AbortSignal.timeout(15000)});
  if (!issued.ok) throw new Error(`Scoped MCP token creation failed: HTTP ${issued.status}`);
  const credential = await issued.json();
  session.mcpToken = credential.token;
  await writeFile(statePath, JSON.stringify(session), {mode: 0o600});
}
if (process.argv[2] === "--services-only") {
  console.log("Pipeline, databases and separate ERPBridge healthy; existing application runtime left untouched.");
  process.exit(0);
}
await writeFile(resolve(stateDir, "tools.json"), "[]");
await writeFile(resolve(stateDir, "rules.json"), "[]");
await writeFile(resolve(stateDir, "registry_context.md"), "Local synthetic pipeline qualification. No business ERP records.\n");
const config = loadConfig({APP_ENV: "development", STORAGE_DRIVER: "memory", JWT_SECRET: session.jwt,
  TOOL_REGISTRY_PATH: resolve(stateDir, "tools.json"), RULE_REGISTRY_PATH: resolve(stateDir, "rules.json"),
  MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp", ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080",
  ERPBRIDGE_MCP_TOKEN: session.mcpToken, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"platform_admin","Client":"client"}',
  MCP_TIMEOUT_MS: "60000", PIPELINE_API_BASE_URL: "http://127.0.0.1:8000", PIPELINE_API_KEY: session.ERP_API_KEY,
  PIPELINE_TIMEOUT_MS: "180000", PORT: "18082", CORS_ORIGINS: "http://localhost:5193,http://127.0.0.1:5193",
  GENERATION_BASE_URL: process.env.GENERATION_BASE_URL, GENERATION_API_KEY: process.env.GENERATION_API_KEY,
  GENERATION_MODEL_PRIMARY: process.env.GENERATION_MODEL_PRIMARY,
  GENERATION_MODEL_FALLBACK: process.env.GENERATION_MODEL_FALLBACK, GENERATION_TIMEOUT_MS: "120000"}, process.cwd());
const resources = await openApplicationResources({config, root: process.cwd(), registryPreparation: "existing-only"});
const password = "Pipeline-QA-2026!", passwordHash = await hashPassword(password);
await resources.repository.mutate(state => {
  for (const [id, email, name, roleId] of [["pipeline_qa", "pipeline.qa@example.test", "Pipeline QA", "role_admin"],
    ["pipeline_reader", "reader.qa@example.test", "Pipeline reader", "role_client"]]) {
    state.users[id] = {id, email, name, roleId, permissionOverrides: [], status: "Active", initials: "QA",
      departmentId: null, createdAt: new Date().toISOString(), lastLoginAt: null};
    state.passwordHashes[id] = passwordHash;
  }
});
const runtime = await constructApplicationRuntime(resources), services = runtime.services;
const actor = await resources.repository.effectiveUser("pipeline_qa");
const connectionStatus = await services.mcpConnectionRuntime.status(actor);
await services.mcpConnectionRuntime.command("connect", actor, {
  baseRevision: connectionStatus.connections[0].revision,
  requestId: `pipeline-qa-connect-${randomBytes(8).toString("hex")}`,
});
const remote = await services.erpbridgeSession.listTools();
for (const tool of remote) {
  if (!resourcesApplied.some(resource => tool.name === `${resource.metadata.name}.rev_${Buffer.from(resource.metadata.version).toString("base64url")}`)) continue;
  await importDiscoveredCapability({repository: resources.repository, registries: resources.registries,
    session: services.erpbridgeSession, user: actor, body: {remoteName: tool.name, remoteHash: remoteContractHash(tool),
      decisionKey: `pipeline-qa-review-${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`, allowedRoles: ["Platform Admin", "Client"], effectClass: "read",
      riskClass: "low", dataClass: "restricted", retryPolicy: "never", confirmed: true,
      note: "User requested local synthetic upload and chat retrieval through separately deployed ERPBridge/pipeline. Exact read contract reviewed for QA users."}});
}
if (services.providerRuntime.configured) {
  const current = services.providerRuntime.configuration;
  services.providerRuntime.activate({...current, egressPolicy: {profile: "model-egress-policy/v1",
    approvedOrigin: new URL(current.baseURL).origin, runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [],
    interactiveDataClasses: ["public", "internal", "confidential", "restricted"], reviewedAt: new Date().toISOString(),
    reviewedBy: {id: actor.id, name: "User-authorized synthetic QA only"}}});
}
const app = await buildApp(services);
await app.listen({host: "127.0.0.1", port: 18082});
const frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5193", "--strictPort"],
  {cwd: resolve(root, "frontend"), env: {...process.env, VITE_API_BASE_URL: "http://127.0.0.1:18082/api",
    VITE_WS_BASE_URL: "ws://127.0.0.1:18082/ws", VITE_API_REQUEST_TIMEOUT_MS: "180000"}, windowsHide: true, stdio: "inherit"});
console.log("Backend ready at http://127.0.0.1:18082; frontend http://127.0.0.1:5193.");
console.log(`Synthetic QA login: pipeline.qa@example.test / ${password}; reader.qa@example.test / ${password}.`);
console.log(`Real configured model: ${services.providerRuntime.configuration?.model ?? "unavailable"}. Application QA state is memory-only; pipeline and bridge stores are durable Docker volumes.`);
let closing = false;
async function close() { if (closing) return; closing = true; frontend.kill(); await app.close(); await runtime.close(); process.exit(0); }
process.once("SIGINT", close); process.once("SIGTERM", close);
