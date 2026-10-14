import type { MCPTransport } from "../config/config.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { GenericMCPTool } from "./generic-mcp-tool.js";
import type { GovernedMCPClient } from "./mcp-client.js";
import { ToolRegistry } from "./registry.js";

type ToolSource = Readonly<{
  snapshot(): Readonly<{ tools: readonly ToolDefinition[] }>;
  onToolUpsert(callback: (tool: ToolDefinition) => void): () => void;
}>;

export type ExecutorToolBoundary = Readonly<{
  registry: ToolRegistry;
  close(): void;
}>;

/**
 * Builds the tool surface for the old sequential executor.
 *
 * Modern ERPBridge execution is deliberately absent here. A generic executor
 * has no immutable connection/admission pin and therefore cannot safely choose
 * between multiple ERPBridge sessions. Published reads and approved operations
 * reach the SDK only through their compiled, connection-bound brokers.
 *
 * The legacy bridge adapter remains available for local/mock compatibility. Its
 * remote production profile is rejected separately by capability admission.
 */
export function createExecutorToolBoundary(input: Readonly<{
  transport: MCPTransport;
  tools: ToolSource;
  legacyClient: GovernedMCPClient | null;
}>): ExecutorToolBoundary {
  const registry = new ToolRegistry();
  if (input.transport === "erpbridge-mcp")
    return Object.freeze({ registry, close: () => undefined });
  const legacyClient = input.legacyClient;
  if (legacyClient === null)
    throw new Error("legacy bridge executor requires a governed MCP client");

  const register = (definition: ToolDefinition) => registry.register(
    new GenericMCPTool(definition.name, definition.description, legacyClient),
  );
  for (const definition of input.tools.snapshot().tools) register(definition);
  const unsubscribe = input.tools.onToolUpsert(register);
  return Object.freeze({ registry, close: unsubscribe });
}
