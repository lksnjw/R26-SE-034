import type { ToolDefinition } from "../registry/schemas.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import type { RegistryService } from "../registry/service.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";

const CACHE_TTL_MS = 60_000;

type DiscoveryCache = { registryHash: string; expiresAt: number; result: Promise<readonly ToolDefinition[]> };
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
  const registryHash = registries.hash();
  const cached = sessionCaches.get(session);
  if (cached !== undefined && cached.registryHash === registryHash && cached.expiresAt > Date.now()) return cached.result;
  const byMcpName = new Map<string, ToolDefinition>();
  for (const tool of registries.snapshot().tools) {
    // Discovery is not admission. Legacy entries without identity, role
    // grants, or an explicit usable schema remain unavailable to agents.
    if (!tool.tool_id.trim() || !tool.mcp_tool_name.trim() || tool.allowed_roles.length === 0 || tool.input_schema.type !== "object") continue;
    if (byMcpName.has(tool.mcp_tool_name)) throw new ToolDiscoveryError();
    byMcpName.set(tool.mcp_tool_name, tool);
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
      if (existing !== undefined && canonicalJSONBytes(existing.input_schema).equals(canonicalJSONBytes(liveT.inputSchema))) {
        merged.push(existing);
      }
    }
    return Object.freeze(merged);
    } catch { throw new ToolDiscoveryError(); }
  })();
  const entry = { registryHash, expiresAt: Date.now() + CACHE_TTL_MS, result };
  sessionCaches.set(session, entry);
  try { return await result; } catch (error) {
    if (sessionCaches.get(session) === entry) sessionCaches.delete(session);
    throw error;
  }
}

/*******************************************************************************
 * Function: invalidateToolDiscoveryCache
 *
 * Clears the cached tool list so discovery reloads it.
 ******************************************************************************/
export function invalidateToolDiscoveryCache(): void {
  sessionCaches = new WeakMap();
}
