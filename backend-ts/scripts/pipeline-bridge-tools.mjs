import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const manifests = resolve(dirname(fileURLToPath(import.meta.url)), "../../ops/erpbridge/manifests/data-transformation");

export function pipelineOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Pipeline URL must be an HTTP(S) service origin without credentials or path");
  return url.origin;
}

/** Bind each tool to its separately deployed pipeline. ERP_BASE_URL is
 * deliberately not used: it belongs to the bridge's other ERP connections. */
export async function pipelineTools(origin) {
  const base = pipelineOrigin(origin);
  const files = (await readdir(manifests)).filter(name => name.endsWith(".yaml")).sort();
  return Promise.all(files.map(async file => {
    const tool = parse(await readFile(resolve(manifests, file), "utf8"));
    tool.spec.execution.endpoint = `${base}${tool.spec.execution.endpoint}`;
    tool.spec.execution.approvedOrigins = [base];
    return tool;
  }));
}

export async function applyPipelineTools({bridgeURL, pipelineURL, token}) {
  const base = pipelineOrigin(bridgeURL), tools = await pipelineTools(pipelineURL);
  if (!token?.trim()) throw new Error("ERPBridge administration token is required");
  const applied = [];
  for (const tool of tools) {
    const response = await fetch(`${base}/apis/erpbridge.io/v1/tools`, {
      method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify(tool), redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Pipeline tool apply failed: ${tool.metadata.name} HTTP ${response.status}`);
    await response.body?.cancel();
    const query = new URLSearchParams({name: tool.metadata.name, version: tool.metadata.version});
    const readback = await fetch(`${base}/apis/erpbridge.io/v1/tools?${query}`, {
      headers: {Authorization: `Bearer ${token}`}, redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!readback.ok) throw new Error("Pipeline tool readback failed");
    const saved = await readback.json();
    if (!Array.isArray(saved) || saved.length !== 1 ||
        saved[0].spec.execution.endpoint !== tool.spec.execution.endpoint ||
        saved[0].spec.security.authHeader !== "X-API-Key" ||
        !/^[a-f0-9]{64}$/.test(saved[0].metadata.resourceDigest ?? ""))
      throw new Error("Persisted pipeline tool binding is not confirmed");
    applied.push(saved[0]);
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== "--apply") throw new Error("Use --apply with PIPELINE_RETRIEVAL_BASE_URL, ERPBRIDGE_BASE_URL and BRIDGE_API_TOKEN");
    const applied = await applyPipelineTools({bridgeURL: process.env.ERPBRIDGE_BASE_URL,
      pipelineURL: process.env.PIPELINE_RETRIEVAL_BASE_URL, token: process.env.BRIDGE_API_TOKEN});
    console.log(`Applied and read back ${applied.length} pipeline tools with explicit downstream origins. Application capability review is still required.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
