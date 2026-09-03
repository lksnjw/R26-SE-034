import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundedOperation, OperationDeadlineExceeded } from "../core/bounded-operation.js";
import type { AppConfig } from "../config/config.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import type { RegistryService } from "../registry/service.js";
import type { RegistryValidator } from "../validator/registry-validator.js";
import { admissionAuthorizer, DEFAULT_BRIDGE_CONNECTION } from "../registry/capability-admission.js";
import { assertActorAuthority } from "../http/handlers/model-selection.js";
import { appendAudit, HandlerFailure, nextID, now, type CurrentUser } from "../http/handlers/common.js";
import { createErpbridgeMcpSession, type ErpbridgeMcpSession } from "./erpbridge-mcp-client.js";
import type { FastifyRequest } from "fastify";

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const recordSchema = z.object({ id: z.literal(DEFAULT_BRIDGE_CONNECTION), revision: z.number().int().positive(), desiredEnabled: z.boolean(), configurationHash: hash, updatedAt: z.string().datetime() }).strict();
const operationSchema = z.object({ id: z.string(), actorId: z.string(), action: z.enum(["connect", "disconnect", "test"]), scope: hash, requestHash: hash,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  revision: z.number().int().positive(), state: z.enum(["RUNNING", "DONE", "FAILED", "INTERRUPTED"]), startedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
  reason: z.enum(["MCP_OPERATION_FAILED", "MCP_WAIT_TIMEOUT", "MCP_OPERATION_INTERRUPTED", "MCP_ACTOR_REVOKED", "MCP_STORAGE_UNCERTAIN"]).optional(), discoveryCount: z.number().int().nonnegative().optional() }).strict();
export const connectionCommandSchema = z.object({ baseRevision: z.number().int().positive(), requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict();
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
const publicOperation = (raw: unknown) => { const { scope: _scope, requestHash: _hash, ...value } = operationSchema.parse(raw); return value; };
type Operation = z.infer<typeof operationSchema>;
type ConnectionRecord = z.infer<typeof recordSchema>;
type RuntimeState = "UNCONFIGURED" | "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "STORAGE_UNSUPPORTED" | "STORAGE_UNCERTAIN" | "STOPPED";
type SessionFactory = typeof createErpbridgeMcpSession;
type RuntimeOptions = { repository: Repository; registries: RegistryService; validator: RegistryValidator; config: AppConfig; factory?: SessionFactory };

/** One backend-owned environment-backed modern connection. This is not a
 * generic URL registry: browser/model supplied endpoints and credentials are
 * rejected. No business call, automatic reconnect loop, or tool grant here. */
export class McpConnectionRuntime {
  #session: ErpbridgeMcpSession | undefined;
  #state: RuntimeState = "DISCONNECTED";
  #controller: AbortController | undefined;
  #epoch = 0;
  #stopped = false;
  #revision = 0;
  #probeBusy = false;
  #probeController: AbortController | undefined;
  readonly #configurationHash: string;
  readonly #configured: boolean;
  private constructor(readonly options: RuntimeOptions) {
    const config = options.config;
    this.#configured = config.mcpTransport === "erpbridge-mcp" && Boolean(config.erpbridgeBaseURL && config.erpbridgeMcpToken);
    if (this.#configured) validateOwnedConfiguration(config);
    this.#configurationHash = digest([config.mcpTransport, config.erpbridgeBaseURL, config.erpbridgeMcpToken, config.erpbridgeRoleMap]);
  }
  static async open(options: RuntimeOptions) {
    const runtime = new McpConnectionRuntime(options);
    if (!runtime.supportedStorage()) { runtime.#state = "STORAGE_UNSUPPORTED"; return runtime; }
    const record = await options.repository.mutate(state => {
      const old = state.mcpConnections[DEFAULT_BRIDGE_CONNECTION];
      let value: ConnectionRecord = old ? recordSchema.parse(old) : { id: DEFAULT_BRIDGE_CONNECTION, revision: 1, desiredEnabled: false, configurationHash: runtime.#configurationHash, updatedAt: now() };
      // No stored live socket is trusted after a process restart. Interrupted
      // admin operations require an explicit new decision, not auto-completion.
      let interrupted = false;
      for (const raw of Object.values(state.mcpConnectionOperations)) {
        const operation = operationSchema.parse(raw);
        if (operation.state === "RUNNING") { state.mcpConnectionOperations[operation.id] = { ...operation, state: "INTERRUPTED", reason: "MCP_OPERATION_INTERRUPTED", completedAt: now() }; if (operation.action !== "test") interrupted = true; }
      }
      if (interrupted || value.configurationHash !== runtime.#configurationHash) value = { ...value, revision: value.revision + 1, desiredEnabled: false, configurationHash: runtime.#configurationHash, updatedAt: now() };
      state.mcpConnections[DEFAULT_BRIDGE_CONNECTION] = value;
      return value;
    });
    runtime.#revision = record.revision; runtime.#state = runtime.#configured ? "DISCONNECTED" : "UNCONFIGURED";
    // Persisted enabled intent may restore only the same configured revision.
    // This is initialize/discovery, never replay of a business operation.
    if (runtime.#configured && record.desiredEnabled) await runtime.restore(record);
    return runtime;
  }
  get session(): ErpbridgeMcpSession | undefined {
    if (this.#state !== "CONNECTED" || this.#stopped || this.#session?.available === false) return undefined;
    return this.#session;
  }
  private supportedStorage() { return this.options.repository.persistence === null || this.options.repository.persistence.readQueueDurability === "encrypted-single-writer"; }
  private requireStorage() { if (!this.supportedStorage()) throw new HandlerFailure(503, "MCP lifecycle requires supported single-writer storage", { code: "MCP_STORAGE_UNSUPPORTED" }); }
  private authority(state: Readonly<RepositoryState>, user: CurrentUser, mutation: boolean) {
    const permissions = assertActorAuthority(state, user);
    if (!permissions.includes("settings:manage") || (mutation && user.role !== "Platform Admin")) throw new HandlerFailure(403, "Current Platform Admin settings authority is required for MCP lifecycle changes", { code: "MCP_ADMIN_REQUIRED" });
  }
  private invalidate(next: RuntimeState) {
    this.#epoch++; this.#state = next; this.#controller?.abort(); this.#controller = undefined;
    this.#probeController?.abort(); this.#probeController = undefined;
    const old = this.#session; this.#session = undefined;
    if (old) void this.dispose(old);
  }
  private async dispose(session: ErpbridgeMcpSession) {
    try { await boundedOperation(() => session.close(), { timeoutMs: Math.min(1000, this.options.config.mcpTimeoutMs), label: "MCP session disposal" }); } catch { /* fenced locally even if remote cleanup is unknown */ }
  }
  private async assertRevision(revision: number, epoch: number) {
    if (this.#stopped || epoch !== this.#epoch || this.#state !== "CONNECTED") throw new Error("MCP connection was superseded or disconnected");
    await this.options.repository.readAuthoritative(state => {
      const record = recordSchema.parse(state.mcpConnections[DEFAULT_BRIDGE_CONNECTION]);
      if (!record.desiredEnabled || record.revision !== revision || record.configurationHash !== this.#configurationHash) throw new Error("MCP connection authority changed");
    });
    if (this.#stopped || epoch !== this.#epoch || this.#state !== "CONNECTED") throw new Error("MCP connection changed during admission");
  }
  private async initialize(revision: number, epoch: number, controller: AbortController) {
    const { config, repository, registries, validator } = this.options;
    let candidate: ErpbridgeMcpSession | undefined;
    const authorizer = admissionAuthorizer(repository, registries);
    return boundedOperation(async () => {
      candidate = await (this.options.factory ?? createErpbridgeMcpSession)({ baseURL: config.erpbridgeBaseURL, token: config.erpbridgeMcpToken,
        timeoutMs: config.mcpTimeoutMs, validator, signal: controller.signal, connectionRevision: `${DEFAULT_BRIDGE_CONNECTION}:${revision}`,
        admissionAuthorizer: async (definition, binding) => { await this.assertRevision(revision, epoch); await authorizer(definition, binding); await this.assertRevision(revision, epoch); } });
      if (controller.signal.aborted || epoch !== this.#epoch || this.#stopped) { await this.dispose(candidate); throw new Error("MCP initialization superseded"); }
      if (candidate.available === false || candidate.requiresReviewedRevision !== true || !/^[a-f0-9]{64}$/.test(candidate.admissionBinding ?? "")) throw new Error("Unsupported initialized MCP profile");
      const generation = candidate.discoveryGeneration ?? 0;
      const tools = await candidate.listTools(controller.signal);
      if (tools.length > 2048 || canonicalJSONBytes(tools).length > 2000000 || tools.some(tool => !tool.name?.trim() || tool.name.length > 256) || new Set(tools.map(tool => tool.name)).size !== tools.length || generation !== (candidate.discoveryGeneration ?? 0)) throw new Error("Incomplete or changed MCP inventory");
      return { session: candidate, discoveryCount: tools.length };
    }, { timeoutMs: config.mcpTimeoutMs, label: "MCP initialize and discovery", signal: controller.signal,
      onAbandon: () => { controller.abort(); if (candidate) void this.dispose(candidate); },
      onLateSettlement: () => { if (candidate) void this.dispose(candidate); } }).catch(async error => { if (candidate) await this.dispose(candidate); throw error; });
  }
  private async restore(record: ConnectionRecord) {
    this.#state = "CONNECTING"; const epoch = ++this.#epoch, controller = new AbortController(); this.#controller = controller;
    let initialized: Awaited<ReturnType<McpConnectionRuntime["initialize"]>> | undefined;
    try {
      initialized = await this.initialize(record.revision, epoch, controller);
      await this.options.repository.readAuthoritative(state => { const current = recordSchema.parse(state.mcpConnections[record.id]); if (!current.desiredEnabled || current.revision !== record.revision) throw new Error("MCP restore superseded"); });
      if (epoch !== this.#epoch || this.#stopped) { await this.dispose(initialized.session); return; }
      this.#session = initialized.session; this.#state = "CONNECTED";
    } catch { if (initialized) await this.dispose(initialized.session); if (epoch === this.#epoch) this.invalidate("DEGRADED"); }
  }
  private view(record: ConnectionRecord | null) {
    const state = this.#stopped ? "STOPPED" : this.#state === "CONNECTED" && (this.#session?.available === false || !record?.desiredEnabled || record.revision !== this.#revision || record.configurationHash !== this.#configurationHash) ? "DEGRADED" : this.#state;
    const canInitialize = this.#configured && this.supportedStorage() && !this.#stopped && this.#state !== "CONNECTING" && !this.#probeBusy;
    return { id: DEFAULT_BRIDGE_CONNECTION, transport: "erpbridge-mcp", configurationSource: "backend-environment", configured: this.#configured,
      revision: record?.revision ?? this.#revision, desiredEnabled: record?.desiredEnabled ?? false, state,
      initialized: state === "CONNECTED" && Boolean(this.session), discoveryAvailable: state === "CONNECTED" && Boolean(this.session), qualification: "Initialization/discovery only; not live ERP tool authorization or delivery",
      persistence: !this.supportedStorage() ? "unsupported" : this.options.repository.persistence === null ? "memory-only" : "durable-single-writer",
      operationInProgress: this.#probeBusy || this.#state === "CONNECTING",
      supports: { connect: canInitialize, test: canInitialize, disconnect: this.supportedStorage() && !this.#stopped },
      configurationChange: "Endpoint/secret rotation requires backend configuration and restart; re-review after connection revision changes" };
  }
  async status(user: CurrentUser) {
    return this.options.repository.readAuthoritative(state => {
      this.authority(state, user, false);
      const raw = state.mcpConnections[DEFAULT_BRIDGE_CONNECTION]; const record = raw ? recordSchema.parse(raw) : null;
      return { connections: [this.view(record)], recentOperations: Object.values(state.mcpConnectionOperations).reverse().slice(0, 10).map(publicOperation) };
    });
  }
  async command(action: "connect" | "disconnect" | "test", user: CurrentUser, body: unknown, request?: FastifyRequest) {
    this.requireStorage();
    const parsed = connectionCommandSchema.safeParse(body);
    if (!parsed.success) throw new HandlerFailure(400, "Provide current connection revision and stable request ID only", { code: "MCP_COMMAND_INVALID" });
    const data = parsed.data, scope = digest([user.id, DEFAULT_BRIDGE_CONNECTION, action, data.requestId]), requestHash = digest(data);
    let transitionStarted = false;
    const claimed = await this.options.repository.mutate(state => {
      this.authority(state, user, true);
      const previous = Object.values(state.mcpConnectionOperations).find(raw => raw.scope === scope);
      const record = recordSchema.parse(state.mcpConnections[DEFAULT_BRIDGE_CONNECTION]);
      if (previous) { const operation = operationSchema.parse(previous); if (operation.requestHash !== requestHash) throw new HandlerFailure(409, "Request ID belongs to different connection input", { code: "MCP_REQUEST_CONFLICT" }); return { operation, record, duplicate: true }; }
      if (this.#stopped) throw new HandlerFailure(503, "MCP runtime stopped", { code: "MCP_RUNTIME_STOPPED" });
      if (record.revision !== data.baseRevision) throw new HandlerFailure(409, "Connection revision changed; reload before a new operation", { code: "MCP_REVISION_CONFLICT" });
      if (action !== "disconnect" && !this.#configured) throw new HandlerFailure(503, "Configure the backend ERPBridge endpoint and credential reference first", { code: "MCP_NOT_CONFIGURED" });
      if (action !== "disconnect" && (this.#state === "CONNECTING" || this.#probeBusy)) throw new HandlerFailure(409, "A bounded MCP initialization/test is already in progress", { code: "MCP_OPERATION_IN_PROGRESS" });
      if (Object.keys(state.mcpConnectionOperations).length >= 1000) throw new HandlerFailure(429, "MCP operation history retention limit reached", { code: "MCP_HISTORY_LIMIT" });
      const updated = action === "test" ? record : { ...record, revision: record.revision + 1, desiredEnabled: action === "connect", updatedAt: now() };
      const operation: Operation = { id: nextID(state, "mcpop"), actorId: user.id, action, scope, requestHash, requestId: data.requestId, revision: updated.revision, state: "RUNNING", startedAt: now() };
      transitionStarted = true;
      if (action !== "test") { this.invalidate(action === "connect" ? "CONNECTING" : "DISCONNECTED"); this.#revision = updated.revision; }
      else this.#probeBusy = true;
      state.mcpConnections[DEFAULT_BRIDGE_CONNECTION] = updated; state.mcpConnectionOperations[operation.id] = operation;
      appendAudit(state, user, `mcp.${action}.requested`, "connection", DEFAULT_BRIDGE_CONNECTION, { revision: record.revision }, { operationId: operation.id, revision: updated.revision }, request);
      return { operation, record: updated, duplicate: false };
    }).catch(error => { if (transitionStarted || !(error instanceof HandlerFailure)) this.invalidate("STORAGE_UNCERTAIN"); if (transitionStarted) this.#probeBusy = false; throw error; });
    if (claimed.duplicate) return { operation: publicOperation(claimed.operation), connection: this.view(claimed.record), duplicate: true };
    const epoch = this.#epoch, controller = new AbortController();
    if (action === "connect") this.#controller = controller;
    if (action === "test") this.#probeController = controller;
    let initialized: Awaited<ReturnType<McpConnectionRuntime["initialize"]>> | undefined;
    try {
      if (action !== "disconnect") initialized = await this.initialize(claimed.record.revision, epoch, controller);
      const completed = await this.options.repository.mutate(state => {
        this.authority(state, user, true);
        const record = recordSchema.parse(state.mcpConnections[DEFAULT_BRIDGE_CONNECTION]);
        if (record.revision !== claimed.record.revision || epoch !== this.#epoch || this.#stopped) throw new HandlerFailure(409, "MCP operation superseded", { code: "MCP_OPERATION_INTERRUPTED" });
        const operation = operationSchema.parse(state.mcpConnectionOperations[claimed.operation.id]);
        if (operation.state !== "RUNNING") throw new Error("MCP operation no longer running");
        const updated = { ...operation, state: "DONE" as const, completedAt: now(), ...(initialized ? { discoveryCount: initialized.discoveryCount } : {}) };
        state.mcpConnectionOperations[operation.id] = updated;
        appendAudit(state, user, `mcp.${action}.completed`, "connection", DEFAULT_BRIDGE_CONNECTION, null, { operationId: operation.id, revision: record.revision, discoveryCount: initialized?.discoveryCount ?? null }, request);
        return updated;
      });
      if (action === "connect" && initialized && epoch === this.#epoch && !this.#stopped) { this.#session = initialized.session; this.#state = "CONNECTED"; }
      else if (initialized) await this.dispose(initialized.session);
      const connection = await this.options.repository.readAuthoritative(state => this.view(recordSchema.parse(state.mcpConnections[DEFAULT_BRIDGE_CONNECTION])));
      return { operation: publicOperation(completed), connection, duplicate: false };
    } catch (error) {
      controller.abort(); if (initialized) await this.dispose(initialized.session);
      const superseded = epoch !== this.#epoch || this.#stopped;
      if (action === "connect" && epoch === this.#epoch) this.invalidate("DEGRADED");
      const reason: Operation["reason"] = error instanceof OperationDeadlineExceeded ? "MCP_WAIT_TIMEOUT" : error instanceof HandlerFailure && error.status === 403 ? "MCP_ACTOR_REVOKED" : superseded ? "MCP_OPERATION_INTERRUPTED" : "MCP_OPERATION_FAILED";
      try { await this.options.repository.mutate(state => {
        const operation = operationSchema.parse(state.mcpConnectionOperations[claimed.operation.id]);
        if (operation.state === "RUNNING") { state.mcpConnectionOperations[operation.id] = { ...operation, state: "FAILED", reason, completedAt: now() };
          const record = recordSchema.parse(state.mcpConnections[DEFAULT_BRIDGE_CONNECTION]);
          if (action === "connect" && record.revision === claimed.record.revision) state.mcpConnections[DEFAULT_BRIDGE_CONNECTION] = { ...record, desiredEnabled: false, updatedAt: now() };
          appendAudit(state, user, `mcp.${action}.failed`, "connection", DEFAULT_BRIDGE_CONNECTION, null, { operationId: operation.id, reason }, request); }
      }); } catch { this.invalidate("STORAGE_UNCERTAIN"); }
      // Upstream headers/bodies/errors may contain credentials. Never expose or
      // save them. The operation receipt is the recovery identity.
      throw new HandlerFailure(error instanceof HandlerFailure && error.status === 403 ? 403 : 502, "MCP operation did not establish confirmed readiness; reload its saved operation before deciding on another request", { code: reason, operationId: claimed.operation.id });
    } finally { if (action === "test") { this.#probeBusy = false; this.#probeController = undefined; } }
  }
  async stop() { this.#stopped = true; const old = this.#session; this.invalidate("STOPPED"); if (old) await this.dispose(old); }
}

function validateOwnedConfiguration(config: AppConfig) {
  let url: URL; try { url = new URL(config.erpbridgeBaseURL); } catch { throw new Error("Invalid backend ERPBridge endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || (config.environment !== "development" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || /[\r\n]/.test(config.erpbridgeMcpToken) || config.erpbridgeMcpToken.length > 16384)
    throw new Error("Backend ERPBridge endpoint/credential is not supported by the explicit modern adapter");
}
