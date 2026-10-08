import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { functionStatePhases } from "../src/firebase/state-phases.js";
import { withFunctionResources } from "../src/firebase/invocation.js";
import { Database, FakeClient, FakeStopClient } from "./fixtures/fake-firestore.js";

const runtime = vi.hoisted(() => ({ database: null as Database | null, clients: [] as FakeClient[] }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class {
  constructor(settings: unknown) {
    const client = new FakeClient(runtime.database!, settings);
    runtime.clients.push(client);
    return client;
  }
}, default: { v1: { FirestoreClient: class { constructor(settings: unknown) { return new FakeStopClient(runtime.database!, settings); } } } } }));

beforeEach(() => { runtime.database = new Database(); runtime.clients = []; });
afterEach(() => { expect(runtime.clients.length).toBeGreaterThan(0); expect(runtime.clients.every(client => client.closed)).toBe(true); });

function composition() {
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", MCP_MODE: "mock",
    FIRESTORE_PROJECT_ID: "demo-state-phases", FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: "fresh_phase_fixture",
    STORAGE_ENCRYPTION_KEY: "k".repeat(32) });
  config.toolRegistryPath = resolve("tests/fixtures/chat-read-tools.json");
  config.ruleRegistryPath = resolve("tests/fixtures/rules.json");
  return { config, root: process.cwd(), transport: { timeoutMs: 1000,
    enqueue: vi.fn(async (command: { taskId: string }) => ({ taskId: command.taskId, outcome: "CREATED" as const })) } };
}

// Keep the actual resource opener, Repository, encrypted record protocol and
// writer ownership. Only the Firestore SDK is replaced; this is not native QA.
test("state phases return detached values after closing, then load independent committed changes", async () => {
  const input = composition(), phases = functionStatePhases(input);
  const original = await phases.mutate(state => {
    state.settings.general = { first: { label: "committed" } };
    return state.settings.general as { first: { label: string } };
  });
  expect(runtime.clients.every(client => client.closed)).toBe(true);
  original.first.label = "caller mutation";
  await withFunctionResources(input, async ({ repository }) => {
    await repository.mutate(state => { (state.settings.general as Record<string, unknown>).second = "independent"; });
  });
  const readback = await phases.read(state => state.settings.general);
  expect(readback).toEqual({ first: { label: "committed" }, second: "independent" });
  await phases.mutate(state => { (state.settings.general as Record<string, unknown>).third = "later phase"; });
  expect(await phases.read(state => state.settings.general)).toEqual({ first: { label: "committed" }, second: "independent", third: "later phase" });
  expect(new Set(runtime.clients).size).toBe(runtime.clients.length);
  expect(runtime.clients.length).toBeGreaterThanOrEqual(5);
  expect(input.transport.enqueue).not.toHaveBeenCalled();
});

test.each(["read", "mutate"] as const)("a throwing %s phase closes its writer and does not persist partial changes", async kind => {
  const phases = functionStatePhases(composition());
  await phases.mutate(state => { state.settings.general = { preserved: "before" }; });
  if (kind === "mutate") {
    await expect(phases.mutate(state => {
      (state.settings.general as Record<string, unknown>).preserved = "must roll back";
      throw new Error("synthetic phase failure");
    })).rejects.toThrow("synthetic phase failure");
  } else {
    await expect(phases.read(() => { throw new Error("synthetic phase failure"); })).rejects.toThrow("synthetic phase failure");
  }
  expect(runtime.clients.every(client => client.closed)).toBe(true);
  expect(await phases.read(state => state.settings.general)).toEqual({ preserved: "before" });
});

test("a non-detachable read result is rejected and the next fresh owner can still acquire", async () => {
  const phases = functionStatePhases(composition());
  await expect(phases.read(() => () => "not a transferable capability")).rejects.toThrow();
  expect(runtime.clients.every(client => client.closed)).toBe(true);
  expect(await phases.read(state => state.counter)).toBeTypeOf("number");
});
