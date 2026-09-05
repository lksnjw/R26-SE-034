import { createBridgeProtocolAdapter } from "./erpbridge-protocol-adapter.js";
import { exactBridgeName, hasReservedBridgeRole } from "./erpbridge-contract.js";
import { validateToolInput } from "./tool-input-schema.js";
import { safeMcpResult, MCP_RESULT_BYTES } from "./mcp-result.js";
import { createHash } from "node:crypto";
import { boundedOperation } from "../core/bounded-operation.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type {
  DispatchCapability,
  RegistryValidator,
} from "../validator/registry-validator.js";
import type { DispatchIdentity } from "./registry.js";
import type { GovernedMCPClient } from "./mcp-client.js";
import type { McpNotificationState } from "./mcp-notification-stream.js";
import type { ReadAdmissionPin } from "../workflows/compiled-read.js";

export type ErpbridgeMcpSdkTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type ErpbridgeMcpSdkClient = Readonly<{
  connect(): Promise<void>;
  close(): Promise<void>;
  metadataComplete?: boolean;
  available?: boolean;
  notificationState?: McpNotificationState | undefined;
  callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<readonly ErpbridgeMcpSdkTool[]>;
  onToolsChanged?(listener: () => void): () => void;
}>;

export type ErpbridgeMcpSession = Readonly<{
  available?: boolean;
  notificationState?: McpNotificationState | undefined;
  requiresReviewedRevision?: boolean;
  discoveryGeneration?: number;
  // Internal opaque binding only; never expose endpoint credentials in runs.
  admissionBinding?: string;
  /** Supports a server checkpoint after all awaited review work, at SDK entry. */
  dispatchBoundary?: "sdk-entry/v1";
  assertAdmission?(definition: ToolDefinition, expectedPin?: ReadAdmissionPin, signal?: AbortSignal): Promise<void>;
  clientFor(definition: ToolDefinition, expectedPin?: ReadAdmissionPin): GovernedMCPClient;
  callToolDirect(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  listTools(signal?: AbortSignal): Promise<readonly ErpbridgeMcpSdkTool[]>;
  close(): Promise<void>;
}>;

export class ErpbridgeMcpToolError extends Error {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a ErpbridgeMcpToolError instance with its required state.
   ******************************************************************************/
  constructor(readonly result: Record<string, unknown>) {
    super("MCP tool failed");
    this.name = "ErpbridgeMcpToolError";
  }
}

/*******************************************************************************
 * Function: createErpbridgeMcpSession
 *
 * Connects an ERPBridge MCP session and exposes its tool client adapters.
 ******************************************************************************/
export async function createErpbridgeMcpSession(options: {
  baseURL: string;
  token: string;
  timeoutMs: number;
  validator: RegistryValidator;
  sdkClient?: ErpbridgeMcpSdkClient;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  admissionAuthorizer?: (definition: ToolDefinition, connectionBinding: string, expectedPin?: ReadAdmissionPin) => Promise<void>;
  // Trusted backend lifecycle revision, never a model/client argument.
  connectionRevision?: string;
}): Promise<ErpbridgeMcpSession> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)
    throw new Error("ERPBridge MCP timeout must be a positive supported integer");
  const admissionBinding = createHash("sha256").update(JSON.stringify(options.connectionRevision === undefined ? [options.baseURL.trim(), options.token] : [options.baseURL.trim(), options.token, options.connectionRevision])).digest("hex");
  const sdkClient =
    options.sdkClient ??
    createBridgeProtocolAdapter({
      baseURL: options.baseURL,
      token: options.token,
      timeoutMs: options.timeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  let discoveryGeneration = 0;
  const unsubscribe = sdkClient.onToolsChanged?.(() => { discoveryGeneration++; });
  let closed = false;
  const unavailable = () => closed || sdkClient.available === false;
  let closePromise: Promise<void> | undefined;
  const lifecycle = new AbortController();
  const cleanup = () => boundedOperation(() => sdkClient.close(), {
    timeoutMs: Math.min(options.timeoutMs, 1_000), label: "ERPBridge MCP cleanup",
  });
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    unsubscribe?.();
    lifecycle.abort();
    closePromise = cleanup();
    return closePromise;
  };
  const abandon = () => { if (!closed) void close().catch(() => {}); };
  const run = <T>(label: string, start: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (unavailable()) return Promise.reject(new Error("ERPBridge MCP session is closed or unavailable"));
    return boundedOperation(start, {
      timeoutMs: options.timeoutMs, label,
      signal: signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal,
      onAbandon: abandon,
      // The SDK does not expose a request signal. A late initialize can create
      // resources after the first close; clean those up without admitting reuse.
      onLateSettlement: () => { if (closed) void cleanup().catch(() => {}); },
    });
  };
  try { await run("ERPBridge MCP initialization", () => sdkClient.connect(), options.signal); }
  catch (error) { void close().catch(() => {}); throw error; }
  const assertAdmission = async (definition: ToolDefinition, expectedPin?: ReadAdmissionPin, signal?: AbortSignal): Promise<void> => {
    if (unavailable()) throw new Error("ERPBridge MCP session is closed or unavailable");
    if (sdkClient.metadataComplete && !options.admissionAuthorizer) throw new Error("Explicit persisted capability admission is required before ERP dispatch");
    if (options.admissionAuthorizer) await run("ERPBridge capability admission", () => options.admissionAuthorizer!(definition, admissionBinding, expectedPin), signal);
    if (unavailable()) throw new Error("ERPBridge MCP session is closed or unavailable");
  };
  return Object.freeze({
    get available() { return !closed && sdkClient.available !== false; },
    get notificationState() { return sdkClient.notificationState; },
    get discoveryGeneration() { return discoveryGeneration; },
    requiresReviewedRevision: sdkClient.metadataComplete === true,
    admissionBinding,
    dispatchBoundary: "sdk-entry/v1" as const,
    assertAdmission,
    /*******************************************************************************
     * Function: clientFor
     *
     * Creates a governed client for the selected ERPBridge tool definition.
     ******************************************************************************/
    clientFor: (definition: ToolDefinition, expectedPin?: ReadAdmissionPin) =>
      createToolClient(async (name, args, signal, beforeDispatch, authorize) => {
        if (sdkClient.metadataComplete && !definition.bridge_contract) throw new Error("ERPBridge tool has no reviewed immutable revision");
        if (sdkClient.metadataComplete || options.admissionAuthorizer) await assertAdmission(definition, expectedPin, signal);
        if (beforeDispatch) await run("ERPBridge dispatch checkpoint", beforeDispatch, signal);
        // Discovery admits a reviewed immutable identity. Dispatch pins both
        // exact name and digest; the bridge owns the final active/origin check.
        // An extra tools/list here would add latency without granting authority.
        return run("ERPBridge MCP tool call", () => {
          // No awaited policy/storage work between one-use capability consumption
          // and SDK entry. Its registry/identity/argument/expiry checks are fresh.
          authorize();
          return definition.bridge_contract
            ? sdkClient.callTool(name, args, { "toolplane.resourceDigest": definition.bridge_contract.resource_digest })
            : sdkClient.callTool(name, args);
        }, signal);
      }, options.validator, definition, () => closed || sdkClient.available === false),
    /*******************************************************************************
     * Function: callToolDirect
     *
     * Calls a named tool directly through the connected ERPBridge SDK session.
     ******************************************************************************/
    callToolDirect: async (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      if (closed) throw new Error("ERPBridge MCP session is closed");
      let definition: ToolDefinition | undefined;
      if (sdkClient.metadataComplete) {
        // This private path is for optional/required policy evaluation only,
        // never a model-facing bypass around the governed business broker.
        if (!["check_policy", "policy-gate-evaluate", "policy-gate-assist"].includes(toolName)) throw new Error("Direct ERPBridge business dispatch is not allowed");
        const matches = options.validator.registries.snapshot().tools.filter(t => t.mcp_tool_name === toolName);
        definition = matches.length === 1 ? matches[0] : undefined;
        if (!definition?.bridge_contract || !definition.is_read_only || hasReservedBridgeRole(definition) || validateToolInput(definition.input_schema, args).length)
          throw new Error("ERPBridge policy tool requires a reviewed read-only unguarded contract and valid arguments");
      }
      const admitted = definition;
      if (admitted) await assertAdmission(admitted, undefined, signal);
      const result = await run("ERPBridge MCP direct tool call", () => admitted?.bridge_contract
        ? sdkClient.callTool(exactBridgeName(admitted), args, { "toolplane.resourceDigest": admitted.bridge_contract.resource_digest })
        : sdkClient.callTool(toolName, args), signal);
      const envelope = boundResult(result, admitted);
      if (envelope.isError === true) throw new ErpbridgeMcpToolError(envelope);
      return envelope;
    },
    /*******************************************************************************
     * Function: listTools
     *
     * Retrieves tool definitions from the connected ERPBridge MCP session.
     ******************************************************************************/
    listTools: (signal?: AbortSignal) => run("ERPBridge MCP tool discovery", () => sdkClient.listTools(), signal),
    close,
  });
}

/*******************************************************************************
 * Function: createToolClient
 *
 * Builds an ERPBridge client that checks dispatch capability and role
 * access.
 ******************************************************************************/
function createToolClient(
  callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, beforeDispatch: (() => Promise<void>) | undefined, authorize: () => void) => Promise<unknown>,
  validator: RegistryValidator,
  definition: ToolDefinition,
  isClosed: () => boolean,
): GovernedMCPClient {
  const remoteName = exactBridgeName(definition);
  const guarded = hasReservedBridgeRole(definition);
  return Object.freeze({
    /*******************************************************************************
     * Function: execute
     *
     * Verifies dispatch authority and calls the mapped ERPBridge tool.
     ******************************************************************************/
    async execute(
      action: string,
      capability: DispatchCapability,
      parameters: Record<string, unknown>,
      identity: DispatchIdentity,
      signal?: AbortSignal,
      beforeDispatch?: () => Promise<void>,
      assertDispatch?: () => void,
    ): Promise<Record<string, unknown>> {
      if (signal?.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError");
      // Caller mutation while admission/checkpoint awaits must not change the
      // bytes authorized or the role injected into the eventual SDK call.
      parameters = structuredClone(parameters); identity = structuredClone(identity);
      const parameterBytes = canonicalJSONBytes(parameters);
      if (isClosed()) throw new Error("ERPBridge MCP session is closed");
      if (definition.bridge_contract && guarded && !definition.bridge_contract.remote_roles.includes(identity.erpbridgeRole ?? ""))
        throw new Error("Mapped role is not in the reviewed remote tool allow-list");
      if (guarded && Object.hasOwn(parameters, "role"))
        throw new Error(
          "workflow-provided role is not allowed for a guarded ERPBridge tool",
        );
      if (guarded && identity.erpbridgeRole === null)
        throw new Error(
          "guarded ERPBridge tool requires a mapped ERPBridge role",
        );
      if (
        (definition.bridge_contract !== undefined || definition.allowed_roles.length > 0) && !localRoleAllowed(identity.localRole, definition.allowed_roles)
      )
        throw new Error(
          "dispatch identity local role is not allowed for this ERPBridge tool",
        );
      const args = guarded
        ? { ...parameters, role: identity.erpbridgeRole! }
        : { ...parameters };
      const result = await callTool(remoteName || action, args, signal, beforeDispatch, () => {
        if (signal?.aborted || isClosed()) throw new Error("ERPBridge dispatch was cancelled or disconnected");
        assertDispatch?.();
        validator.verifyAndConsumeCapability(capability, action, parameterBytes, identity);
      });
      const envelope = boundResult(result, definition);
      if (envelope.isError === true) throw new ErpbridgeMcpToolError(envelope);
      return envelope;
    },
  });
}

function boundResult(result: unknown, definition?: ToolDefinition): Record<string, unknown> {
  const envelope = safeMcpResult(result, definition?.bridge_contract?.output_schema);
  if (definition?.bridge_contract) {
    const contract = definition.bridge_contract;
    // Locally recorded request provenance, not a server-signed effect receipt.
    envelope._meta = { ...(envelope._meta as Record<string, unknown> | undefined), "io.workflow-engine/dispatch": {
      remoteName: exactBridgeName(definition), resourceVersion: contract.resource_version, resourceDigest: contract.resource_digest,
    } };
    if (Buffer.byteLength(JSON.stringify(envelope)) > MCP_RESULT_BYTES) throw new Error("ERPBridge receipt exceeds supported byte limit; remote outcome requires review");
  }
  return envelope;
}

/*******************************************************************************
 * Function: localRoleAllowed
 *
 * Checks whether a normalized local role is in the allowed role list.
 ******************************************************************************/
function localRoleAllowed(role: string, allowed: readonly string[]): boolean {
  const normalized = normalizeRole(role);
  return allowed.some((item) => normalizeRole(item) === normalized);
}

/*******************************************************************************
 * Function: normalizeRole
 *
 * Normalizes a role name for comparison in this module.
 ******************************************************************************/
function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[ -]/g, "_");
}
