import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { stringify } from "yaml";
import jwt from "jsonwebtoken";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { buildApp } from "../src/http/app.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { protectedSimulationSource, protectedSimulationRead, fixtureOutput } from "../tests/fixtures/protected-simulation.js";

const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback demo emulator and no credential file are required");
const namespace = { projectId, databaseId: "(default)", workspaceId: `test_${randomUUID().replaceAll("-", "")}_protected_fixtures` };
const key = randomBytes(32).toString("base64"), config = loadConfig({ APP_ENV: "test", JWT_SECRET: randomBytes(32).toString("hex"), STORAGE_DRIVER: "firestore-records", MCP_MODE: "mock",
  STORAGE_ENCRYPTION_KEY: key, FIRESTORE_PROJECT_ID: projectId, FIRESTORE_DATABASE_ID: namespace.databaseId, FIRESTORE_WORKSPACE_ID: namespace.workspaceId });
const yaml = stringify(protectedSimulationSource()), baseHash = workflowContentHash(yaml), tool = protectedSimulationRead;
const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => "fixture-registry", findTool: () => tool, enabledRules: () => [] };
let repository, adapter, app, dispatches = 0, models = 0;
const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: "actor", expiresIn: 3600 })}` };
async function start() {
  adapter = await FirestoreRecordPersistence.open(key, namespace); repository = await Repository.open(adapter);
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  executor.run = async () => { dispatches++; throw new Error("Fixture evaluation must not execute tools"); };
  const providerRuntime = { configured: true, queryWithTools: async () => { models++; throw new Error("Fixture evaluation must not infer"); } };
  app = await buildApp({ config, repository, registries, validator, executor, providerRuntime }); await app.ready();
}
async function stop() { try { await app?.close(); } finally { app = undefined; await repository?.close(); repository = undefined; } }
const request = body => app.inject({ method: "POST", url: "/api/workflows/sim/run", headers, payload: body });
try {
  await start();
  await repository.mutate(state => {
    state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", status: "Active", permissionOverrides: [], initials: "A", departmentId: null, lastLoginAt: null, createdAt: "now" };
    state.workflows.sim = { id: "sim", name: "Fixture", description: "Fixture", owner: { id: "actor", name: "Actor" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 4,
      successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: "now", updatedAt: "now", yaml, archived: false };
  });
  const original = await repository.snapshot(), revision = (await adapter.records.load()).revision;
  for (const handled of [false, true]) {
    const outputs = { fallback: fixtureOutput("Handled"), after: fixtureOutput("Final"), ...(handled ? {} : { lookup: fixtureOutput("Lookup"), body_next: fixtureOutput("Body") }) };
    const body = { dryRun: true, input: {}, simulation: { profile: "protected-fixtures/v1", baseVersion: 1, baseHash, outputs,
      failures: handled ? { lookup: { kind: "business-read-error", code: "ERP_RESOURCE_NOT_FOUND" } } : {} } };
    const reply = await request(body); assert.equal(reply.statusCode, 200, reply.body);
    const result = reply.json().data;
    assert.equal(result.outcome, "SIMULATED_COMPLETE"); assert.equal(result.finalOutput, "Final");
    assert.equal(result.valueOutputs.guard.value, handled ? "Handled" : "Body");
    assert.equal(result.erp_calls, 0); assert.equal(result.model_calls, 0); assert.equal(result.persisted_run, false); assert.equal(result.can_execute, false);
    assert.equal(result.handler_selection, "supplied_test_fault_only"); assert.equal(result.erp_absence, "not_established"); assert.equal(result.approval, "not_granted");
    assert.deepEqual(await repository.snapshot(), original); assert.equal((await adapter.records.load()).revision, revision);
    const stale = structuredClone(body); stale.simulation.baseVersion = 2; assert.equal((await request(stale)).statusCode, 409);
    const unsafe = structuredClone(body); unsafe.dryRun = false; assert.equal((await request(unsafe)).statusCode, 400);
    await stop(); await start(); assert.deepEqual(await repository.snapshot(), original);
    console.log(`PASS: actual Firestore protected ${handled ? "handled" : "success"} HTTP fixture, exact original record revision, immediate reopen and zero run/dispatch/model use`);
  }
  assert.equal(dispatches, 0); assert.equal(models, 0);
  console.log("Protected fixture qualification complete; supplied test data only, not live ERP/model/effect behavior or cloud certification");
} finally { try { await stop(); } finally { await adapter?.close(); } }
