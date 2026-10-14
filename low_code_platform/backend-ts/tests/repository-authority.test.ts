import { expect, test, vi } from "vitest";
import { Repository, type PersistenceBackend } from "../src/repository/store.js";

class Authority implements PersistenceBackend {
  payload: Uint8Array | null = null; available = true; closed = false; saves = 0; listeners = new Set<() => void>();
  assertAuthority() { if (!this.available || this.closed) throw new Error("writer fenced"); }
  observeUnavailable(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  deny() { this.available = false; for (const listener of this.listeners) listener(); }
  async load() { this.assertAuthority(); return this.payload; }
  async save(value: Uint8Array) { this.assertAuthority(); this.payload = Buffer.from(value); this.saves++; }
  async probe() { this.assertAuthority(); } async close() { this.closed = true; }
}

test("a server authority signal synchronously denies final entry and commit observers", async () => {
  const storage = new Authority(), repository = await Repository.open(storage), unavailable = vi.fn(), committed = vi.fn();
  repository.observeCommits({ committed, unavailable }); storage.deny(); expect(unavailable).toHaveBeenCalledTimes(1); expect(committed).not.toHaveBeenCalled(); expect(() => repository.assertAuthority()).toThrow("fenced");
  await expect(repository.read(() => true)).rejects.toThrow(); await expect(repository.snapshot()).rejects.toThrow(); expect(await repository.persistenceStatus()).toEqual({ durable: true, healthy: false });
});

test.each([false, true])("authority is checked after an awaited reader, authoritative=%s", async authoritative => {
  const storage = new Authority(), repository = await Repository.open(storage);
  const reader = async () => { storage.deny(); return "must not expose"; };
  await expect(authoritative ? repository.readAuthoritative(reader) : repository.read(reader)).rejects.toThrow("fenced");
});

test.each([false, true])("a denied controller cannot enter a mutation callback, scoped=%s", async scoped => {
  const storage = new Authority(), repository = await Repository.open(storage), callback = vi.fn(); storage.deny();
  await expect(scoped ? repository.mutateExecution("run", callback) : repository.mutate(callback)).rejects.toThrow(); expect(callback).not.toHaveBeenCalled(); expect(storage.saves).toBe(1);
});

test.each([false, true])("authority lost during an awaited mutation denies persistence and commit acknowledgement, scoped=%s", async scoped => {
  const storage = new Authority(), repository = await Repository.open(storage), committed = vi.fn(); repository.observeCommits({ committed, unavailable: vi.fn() });
  const callback = async () => { storage.deny(); return "must not acknowledge"; };
  await expect(scoped ? repository.mutateExecution("run", callback) : repository.mutate(callback)).rejects.toThrow(); expect(storage.saves).toBe(1); expect(committed).not.toHaveBeenCalled();
});

test("authority lost after a committed save remains uncertain and never becomes an acknowledged cache", async () => {
  const storage = new Authority(), repository = await Repository.open(storage), committed = vi.fn(), save = storage.save.bind(storage);
  repository.observeCommits({ committed, unavailable: vi.fn() }); storage.save = async value => { await save(value); storage.deny(); };
  await expect(repository.mutate(state => { state.counter = 7; })).rejects.toThrow(); expect(committed).not.toHaveBeenCalled();
  expect(JSON.parse(Buffer.from(storage.payload!).toString("utf8")).counter).toBe(7); await expect(repository.recoverPersistenceState()).rejects.toThrow();
});

test("a successful probe cannot revive denied ownership or fabricate a reload acknowledgement", async () => {
  const storage = new Authority(), repository = await Repository.open(storage), committed = vi.fn(); repository.observeCommits({ committed, unavailable: vi.fn() });
  storage.deny(); storage.probe = async () => {}; expect(await repository.persistenceStatus()).toEqual({ durable: true, healthy: false }); expect(() => repository.assertAuthority()).toThrow(); expect(committed).not.toHaveBeenCalled();
});

test("repository close synchronously denies even memory entry before asynchronous storage drain", async () => {
  const repository = new Repository(); const closing = repository.close(); expect(() => repository.assertAuthority()).toThrow("closed"); await closing;
  const storage = new Authority(), owned = await Repository.open(storage); await owned.close(); expect(storage.listeners.size).toBe(0); expect(() => owned.assertAuthority()).toThrow("closed");
});
