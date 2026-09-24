import type { ToolDefinition } from "../registry/schemas.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import type { RegistryService } from "../registry/service.js";
import { exactBridgeName, matchesBridgeContract } from "../tools/erpbridge-contract.js";

const CACHE_TTL_MS = 60_000;

type DiscoveryCache = { registryHash: string; generation: number; expiresAt: number; result: Promise<readonly ToolDefinition[]> };
let sessionCaches = new WeakMap<ErpbridgeMcpSession, DiscoveryCache>();

export class ToolDiscoveryError extends Error {
  constructor() { super("ERPBridge tool discovery failed; no tools have been authorized"); this.name = "ToolDiscoveryError"; }
}

/*******************************************************************************
 * Function: discoverTools
 *
 * Loads cached or live ERPBridge tools and enriches them with registry
 * metadata.
 ******************************************************************************/
export async function discoverTools(
  session: ErpbridgeMcpSession | null,
  registries: RegistryService,
): Promise<readonly ToolDefinition[]> {
  if (session === null) return Object.freeze([]);
  if (session.available === false) {
    sessionCaches.delete(session);
    throw new ToolDiscoveryError();
  }
  const registryHash = registries.hash();
  const cached = sessionCaches.get(session);
  const generation = session.discoveryGeneration ?? 0;
  if (cached !== undefined && cached.registryHash === registryHash && cached.generation === generation && cached.expiresAt > Date.now()) return admitted(session, await cached.result);
  const byMcpName = new Map<string, ToolDefinition>();
  for (const tool of registries.snapshot().tools) {
    if (tool.connection_id && tool.connection_id !== (session.connectionId ?? "erpbridge-default")) continue;
    // Discovery is not admission. Legacy entries without identity, role
    // grants, or an explicit usable schema remain unavailable to agents.
    if (!tool.tool_id.trim() || !tool.mcp_tool_name.trim() || tool.allowed_roles.length === 0 || tool.input_schema.type !== "object") continue;
    if (session.requiresReviewedRevision && !tool.bridge_contract) continue;
    const remoteName = exactBridgeName(tool);
    if (byMcpName.has(remoteName)) throw new ToolDiscoveryError();
    byMcpName.set(remoteName, tool);
  }
  const result = (async () => {
    try {
    const liveMcpTools = await session.listTools();
    const merged: ToolDefinition[] = [];
    const names = new Set<string>();
    for (const liveT of liveMcpTools) {
      if (names.has(liveT.name)) throw new ToolDiscoveryError();
      names.add(liveT.name);
      const existing = byMcpName.get(liveT.name);
      if (existing !== undefined && matchesBridgeContract(existing, liveT)) {
        merged.push(existing);
      }
    }
    if ((session.discoveryGeneration ?? 0) !== generation) throw new ToolDiscoveryError();
    return Object.freeze(merged);
    } catch { throw new ToolDiscoveryError(); }
  })();
  const entry = { registryHash, generation, expiresAt: Date.now() + CACHE_TTL_MS, result };
  sessionCaches.set(session, entry);
  try { return await admitted(session, await result); } catch (error) {
    if (sessionCaches.get(session) === entry) sessionCaches.delete(session);
    throw error;
  }
}

// Remote metadata may be cached, but local review/revocation is never cached.
async function admitted(session: ErpbridgeMcpSession, tools: readonly ToolDefinition[]) {
  if (!session.assertAdmission) return tools; // Injected legacy fixtures only.
  const approved: ToolDefinition[] = [];
  for (const tool of tools) {
    try { await session.assertAdmission(tool); approved.push(tool); }
    catch { /* Unreviewed/disabled/binding-changed capabilities are not model tools. */ }
  }
  return Object.freeze(approved);
}

/*******************************************************************************
 * Function: invalidateToolDiscoveryCache
 *
 * Clears the cached tool list so discovery reloads it.
 ******************************************************************************/
export function invalidateToolDiscoveryCache(): void {
  sessionCaches = new WeakMap();
}
