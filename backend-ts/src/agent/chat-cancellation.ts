import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ChatOperation, Repository } from "../repository/store.js";
import { assertChatTaskOutbox } from "./chat-task-outbox.js";
import { bindExecutionHost } from "../runner/execution-host.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const chatCancellationIntentSchema = z.object({ profile: z.literal("chat-cancellation-intent/v1"),
  operationId: z.string().min(1).max(256), taskId: z.string().regex(/^chat-[a-f0-9]{64}$/), bindingHash: hash,
  actorId: z.string().min(1).max(256), authorityFingerprint: hash, createdAt: z.iso.datetime() }).strict();
export type ChatCancellationIntent = z.infer<typeof chatCancellationIntentSchema>;
export const chatCancellationRecordSchema = z.object({ profile: z.literal("chat-cancellation-record/v1"),
  intent: chatCancellationIntentSchema, requestedAt: z.iso.datetime() }).strict();
export function chatCancellationIntent(operation: ChatOperation): ChatCancellationIntent {
  const task = assertChatTaskOutbox(operation);
  return chatCancellationIntentSchema.parse({ profile: "chat-cancellation-intent/v1", operationId: operation.id,
    taskId: task.taskId, bindingHash: task.bindingHash, actorId: operation.actorId,
    authorityFingerprint: operation.authorityFingerprint, createdAt: operation.createdAt });
}
export function assertChatCancellationIntent(operation: ChatOperation, raw: unknown): ChatCancellationIntent {
  const intent = chatCancellationIntentSchema.parse(raw);
  if (!canonicalJSONBytes(intent).equals(canonicalJSONBytes(chatCancellationIntent(operation)))) throw new Error("Original chat cancellation identity changed");
  return intent;
}
export type ChatCancellationReader = Readonly<{ requested(operation: ChatOperation, signal?: AbortSignal): Promise<boolean> }>;
const readers = new WeakMap<Repository, ChatCancellationReader>();
/** Server-owned stop-only capability, not supplied by a user/model/task body. */
export function configureChatCancellation(repository: Repository, reader: ChatCancellationReader): void {
  if (bindExecutionHost(repository) !== "bounded-invocation" || readers.has(repository) || typeof reader?.requested !== "function")
    throw new Error("Chat cancellation requires a new bounded owner and stop-only reader");
  repository.assertAuthority(); readers.set(repository, Object.freeze({ requested: reader.requested.bind(reader) }));
}
export function chatCancellationReader(repository: Repository): ChatCancellationReader | undefined { return readers.get(repository); }
