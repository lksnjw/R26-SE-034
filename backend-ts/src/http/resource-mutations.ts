import { AsyncMutex } from "../repository/async-mutex.js";

/** Serialize only legacy mutations of the same resource, not an entire API.
 * Version-checked commands, proposals and pinned read runs use repository
 * transactions instead, so model/ERP waits cannot block unrelated work. */
export class ResourceMutations {
  private readonly entries = new Map<string, { mutex: AsyncMutex; users: number }>();
  get pendingResources(): number { return this.entries.size; }
  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key) ?? { mutex: new AsyncMutex(), users: 0 };
    this.entries.set(key, entry); entry.users += 1;
    try { return await entry.mutex.runExclusive(action); }
    finally { entry.users -= 1; if (entry.users === 0) this.entries.delete(key); }
  }
}
