import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import { Repository, type PersistenceBackend } from "../src/repository/store.js";
import { supportsCollectionReads, readIterationBindingKey } from "../src/runner/read-collection-admission.js";

// Capability/key-lifecycle unit doubles only; actual SQL qualification is a
// separate isolated verification, not inferred from this advertised marker.
class Records implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  async saveExecutionCheckpoint() {} async load() { return null; } async save() {} async probe() {} async close() {}
}
function fixture(persistence: PersistenceBackend | null = null): HandlerServices {
  return { repository: new Repository(persistence), config: loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", STORAGE_ENCRYPTION_KEY: "x".repeat(32) }),
    erpbridgeSession: { available: true, requiresReviewedRevision: true, dispatchBoundary: "sdk-entry/v1", admissionBinding: "private-fixture-binding" } } as HandlerServices;
}

describe("normal collection execution qualification and private keys", () => {
  test("qualifies explicit memory mode and actual record-capable single-writer storage, never an environment assertion alone", () => {
    expect(supportsCollectionReads(fixture())).toBe(true); expect(supportsCollectionReads(fixture(new Records()))).toBe(true);
    const s = fixture({ load: async () => null, save: async () => {}, probe: async () => {}, close: async () => {} });
    s.config.storageDriver = "postgres-records"; expect(supportsCollectionReads(s)).toBe(false);
  });
  test.each(["missing", "closed", "legacy", "boundary", "binding", "records", "writer", "checkpoint", "key"])("denies unqualified %s without granting publication or execution", kind => {
    const persistence = new Records(), s = fixture(persistence);
    if (kind === "missing") delete s.erpbridgeSession;
    if (kind === "closed") Object.defineProperty(s.erpbridgeSession!, "available", { value: false });
    if (kind === "legacy") Object.defineProperty(s.erpbridgeSession!, "requiresReviewedRevision", { value: false });
    if (kind === "boundary") Object.defineProperty(s.erpbridgeSession!, "dispatchBoundary", { value: undefined });
    if (kind === "binding") Object.defineProperty(s.erpbridgeSession!, "admissionBinding", { value: undefined });
    if (kind === "records") Object.defineProperty(persistence, "executionCheckpointDurability", { value: undefined });
    if (kind === "writer") Object.defineProperty(persistence, "readQueueDurability", { value: undefined });
    if (kind === "checkpoint") Object.defineProperty(persistence, "saveExecutionCheckpoint", { value: undefined });
    if (kind === "key") s.config.storageEncryptionKey = "invalid";
    expect(supportsCollectionReads(s)).toBe(false);
  });
  test("memory keys remain private/stable for the same repository and differ across repositories", () => {
    const first = fixture(), second = fixture(), key = readIterationBindingKey(first);
    expect(key).toMatch(/^[a-f0-9]{64}$/); expect(readIterationBindingKey(first)).toBe(key);
    expect(readIterationBindingKey({ ...first })).toBe(key); expect(readIterationBindingKey(second)).not.toBe(key);
    expect(JSON.stringify(first.config)).not.toContain(key);
  });
  test("durable evidence keys survive fresh repository instances but not storage-key rotation", () => {
    const first = fixture(new Records()), second = fixture(new Records()), key = readIterationBindingKey(first);
    expect(readIterationBindingKey(second)).toBe(key); second.config.storageEncryptionKey = "y".repeat(32); expect(readIterationBindingKey(second)).not.toBe(key);
    expect(key).not.toBe(first.config.storageEncryptionKey); expect(JSON.stringify(first.config)).not.toContain(key);
  });
});
