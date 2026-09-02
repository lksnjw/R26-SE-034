import { Client, StreamableHTTPClientTransport, SdkHttpError } from "@modelcontextprotocol/client";
import type { ErpbridgeMcpSdkClient, ErpbridgeMcpSdkTool } from "./erpbridge-mcp-client.js";
import { boundedMcpFetch } from "./mcp-bounded-fetch.js";

/** Engine-owned adapter: preserve ToolPlane fields absent from SDK 1.1.0's
 * projection. No reconnect/replay, OAuth step-up, sampling or elicitation. */
export function createBridgeProtocolAdapter(options: { baseURL: string; token: string; timeoutMs: number; fetch?: typeof fetch }): ErpbridgeMcpSdkClient {
  const root = new URL(options.baseURL);
  if (!/^https?:$/.test(root.protocol) || root.username || root.password || root.search || root.hash || !["", "/"].includes(root.pathname))
    throw new Error("ERPBridge base URL must be an HTTP(S) host root, not an MCP endpoint or credential-bearing URL");
  const client = new Client({ name: "workflow-engine", version: "1.0.0" }, {
    versionNegotiation: { mode: "legacy" }, // MCP 2025 initialize, not legacy SSE.
    inputRequired: { autoFulfill: false }, listMaxPages: 16,
  });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp/", root), {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` }, redirect: "error" },
    fetch: boundedMcpFetch(options.fetch ?? fetch, options.timeoutMs),
    onInsufficientScope: "throw", maxStepUpRetries: 0,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const listeners = new Set<() => void>();
  client.setNotificationHandler("notifications/tools/list_changed", () => { for (const listener of listeners) listener(); });
  const requestOptions = { timeout: options.timeoutMs };
  return {
    metadataComplete: true,
    connect: () => client.connect(transport, requestOptions),
    close: async () => { try { await transport.close(); } finally { try { await client.close(); } finally { listeners.clear(); } } },
    listTools: async () => {
      // Own pagination: SDK aggregation silently returns a partial inventory
      // on repeated cursors/page exhaustion, which is not complete discovery.
      const tools: ErpbridgeMcpSdkTool[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 16; page++) {
        const result = await client.request({ method: "tools/list", ...(cursor ? { params: { cursor } } : {}) }, requestOptions);
        tools.push(...structuredClone(result.tools) as ErpbridgeMcpSdkTool[]);
        if (tools.length > 2048 || Buffer.byteLength(JSON.stringify(tools)) > 2_000_000) throw new Error("ERPBridge discovery exceeds supported limits");
        if (result.nextCursor === undefined) return tools;
        if (!result.nextCursor || cursors.has(result.nextCursor)) throw new Error("ERPBridge discovery returned an invalid or repeated cursor");
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      throw new Error("ERPBridge discovery exceeds supported page limit");
    },
    // Supplying a descriptor prevents hidden cache/discovery RPCs and header
    // mismatch replay. The engine validates the actual reviewed output schema
    // and preserves failure envelopes before exposing any results.
    callTool: async (name, args, meta) => {
      try { return await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, { ...requestOptions, toolDefinition: { name, inputSchema: { type: "object" } } }); }
      catch (error) {
        // SDK HTTP/protocol exceptions may embed the entire upstream body.
        // Never persist that body via agent error strings or run logs.
        if (error instanceof Error && ["AbortError", "OperationDeadlineExceeded"].includes(error.name)) throw error;
        if (error instanceof SdkHttpError && Number.isInteger(error.data?.status)) throw new Error(`ERPBridge MCP request failed (HTTP ${error.data.status}); the remote outcome is unconfirmed`);
        throw new Error("ERPBridge MCP reply was not confirmed; review the connection and saved evidence before retrying");
      }
    },
    onToolsChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
