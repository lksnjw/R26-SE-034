import { describe, expect, test } from "vitest";
import { Repository, type PersistenceBackend } from "../src/repository/store.js";

class ControlledPersistence implements PersistenceBackend {
  payload: Uint8Array | null = null;
  failNext = false;
  blockNext = false;
  entered: (() => void) | null = null;
  release: (() => void) | null = null;

  /*******************************************************************************
   * Function: load
   *
   * Returns the stored payload from the controlled persistence fixture.
   ******************************************************************************/
  async load(): Promise<Uint8Array | null> { return this.payload; }
  /*******************************************************************************
   * Function: save
   *
   * Saves the test payload while applying the fixture's configured controls.
   ******************************************************************************/
  async save(payload: Uint8Array): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error("persistence failed"); }
    if (this.blockNext) {
      this.blockNext = false;
      await new Promise<void>((resolve) => { this.release = resolve; this.entered?.(); });
    }
    this.payload = Buffer.from(payload);
  }
  /*******************************************************************************
   * Function: probe
   *
   * Provides the controlled persistence fixture's health probe.
   ******************************************************************************/
  async probe(): Promise<void> { return; }
  /*******************************************************************************
   * Function: close
   *
   * Provides the controlled persistence fixture's close operation.
   ******************************************************************************/
  async close(): Promise<void> { return; }
}

describe("repository transaction boundary", () => {
  test("holds the mutation lock through serialization and persistence", async () => {
    const persistence = new ControlledPersistence();
    const repository = await Repository.open(persistence);
    let enteredSave!: () => void;
    const saveEntered = new Promise<void>((resolve) => { enteredSave = resolve; });
    persistence.blockNext = true;
    persistence.entered = enteredSave;
    const first = repository.mutate((state) => { state.counter = 1; });
    await saveEntered;
    let secondEntered = false;
    const second = repository.mutate((state) => { secondEntered = true; state.counter = 2; });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    persistence.release?.();
    await Promise.all([first, second]);
    expect((await repository.snapshot()).counter).toBe(2);
  });

  test("rolls the aggregate back when persistence fails", async () => {
    const persistence = new ControlledPersistence();
    const repository = await Repository.open(persistence);
    const before = await repository.snapshot();
    persistence.failNext = true;
    await expect(repository.mutate((state) => { state.counter = 99; state.settings.general = { changed: true }; })).rejects.toThrow("persistence failed");
    expect(await repository.snapshot()).toEqual(before);
    await expect(repository.mutate((state) => { state.counter = 100; })).rejects.toThrow("Persistence outcome is uncertain");
    expect(await repository.persistenceStatus()).toEqual({ durable: true, healthy: false });
    await repository.recoverPersistenceState();
    await repository.mutate((state) => { state.counter = 2; });
    expect((await repository.snapshot()).counter).toBe(2);
  });

  test("recovery reloads an acknowledged-uncertain committed blob rather than overwriting it", async () => {
    const persistence = new ControlledPersistence(), repository = await Repository.open(persistence);
    const original = persistence.save.bind(persistence);
    let fail = true;
    persistence.save = async (payload) => { await original(payload); if (fail) { fail = false; throw new Error("lost acknowledgement"); } };
    await expect(repository.mutate((state) => { state.counter = 7; })).rejects.toThrow("lost acknowledgement");
    expect((await repository.snapshot()).counter).toBe(0);
    await expect(repository.mutate((state) => { state.counter = 1; })).rejects.toThrow("uncertain");
    await repository.recoverPersistenceState(); expect((await repository.snapshot()).counter).toBe(7);
    await repository.mutate((state) => { state.counter += 1; }); expect((await repository.snapshot()).counter).toBe(8);
  });
});
