import { createHash, createHmac, randomBytes } from "node:crypto";
import type { ChatOperation, Repository, RepositoryState, StoredRecord } from "../repository/store.js";
import { AESGCMCodec, decodeEncryptionKey } from "../storage/aes-gcm.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { HandlerFailure, isRecord, nextID, now, stringValue, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { assertChatAuthority, requestedModel, selectProvider } from "../http/handlers/model-selection.js";
import { processStoredChat } from "../http/handlers/chat.js";
import type { RuntimeProviderConfiguration } from "../providers/runtime.js";
import { ProviderRuntime } from "../providers/runtime.js";
import { acknowledgedReadToolFailure } from "../tools/read-tool-broker.js";
import type { ChatProcessingHooks, StoredChatInput } from "./chat-context.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { assertNodeContext, assertCurrentWorkflowEditor, nodeContextSchema } from "../workflows/commands.js";
import { assertChatRevisionSource, chatRequestRevisionSchema, revisionPriorContext } from "./chat-request-revisions.js";

const queues = new WeakMap<Repository, ChatJobQueue>();
export const activeChatStatus = (status: string) => ["QUEUED", "RUNNING"].includes(status);
function authorityFingerprint(user: CurrentUser) { return createHash("sha256").update(canonicalJSONBytes([user.role, [...new Set(user.permissions)].sort()])).digest("hex"); }
export function authorizeChatOperation(state: Readonly<RepositoryState>, op: ChatOperation | undefined, user: CurrentUser): ChatOperation {
  if (!op || op.actorId !== user.id) throw new HandlerFailure(404, "Chat operation not found");
  if (assertChatAuthority(state, user, op.sessionId).ownerId !== user.id) throw new HandlerFailure(404, "Chat operation not found");
  if (op.authorityFingerprint !== authorityFingerprint(user)) throw new HandlerFailure(403, "Chat operation authority changed", { code: "CHAT_AUTHORITY_CHANGED" });
  if (op.nodeContext) {
    const workflow = state.workflows[op.nodeContext.workflowId];
    if (!workflow) throw new HandlerFailure(404, "Workflow not found");
    assertCurrentWorkflowEditor(state, workflow, user);
  }
  return op;
}
export function supportsChatJobs(services: HandlerServices) { return services.repository.persistence === null || services.repository.persistence.readQueueDurability === "encrypted-single-writer"; }
export function chatJobQueue(services: HandlerServices): ChatJobQueue {
  let queue = queues.get(services.repository);
  if (!queue || queue.closed) { queue = new ChatJobQueue(services); queues.set(services.repository, queue); }
  return queue;
}
type PrivateInput = { version: 1; operationId: string; body: Record<string, unknown>; content: string; user: CurrentUser; stored: StoredChatInput; provider: RuntimeProviderConfiguration | null };

export function publicChatOperation(op: ChatOperation) {
  return { id: op.id, sessionId: op.sessionId, userMessageId: op.userMessageId, assistantMessageId: op.assistantMessageId ?? null,
    status: op.status, stage: op.stage, epoch: op.epoch, lastSequence: op.lastSequence, createdAt: op.createdAt, updatedAt: op.updatedAt,
    finishedAt: op.finishedAt ?? null, traceId: op.traceId, persistence: op.persistence, modelBinding: op.modelBinding,
    cancellationRequested: op.cancellationRequested === true, reason: op.reason ?? null, nodeContext: op.nodeContext ?? null, requestRevision: op.requestRevision ?? null, artifactRefs: op.artifactRefs ?? [], attempts: op.attempts.map(a => ({ id: a.id, toolName: a.toolName, status: a.status, startedAt: a.startedAt, completedAt: a.completedAt ?? null,
      ...(["DONE", "FAILED"].includes(a.status) && a.output !== undefined ? { output: a.output } : {}) })) };
}
function event(state: RepositoryState, op: ChatOperation, type: string, attemptId?: string) {
  const entries = state.chatOperationEvents[op.id] ??= [];
  if ((entries.at(-1)?.sequence ?? 0) !== op.lastSequence) throw new Error("Chat event sequence is inconsistent");
  op.updatedAt = now();
  entries.push({ version: 1, operationId: op.id, sessionId: op.sessionId, sequence: ++op.lastSequence, timestamp: op.updatedAt, stage: op.stage, type, status: op.status, ...(attemptId ? { attemptId } : {}) });
}
function audit(state: RepositoryState, op: ChatOperation, action: string) {
  state.auditLogs.push({ id: nextID(state, "audit"), source: "chat-job-worker", actor: { id: op.actorId }, action, resource: { type: "chat_operation", id: op.id }, createdAt: now(), traceId: op.traceId,
    before: null, after: { status: op.status, stage: op.stage, epoch: op.epoch } });
}

/** Encrypted, locked single-owner queue. Claimed jobs never restart/replay.
 * Every visible stage is committed, and effects still use the governed broker. */
export class ChatJobQueue {
  readonly #codec: AESGCMCodec;
  readonly #key: Buffer;
  readonly #worker = `chat-worker-${randomBytes(12).toString("hex")}`;
  #closed = false; #started = false; #pumping = false; #scheduled = false;
  #controller: AbortController | undefined; #activeId: string | undefined;
  #stalled = false;
  readonly #unobserve: () => void;
  get closed() { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    if (!supportsChatJobs(services)) throw new HandlerFailure(503, "Storage does not support a verified single-writer chat queue", { code: "CHAT_QUEUE_STORAGE_UNSUPPORTED" });
    const key = services.repository.persistence === null ? randomBytes(32).toString("base64") : services.config.storageEncryptionKey;
    this.#codec = new AESGCMCodec(key); this.#key = decodeEncryptionKey(key);
    this.#unobserve = services.repository.observeCommits({ committed: () => {}, unavailable: () => {
      this.#stalled = true; this.#controller?.abort(new Error("Chat storage authority is unavailable; no replay is allowed"));
    } });
  }
  private fingerprint(data: unknown) { return createHmac("sha256", this.#key).update(canonicalJSONBytes(data)).digest("hex"); }
  private connection() { return this.fingerprint({ binding: this.services.erpbridgeSession?.admissionBinding ?? null, roles: this.services.config.erpbridgeRoleMap }); }
  private contracts() { return this.fingerprint(this.services.registries.snapshot().tools); }
  async admit(sessionId: string, user: CurrentUser, raw: Record<string, unknown>, traceId: string) {
    if (this.#closed || this.#stalled) throw new HandlerFailure(503, "Chat worker storage is unavailable or shutting down");
    const key = stringValue(raw.idempotencyKey);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HandlerFailure(400, "Provide a 16–128 character chat idempotency key", { code: "CHAT_JOB_KEY_REQUIRED" });
    const content = (stringValue(raw.content) || stringValue(raw.message)).trim();
    if (!content) throw new HandlerFailure(400, "message is required");
    if (Object.keys(raw).some(k => !["content", "message", "model", "mode", "workflowContext", "nodeContext", "requestRevision", "delivery", "idempotencyKey"].includes(k))) throw new HandlerFailure(400, "Unsupported asynchronous chat input");
    const parsedRevision = raw.requestRevision === undefined ? undefined : chatRequestRevisionSchema.safeParse(raw.requestRevision);
    if (parsedRevision && !parsedRevision.success) throw new HandlerFailure(400, "Invalid saved request revision");
    const requestRevision = parsedRevision?.success ? parsedRevision.data : undefined;
    const body = structuredClone(raw); delete body.idempotencyKey; delete body.delivery;
    let sourceCiphertext: string | undefined;
    if (requestRevision) {
      if (raw.workflowContext !== undefined || raw.mode !== undefined) throw new HandlerFailure(400, "A revision preserves the original request scope; it cannot replace workflow context or mode");
      const original = await this.services.repository.readAuthoritative(state => {
        const { source, operation } = assertChatRevisionSource(state, user, sessionId, requestRevision);
        sourceCiphertext = operation.revisionContextCiphertext;
        try {
          const input = JSON.parse(this.#codec.decode(Buffer.from(operation.revisionContextCiphertext!, "base64")).toString("utf8")) as { version: number; operationId: string; userMessageId: string; body: Record<string, unknown>; content: string };
          if (input.version !== 1 || input.operationId !== operation.id || input.userMessageId !== source.id || input.content !== source.text ||
              !isRecord(input.body) || this.fingerprint(input.body) !== operation.requestFingerprint) throw new Error("Invalid context");
          return input.body;
        } catch { throw new HandlerFailure(409, "Original request context could not be authenticated. No revision was saved", { code: "CHAT_REVISION_CONTEXT_UNAVAILABLE" }); }
      });
      if (!canonicalJSONBytes(raw.nodeContext ?? null).equals(canonicalJSONBytes(original.nodeContext ?? null)))
        throw new HandlerFailure(409, "A revision must retain the exact original node scope", { code: "CHAT_REVISION_SCOPE_CHANGED" });
      for (const field of ["workflowContext", "mode", "nodeContext"] as const) if (original[field] !== undefined) body[field] = structuredClone(original[field]);
    }
    const parsedContext = body.nodeContext === undefined ? undefined : nodeContextSchema.safeParse(body.nodeContext);
    if (parsedContext && !parsedContext.success) throw new HandlerFailure(400, "Invalid selected node context");
    const nodeContext = parsedContext?.success ? parsedContext.data : undefined;
    if (nodeContext && (content.length > 4000 || body.workflowContext !== undefined || body.mode !== undefined)) throw new HandlerFailure(400, "A node prompt must contain at most 4000 characters and a single node scope");
    const bytes = JSON.stringify(body);
    if (Buffer.byteLength(bytes) > 200_000) throw new HandlerFailure(413, "Chat request exceeds 200 KB");
    const scope = this.fingerprint([user.id, sessionId, key]);
    const fingerprint = this.fingerprint(body);
    // Check the original idempotent identity before consulting today's defaults.
    const existing = await this.services.repository.read(state => {
      assertChatAuthority(state, user, sessionId);
      const op = Object.values(state.chatOperations).find(op => op.idempotencyScope === scope);
      return op ? this.receipt(authorizeChatOperation(state, op, user), fingerprint, user, state) : undefined;
    });
    if (existing) return existing;
    if (nodeContext) await this.services.repository.read(state => assertNodeContext(state, nodeContext, user));
    const previousModel = await this.services.repository.read(state => state.chats[sessionId]?.selectedModel);
    const provider = selectProvider(this.services, requestedModel(body.model) ?? previousModel);
    if (nodeContext && !provider?.configured) throw new HandlerFailure(503, "Configure a provider before requesting a node proposal", { code: "PROVIDER_NOT_CONFIGURED" });
    const configuration = provider?.configuration ?? null, binding = provider?.binding ?? null;
    const connection = this.connection(), contracts = this.contracts();
    const admitted = await this.services.repository.mutate(state => {
      const chat = assertChatAuthority(state, user, sessionId);
      if (chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat session not found");
      const duplicate = Object.values(state.chatOperations).find(op => op.idempotencyScope === scope);
      if (duplicate) return this.receipt(authorizeChatOperation(state, duplicate, user), fingerprint, user, state);
      if (requestRevision && assertChatRevisionSource(state, user, sessionId, requestRevision).operation.revisionContextCiphertext !== sourceCiphertext)
        throw new HandlerFailure(409, "Saved request context changed. Reload before revising", { code: "CHAT_REVISION_SOURCE_CHANGED" });
      if (nodeContext) assertNodeContext(state, nodeContext, user);
      const pending = Object.values(state.chatOperations).filter(op => activeChatStatus(op.status));
      if (pending.some(op => op.sessionId === sessionId)) throw new HandlerFailure(409, "This conversation already has an active operation", { code: "CHAT_OPERATION_ACTIVE" });
      if (pending.length >= 100) throw new HandlerFailure(429, "Chat queue is full; no message was admitted", { code: "CHAT_QUEUE_FULL" });
      const id = nextID(state, "chatop"), timestamp = now();
      const userMessage = { id: nextID(state, "msg"), role: "user", text: content, createdAt: timestamp, traceId, operationId: id, ...(binding ? { modelBinding: binding } : {}),
        ...(requestRevision ? { requestRevision } : {}),
        ...(nodeContext ? { artifacts: { intent: "NODE_EDIT_REQUEST", ...nodeContext } } : {}) };
      const stored = { session: { id: chat.id, title: chat.title, selectedModel: binding?.model ?? chat.selectedModel }, userMessage,
        priorMessages: revisionPriorContext(chat, requestRevision) };
      const privateInput: PrivateInput = { version: 1, operationId: id, body, content, user: structuredClone(user), stored, provider: configuration };
      const privateBytes = Buffer.from(JSON.stringify(privateInput));
      if (privateBytes.length > 500_000) throw new HandlerFailure(413, "Chat context exceeds 500 KB; shorten the workflow context or start a new conversation");
      // Retain only authenticated request context for explicit future revisions,
      // never the provider credentials/configuration erased at job completion.
      const revisionContextCiphertext = this.#codec.encode(Buffer.from(JSON.stringify({ version: 1, operationId: id, userMessageId: userMessage.id, body, content }))).toString("base64");
      const op: ChatOperation = { version: 1, id, sessionId, actorId: user.id, userMessageId: userMessage.id, status: "QUEUED", stage: "QUEUED", epoch: 1, lastSequence: 0,
        createdAt: timestamp, updatedAt: timestamp, traceId, persistence: this.services.repository.persistence === null ? "memory-only" : "durable", modelBinding: binding,
        inputCiphertext: this.#codec.encode(privateBytes).toString("base64"), revisionContextCiphertext, idempotencyScope: scope, requestFingerprint: fingerprint, connectionFingerprint: connection, contractFingerprint: contracts, authorityFingerprint: authorityFingerprint(user), attempts: [], ...(nodeContext ? { nodeContext } : {}), ...(requestRevision ? { requestRevision } : {}) };
      state.chatOperations[id] = op;
      chat.messages.push(userMessage); chat.messageCount = chat.messages.length; chat.updatedAt = timestamp;
      if (binding) chat.selectedModel = binding.model;
      event(state, op, "operation.queued"); audit(state, op, "chat.operation.admitted");
      if (requestRevision) state.auditLogs.push({ id: nextID(state, "audit"), actor: { id: user.id, name: user.name }, action: "chat.request.revised", resource: { type: "chat", id: sessionId },
        before: { sourceMessageId: requestRevision.messageId, sourceHash: requestRevision.sourceHash }, after: { messageId: userMessage.id, operationId: id }, createdAt: timestamp, traceId });
      return { operation: publicChatOperation(op), userMessage, session: stored.session };
    });
    this.kick(); return admitted;
  }
  private receipt(op: ChatOperation, fingerprint: string, user: CurrentUser, state?: Readonly<RepositoryState>) {
    if (op.actorId !== user.id || op.requestFingerprint !== fingerprint) throw new HandlerFailure(409, "This chat key was used for different input", { code: "CHAT_JOB_KEY_CONFLICT" });
    return { operation: publicChatOperation(op), userMessage: state?.chats[op.sessionId]?.messages.find(m => m.id === op.userMessageId) ?? null, session: { id: op.sessionId } };
  }
  async start() {
    if (this.#started) return; this.#started = true;
    await this.services.repository.mutate(state => {
      for (const op of Object.values(state.chatOperations)) if (op.status === "RUNNING") this.reconcile(state, op, "WORKER_RESTARTED");
    });
    this.kick();
  }
  private reconcile(state: RepositoryState, op: ChatOperation, reason: string) {
    op.epoch++; op.status = "RECOVERY_REQUIRED"; op.stage = "RECOVERY_REQUIRED"; op.reason = reason; op.finishedAt = now();
    for (const attempt of op.attempts) if (["PREPARING", "DISPATCH_INTENT"].includes(attempt.status)) {
      attempt.status = attempt.status === "DISPATCH_INTENT" ? "UNKNOWN" : "FAILED"; attempt.completedAt = now();
      event(state, op, "tool.interrupted", attempt.id);
    }
    delete op.inputCiphertext; event(state, op, "operation.recovery_required"); audit(state, op, "chat.operation.recovery_required");
  }
  kick() { if (this.#closed || this.#stalled || this.#scheduled || this.#pumping) return; this.#scheduled = true; setImmediate(() => { this.#scheduled = false; void this.pump(); }); }
  private async pump() {
    if (this.#closed || this.#stalled || this.#pumping) return; this.#pumping = true;
    try { while (!this.#closed && !this.#stalled) {
      const id = await this.services.repository.read(state => Object.values(state.chatOperations).filter(op => op.status === "QUEUED").sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0]?.id);
      if (!id) break; await this.process(id);
    } } catch { /* A lost claim acknowledgement stops the pump; no hot loop or replay. */ }
    finally { this.#pumping = false; }
  }
  private async process(id: string) {
    let op: ChatOperation | undefined;
    const controller = new AbortController(); this.#controller = controller; this.#activeId = id;
    try {
      op = await this.services.repository.mutate(state => {
        const current = state.chatOperations[id]; if (!current || current.status !== "QUEUED") return undefined;
        current.status = "RUNNING"; current.stage = "PREPARING"; current.workerId = this.#worker; current.epoch++;
        event(state, current, "operation.started"); audit(state, current, "chat.operation.claimed"); return structuredClone(current);
      });
      if (!op) return;
      const input: PrivateInput = JSON.parse(this.#codec.decode(Buffer.from(op.inputCiphertext!, "base64")).toString("utf8"));
      if (input.version !== 1 || input.operationId !== id || input.user.id !== op.actorId || input.stored.userMessage.id !== op.userMessageId || !isRecord(input.body) ||
          this.fingerprint(input.body) !== op.requestFingerprint || authorityFingerprint(input.user) !== op.authorityFingerprint || input.content !== input.stored.userMessage.text) throw new Error("Private chat identity is not authentic");
      const hooks = this.hooks(op, input.user, controller.signal);
      await this.services.repository.read(state => hooks.assertCurrent(state as RepositoryState));
      if (op.connectionFingerprint !== this.connection() || op.contractFingerprint !== this.contracts()) throw new Error("Chat connection or contracts changed");
      let provider: ProviderRuntime | undefined;
      if (input.provider) provider = (this.services.providerRuntime ?? new ProviderRuntime(this.services.repository, this.services.executor)).restoreCaptured(input.provider, op.modelBinding!.configurationRevision);
      const services = { ...this.services, ...(provider ? { providerRuntime: provider } : {}) };
      // A job admitted without a model does not silently adopt a later default.
      if (!input.provider) delete services.providerRuntime;
      await processStoredChat({ body: input.body, content: input.content, sessionId: op.sessionId, traceId: op.traceId, stored: input.stored, user: input.user, services, signal: controller.signal, hooks });
      // All answer paths commit status and message together. A missing answer
      // acknowledgement is not promoted to ANSWERED by worker return alone.
      await this.services.repository.mutate(state => {
        const current = state.chatOperations[id]; if (current?.status === "RUNNING" && current.epoch === op!.epoch) throw new Error("Processing returned without a saved answer");
      });
    } catch (error) {
      if (!op) throw error;
      try { await this.services.repository.mutate(state => {
        const current = state.chatOperations[id]; if (!current || current.status !== "RUNNING" || current.epoch !== op!.epoch || current.workerId !== this.#worker) return;
        for (const a of current.attempts) if (a.status === "DISPATCH_INTENT") { a.status = "UNKNOWN"; a.completedAt = now(); }
        const uncertain = current.attempts.some(a => a.status === "UNKNOWN");
        current.status = uncertain ? "RECOVERY_REQUIRED" : current.cancellationRequested || controller.signal.aborted ? "CANCELLED" : "FAILED";
        const knownReason = error instanceof HandlerFailure && isRecord(error.meta) && ["DRAFT_REVISION_CONFLICT", "NODE_PROPOSAL_INVALID"].includes(String(error.meta.code)) ? String(error.meta.code) : "PROCESSING_STOPPED";
        current.stage = current.status; current.reason = uncertain ? "TOOL_OUTCOME_UNKNOWN" : current.status === "CANCELLED" ? "PROCESSING_STOPPED" : knownReason; current.finishedAt = now(); delete current.inputCiphertext;
        event(state, current, "operation.stopped"); audit(state, current, "chat.operation.stopped");
      }); } catch { /* Storage acknowledgement uncertain: restart reconciles, never replay. */ }
    } finally { this.#activeId = undefined; this.#controller = undefined; }
  }
  private hooks(admitted: ChatOperation, user: CurrentUser, signal: AbortSignal): ChatProcessingHooks {
    const current = (state: RepositoryState) => {
      const op = state.chatOperations[admitted.id];
      if (!op || op.status !== "RUNNING" || op.epoch !== admitted.epoch || op.workerId !== this.#worker || this.#closed || signal.aborted || op.cancellationRequested) throw new Error("Chat worker generation is no longer authorized");
      authorizeChatOperation(state, op, user); return op;
    };
    return {
      assertCurrent: current,
      stage: async stage => { await this.services.repository.mutate(state => { const op = current(state); op.stage = stage; event(state, op, "operation.stage"); }); },
      artifact: (state, reference) => {
        const op = current(state); (op.artifactRefs ??= []).push(reference); op.stage = reference.type === "node-proposal" ? "PROPOSAL_SAVED" : "DRAFT_SAVED";
        event(state, op, "artifact.saved"); audit(state, op, "chat.artifact.saved");
      },
      saved: (state, message) => {
        const op = current(state); message.operationId = op.id; op.assistantMessageId = stringValue(message.id);
        op.status = op.attempts.some(a => a.status === "UNKNOWN") ? "RECOVERY_REQUIRED" : "ANSWERED";
        op.stage = op.status; op.finishedAt = now(); delete op.inputCiphertext;
        if (op.status === "RECOVERY_REQUIRED") op.reason = "TOOL_OUTCOME_UNKNOWN";
        event(state, op, "answer.saved"); audit(state, op, "chat.answer.saved");
      },
      read: async (name, args, dispatch) => {
        const attempt = await this.services.repository.mutate(state => {
          const op = current(state); if (op.attempts.length >= 64) throw new Error("Chat read attempt limit reached");
          const a = { id: nextID(state, "chat_attempt"), toolName: name, argumentHash: createHash("sha256").update(canonicalJSONBytes(args)).digest("hex"), status: "PREPARING" as const, startedAt: now() };
          op.attempts.push(a); op.stage = "VERIFYING"; event(state, op, "tool.preparing", a.id); return structuredClone(a);
        });
        try {
          const output = await dispatch(async () => { await this.services.repository.mutate(state => {
            const op = current(state), a = op.attempts.find(a => a.id === attempt.id);
            if (!a || a.status !== "PREPARING" || op.connectionFingerprint !== this.connection() || op.contractFingerprint !== this.contracts()) throw new Error("Chat dispatch binding changed");
            a.status = "DISPATCH_INTENT"; op.stage = "READING"; event(state, op, "tool.dispatch_intent", a.id);
          }); });
          await this.services.repository.mutate(state => {
            const op = current(state), a = op.attempts.find(a => a.id === attempt.id);
            if (!a || a.status !== "DISPATCH_INTENT") throw new Error("Invalid chat receipt checkpoint");
            const receipt = withoutSecretFields(output) as Record<string, unknown>;
            const receiptBytes = Buffer.byteLength(JSON.stringify(receipt));
            const previousBytes = op.attempts.reduce((total, attempt) => total + (attempt.output ? Buffer.byteLength(JSON.stringify(attempt.output)) : 0), 0);
            if (receiptBytes > 512_000 || previousBytes + receiptBytes > 2_000_000) throw new Error("Chat receipt budget exceeded; remote outcome cannot be checkpointed");
            a.status = "DONE"; a.completedAt = now(); a.output = receipt;
            op.stage = "READ_SAVED"; event(state, op, "tool.completed", a.id);
          });
          return output;
        } catch (error) {
          const failure = acknowledgedReadToolFailure(error);
          await this.services.repository.mutate(state => {
            const op = state.chatOperations[admitted.id], a = op?.attempts.find(a => a.id === attempt.id);
            if (!op || op.epoch !== admitted.epoch || op.status !== "RUNNING" || !a || !["PREPARING", "DISPATCH_INTENT"].includes(a.status)) throw new Error("Chat attempt is fenced");
            if (failure) {
              const bytes = Buffer.byteLength(JSON.stringify(failure.result));
              const previous = op.attempts.reduce((total, item) => total + (item.output ? Buffer.byteLength(JSON.stringify(item.output)) : 0), 0);
              if (bytes > 512_000 || previous + bytes > 2_000_000) throw new Error("Chat failure receipt budget exceeded");
              a.output = failure.result;
            }
            a.status = a.status === "DISPATCH_INTENT" && !failure ? "UNKNOWN" : "FAILED"; a.completedAt = now();
            op.stage = "READ_STOPPED"; event(state, op, a.status === "UNKNOWN" ? "tool.outcome_unknown" : "tool.failed", a.id);
          });
          throw error;
        }
      },
    };
  }
  async cancel(id: string, user: CurrentUser) {
    const op = await this.services.repository.mutate(state => {
      const op = authorizeChatOperation(state, state.chatOperations[id], user);
      if (!activeChatStatus(op.status)) return structuredClone(op);
      if (!op.cancellationRequested) { op.cancellationRequested = true; event(state, op, "operation.cancel_requested"); audit(state, op, "chat.operation.cancel_requested"); }
      if (op.status === "QUEUED") { op.status = "CANCELLED"; op.stage = "CANCELLED"; op.finishedAt = now(); delete op.inputCiphertext; event(state, op, "operation.cancelled"); }
      return structuredClone(op);
    });
    if (this.#activeId === id) this.#controller?.abort();
    return publicChatOperation(op);
  }
  async stop() {
    if (this.#closed) return; this.#closed = true; this.#unobserve(); this.#controller?.abort();
    if (this.#activeId) await this.services.repository.mutate(state => { const op = state.chatOperations[this.#activeId!]; if (op?.status === "RUNNING") this.reconcile(state, op, "WORKER_SHUTDOWN"); });
  }
}
