// Creates only an isolated, loopback, disposable MockERP qualification stack.
// Does not edit ERPBridge, import tools, approve capabilities or execute tools.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function qaProjectName(inherited = {}) {
  const runId = inherited.LCWE_QA_RUN_ID;
  if (runId === undefined) return "lcwe-erpbridge-qa";
  if (typeof runId !== "string" || runId !== runId.trim() || !/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(runId))
    throw new Error("LCWE_QA_RUN_ID must be 1-24 lowercase letters, digits or internal hyphens; no arbitrary project override is supported");
  return `lcwe-erpbridge-qa-${runId}`;
}

// Every QA helper imports this same selection. Set it before launching Node.
export const qaProject = qaProjectName(process.env);
export const qaBaseURL = "http://127.0.0.1:18080";
export const qaCompose = resolve(dirname(fileURLToPath(import.meta.url)), "../ops/erpbridge/compose.qa.yml");
export const qaRegistryPaths = ["all_tools_master_registry.json", "all_rules_master_registry.json"].map(name => resolve(dirname(fileURLToPath(import.meta.url)), "../configs/runtime", name));

export function qaEnvironment(inherited = {}) {
  qaProjectName(inherited); // reject malformed selection before generating secrets
  const key = randomBytes(24).toString("hex"), secret = randomBytes(32).toString("hex");
  return { ...inherited,
    LCWE_QA_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
    LCWE_QA_MOCK_CREDENTIALS: JSON.stringify({ credentials: [{ api_key: key, api_secret: secret, role: "admin", identity: "lcwe-local-qa" }] }),
    LCWE_QA_ERP_PRIMARY_KEY: `token ${key}:${secret}`,
  };
}

export function qaMode(args) {
  if (args.length !== 1 || !["--check", "--start", "--verify"].includes(args[0]))
    throw new Error("Use --check for Compose validation, --start for a new isolated stack or --verify for read-only discovery of that stack");
  return args[0];
}

export function assertEmptyQaProject(containers, volumes) {
  if (containers.trim() || volumes.trim())
    throw new Error("QA project already contains containers or retained volumes; refusing to recreate, overwrite or delete them");
}

export function assertQaResourceNamesAvailable(inventory, project = qaProject) {
  const names = value => new Set(value.trim().split(/\r?\n/).filter(Boolean));
  const containers = names(inventory.containers), volumes = names(inventory.volumes), networks = names(inventory.networks);
  if (["erpbridge-server", "mock-erp", "redis"].some(service => containers.has(`${project}-${service}-1`)) ||
    ["erpbridge-data", "mockerp-data", "redis-data"].some(volume => volumes.has(`${project}_${volume}`)) ||
    networks.has(`${project}_default`))
    throw new Error("Selected QA resource names already exist; refusing to reuse containers, retained volumes or networks");
}

export function dockerFailureCategory(stderr = "") {
  if (/no space left|out of memory|cannot allocate memory/i.test(stderr)) return "Docker resource shortage";
  if (/unhealthy|did not become healthy/i.test(stderr)) return "service health check failed";
  if (/failed to resolve|failed to fetch|pull access denied|manifest unknown|TLS handshake timeout/i.test(stderr)) return "image registry or download failed";
  if (/failed to solve|failed to build/i.test(stderr)) return "container build failed";
  if (/pipe|daemon|connection refused|Internal Server Error/i.test(stderr)) return "Docker engine unavailable";
  if (/unknown flag|unknown shorthand|not a docker command/i.test(stderr)) return "Docker command or flag unsupported";
  if (/port is already allocated|address already in use/i.test(stderr)) return "QA loopback port already occupied";
  if (/additional privileges requested/i.test(stderr)) return "Compose build filesystem entitlement unavailable";
  if (/dependency failed to start/i.test(stderr)) return "service startup failed";
  return "Docker command failed";
}

export async function runDockerCommand(args, env, timeout, execute = execFile, platform = process.platform) {
  const options = { env, maxBuffer: 8_000_000, windowsHide: true };
  if (platform !== "win32") return (await promisify(execute)("docker", args, { ...options, timeout })).stdout;
  // Node's Windows timeout kills docker.exe but can orphan its Compose plugin.
  // Keep that parent alive until taskkill can terminate its exact owned tree.
  let child, timer, expired = false;
  const completion = new Promise((resolveResult, reject) => {
    child = execute("docker", args, { ...options, timeout: 0 }, (error, stdout) => {
      if (expired) return;
      if (error) reject(error); else resolveResult(stdout);
    });
  });
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const fail = confirmed => {
        const failure = new Error(confirmed
          ? "Docker command timed out; its task-owned Windows process tree was terminated (credentials suppressed)"
          : "Docker command timed out; task-owned process cleanup was not confirmed. Do not start another QA command until that process is checked locally (credentials suppressed)");
        failure.code = "LCWE_QA_TIMEOUT";
        reject(failure);
      };
      // Never target a PID once this exact ChildProcess is known to have exited.
      if (!Number.isInteger(child?.pid) || child.exitCode !== null || child.signalCode !== null) { fail(false); return; }
      execute("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true }, error => {
        fail(!error);
      });
    }, timeout);
  });
  try { return await Promise.race([completion, expiry]); }
  finally { clearTimeout(timer); }
}

async function docker(args, env, timeout = 30_000) {
  try {
    return await runDockerCommand(args, env, timeout);
  } catch (error) {
    // Compose output/inspection can contain environment credentials. Never echo it.
    if (error.code === "LCWE_QA_TIMEOUT") throw error;
    throw new Error(`${dockerFailureCategory(error.stderr)} during ${args[0]} (exit ${error.code ?? "unknown"}); inspect Docker Desktop locally (credentials suppressed)`);
  }
}

export function assertQaBridgeContainer(container) {
  const settings = container?.Config, labels = settings?.Labels, ports = container?.NetworkSettings?.Ports?.["8080/tcp"];
  const environment = new Map((settings?.Env ?? []).map(item => { const at = item.indexOf("="); return [item.slice(0, at), item.slice(at + 1)]; }));
  if (labels?.["com.docker.compose.project"] !== qaProject || labels?.["com.docker.compose.service"] !== "erpbridge-server" ||
    environment.get("ERP_BASE_URL") !== "http://mock-erp:8081" || !ports?.length ||
    ports.some(port => port.HostIp !== "127.0.0.1" || port.HostPort !== "18080") ||
    !/^[a-f0-9]{64}$/.test(environment.get("API_AUTH_TOKEN") ?? ""))
    throw new Error("Existing container is not the exact loopback MockERP QA bridge; refusing discovery");
  return environment.get("API_AUTH_TOKEN");
}

export async function readQaBridgeToken() {
  const containers = JSON.parse(await docker(["inspect", `${qaProject}-erpbridge-server-1`], process.env));
  if (containers.length !== 1) throw new Error("Expected one exact QA bridge container");
  return assertQaBridgeContainer(containers[0]);
}

async function verifyDiscovery(token) {
  const { createBridgeProtocolAdapter } = await import("../src/tools/erpbridge-protocol-adapter.ts");
  const { RegistryService } = await import("../src/registry/service.ts");
  const { compareErpbridgeRegistry } = await import("../src/tools/erpbridge-registry-compatibility.ts");
  const adapter = createBridgeProtocolAdapter({ baseURL: qaBaseURL, token, timeoutMs: 15_000 });
  try {
    const started = performance.now();
    await adapter.connect();
    const remote = await adapter.listTools(), discoveredMs = Math.round(performance.now() - started);
    const registries = await RegistryService.load(...qaRegistryPaths);
    const report = compareErpbridgeRegistry(registries.snapshot().tools, remote);
    console.log(`Authenticated MCP initialize and complete discovery passed in ${discoveredMs} ms: ${remote.length} tools. Local reviewed registry: ${report.compatible ? "compatible" : "NOT compatible"}.`);
    console.log(`Missing ${report.missing.length}; incompatible ${report.incompatible.length}; unreviewed ${report.unreviewed.length}; duplicate names ${report.duplicateRemoteNames.length}.`);
    console.log("No ERP tools called, no tools auto-admitted, no chat/workflow execution or email delivery claimed.");
    if (!report.compatible) process.exitCode = 2;
  } finally { await adapter.close(); }
}

async function verifyInitialization(token) {
  const { createBridgeProtocolAdapter } = await import("../src/tools/erpbridge-protocol-adapter.ts");
  const adapter = createBridgeProtocolAdapter({ baseURL: qaBaseURL, token, timeoutMs: 15_000 });
  try {
    await adapter.connect();
    console.log("Authenticated MCP initialize passed. Register the explicit synthetic QA read before running --verify; no tools were imported or called.");
  } finally { await adapter.close(); }
}

export async function main(args) {
  const mode = qaMode(args), env = qaEnvironment(process.env);
  if (mode === "--verify") {
    const containers = JSON.parse(await docker(["inspect", `${qaProject}-erpbridge-server-1`], env));
    if (containers.length !== 1) throw new Error("Expected one exact QA bridge container");
    await verifyDiscovery(assertQaBridgeContainer(containers[0]));
    return;
  }
  const directory = await mkdtemp(resolve(tmpdir(), "lcwe-erpbridge-qa-"));
  const emptyEnv = resolve(directory, "empty.env");
  await writeFile(emptyEnv, "", { flag: "wx" });
  const compose = ["compose", "--env-file", emptyEnv, "--project-name", qaProject, "--file", qaCompose];
  try {
    await docker([...compose, "config", "--quiet"], env);
    console.log(`QA Compose validated for ${qaProject}: bridge 127.0.0.1:18080, MockERP 127.0.0.1:18081, Redis internal only.`);
    if (mode === "--check") return;
    const info = (await docker(["info", "--format", "{{.OSType}}"], env)).trim();
    if (info !== "linux") throw new Error("A running Docker Linux engine is required; no stack was started");
    const containers = await docker(["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${qaProject}`], env);
    const volumes = await docker(["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${qaProject}`], env);
    assertEmptyQaProject(containers, volumes);
    // Names also catch old/unlabelled resources which Compose might otherwise reuse.
    const inventory = Object.fromEntries(await Promise.all([
      ["containers", ["ps", "--all", "--format", "{{.Names}}"]],
      ["volumes", ["volume", "ls", "--format", "{{.Name}}"]],
      ["networks", ["network", "ls", "--format", "{{.Name}}"]],
    ].map(async ([kind, args]) => [kind, await docker(args, env)])));
    assertQaResourceNamesAvailable(inventory);
    console.log("Building isolated ERPBridge and waiting for all three service health checks…");
    await docker([...compose, "up", "--detach", "--build", "--wait", "--wait-timeout", "180"], env, 600_000);
    console.log("Docker stack healthy. Checking authenticated initialize with the backend MCP adapter…");
    await verifyInitialization(env.LCWE_QA_BRIDGE_TOKEN);
  } finally {
    await unlink(emptyEnv);
    await rmdir(directory); // exact launcher-owned empty temporary directory only
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
