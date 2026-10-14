import { createHash, randomBytes } from "node:crypto";
import type { Repository } from "./store.js";

export class ChatCreationFailure extends Error {
  constructor(readonly status: 409 | 410, message: string) { super(message); }
}

/** One acknowledged mutation owns both the chat and its replay tombstone.
 * A receipt recovers identity; it never authorizes sending or running work. */
export async function createSavedChat(repository: Repository, ownerId: string, title: string, key?: string) {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const scope = key ? digest(["chat-creation/v1", ownerId, key]) : null;
  const requestHash = digest({ title });
  return repository.mutate(state => {
    const receipt = scope ? state.chatCreationReceipts[scope] : undefined;
    if (receipt) {
      if (receipt.ownerId !== ownerId || receipt.requestHash !== requestHash) throw new ChatCreationFailure(409, "This chat creation identity belongs to a different request");
      const existing = state.chats[receipt.sessionId];
      if (!existing) throw new ChatCreationFailure(410, "The original conversation was deleted. Start a new conversation instead.");
      if (existing.ownerId !== ownerId) throw new ChatCreationFailure(409, "The original conversation cannot be recovered");
      return { chat: existing, created: false };
    }
    const id = `chat_${++state.counter}_${randomBytes(4).toString("hex")}`, timestamp = new Date().toISOString();
    const value = { id, ownerId, title, createdAt: timestamp, updatedAt: timestamp, messageCount: 0, messages: [] };
    state.chats[id] = value;
    if (scope) state.chatCreationReceipts[scope] = { profile: "chat-creation/v1", ownerId, sessionId: id, requestHash };
    return { chat: value, created: true };
  });
}
