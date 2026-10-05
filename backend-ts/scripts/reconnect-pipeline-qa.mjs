// Reinitialize the existing synthetic QA app after its separately deployed bridge restarts.
import {randomUUID} from "node:crypto";
const base = "http://127.0.0.1:18082/api";
const login = await fetch(`${base}/auth/login`, {method: "POST", headers: {"Content-Type": "application/json"},
  body: JSON.stringify({email: "pipeline.qa@example.test", password: "Pipeline-QA-2026!"})});
if (!login.ok) throw new Error(`QA login failed: HTTP ${login.status}`);
const token = (await login.json()).data.accessToken;
async function request(path, body) {
  const response = await fetch(`${base}${path}`, {method: body === undefined ? "GET" : "POST",
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60000)});
  const value = await response.json();
  if (!response.ok) throw new Error(`QA connection operation failed: HTTP ${response.status}`);
  return value.data;
}
const status = await request("/settings/mcp-connections");
if (process.argv.includes("--inspect")) {
  const catalog = await request("/registry/capabilities");
  console.log(JSON.stringify(catalog.capabilities.map(item => ({name: item.revision?.definition?.display_name,
    state: item.effectiveState, reason: item.reviewReason})), null, 2));
} else if (process.argv.includes("--review")) {
  const catalog = await request("/registry/capabilities");
  const known = new Set(["search_indexed_erp_data", "retrieve_indexed_erp_data", "get_indexed_representation",
    "get_canonical_erp_record", "discover_indexed_erp_sources"]);
  const observations = (await request("/registry/capabilities/discovery", {})).observations;
  for (const item of catalog.capabilities) {
    const revision = item.revision;
    if (!revision || !known.has(revision.definition.display_name) || revision.policy.effectClass !== "read") continue;
    const observation = observations.find(value => value.capabilityId === item.capabilityId && value.contractHash === revision.contractHash && value.remoteMatches);
    if (!observation) throw new Error("QA contract changed; refusing automatic re-review");
    const result = await request(`/registry/capabilities/${item.capabilityId}/review`, {observationId: observation.id,
      contractHash: observation.contractHash, decisionKey: `pipeline-qa-restore-${randomUUID()}`, ...revision.policy,
      note: "User-authorized local synthetic QA: identical previously reviewed read-only contract restored after Docker/bridge restart."});
    console.log(JSON.stringify({name: revision.definition.display_name, state: result.admission.state}));
  }
} else for (const connection of status.connections) {
  const result = await request(`/settings/mcp-connections/${encodeURIComponent(connection.id)}/connect`,
    {baseRevision: connection.revision, requestId: `pipeline-qa-reconnect-${randomUUID()}`});
  console.log(JSON.stringify(result));
}
