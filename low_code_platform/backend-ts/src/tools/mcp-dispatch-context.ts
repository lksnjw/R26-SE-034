import type { AppConfig } from "../config/config.js";
import type { ErpbridgeMcpSession } from "./erpbridge-mcp-client.js";
import type { McpConnectionManager, McpConnectionRuntime } from "./mcp-connection-runtime.js";
import { DEFAULT_BRIDGE_CONNECTION } from "../registry/capability-admission.js";

type DispatchServices = {
  config: AppConfig;
  erpbridgeSession?: ErpbridgeMcpSession | undefined;
  mcpConnectionRuntime?: McpConnectionRuntime | McpConnectionManager | undefined;
};

export type BoundMcpConnection = Readonly<{
  id: string;
  session: ErpbridgeMcpSession;
  roleMap: Readonly<Record<string, string>>;
}>;

export const MCP_CONNECTION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Resolve an authored connection selector without ever accepting a browser or
 * model supplied endpoint/credential. Omitted selectors retain the configured
 * primary for existing single-connection publications. */
export function selectedMcpConnectionId(services: DispatchServices, authored?: string): string {
  const selected = authored?.trim() || services.mcpConnectionRuntime?.primaryConnectionId || services.config.erpbridgePrimaryConnectionId || DEFAULT_BRIDGE_CONNECTION;
  if (!MCP_CONNECTION_ID_PATTERN.test(selected)) throw new Error("Workflow node has an unsupported ERPBridge connection ID");
  if (services.mcpConnectionRuntime && !services.mcpConnectionRuntime.hasConnection(selected)) throw new Error("Workflow node selects an unknown ERPBridge connection");
  return selected;
}

/** Exact server-owned session and role-map lookup used by compilation and SDK
 * entry. A configured connection is not dispatchable unless its own reviewed
 * session is currently connected. */
export function boundMcpConnection(services: DispatchServices, connectionId: string): BoundMcpConnection {
  const id = selectedMcpConnectionId(services, connectionId);
  const runtime = services.mcpConnectionRuntime;
  const session = runtime?.sessionFor(id) ?? (id === selectedMcpConnectionId(services) ? services.erpbridgeSession : undefined);
  const roleMap = runtime?.roleMapFor(id) ?? (id === selectedMcpConnectionId(services) ? services.config.erpbridgeRoleMap : undefined);
  if (!session || session.available === false || !roleMap) throw new Error(`ERPBridge connection ${id} is not connected for dispatch`);
  return Object.freeze({ id, session, roleMap: Object.freeze({ ...roleMap }) });
}

/** Composite key prevents the same registry tool ID on two MCP connections
 * from overwriting the other connection's reviewed admission pin. */
export function connectionToolKey(connectionId: string, toolId: string): string {
  return `${connectionId}\u0000${toolId}`;
}
