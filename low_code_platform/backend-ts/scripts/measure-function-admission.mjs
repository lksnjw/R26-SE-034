import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import jwt from "jsonwebtoken";
import { Firestore } from "@google-cloud/firestore";
import { loadFunctionConfig } from "../src/firebase/config.js";
import { handleFunctionHttp } from "../src/firebase/http.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { FirestoreWriterOwnership, FirestoreOwnershipFailure } from "../src/storage/firestore-writer-ownership.js";
import { McpConnectionManager } from "../src/tools/mcp-connection-runtime.js";

// Diagnostic of exact source composition over real emulator storage, not a
// substitute for the actual Firebase-export six-client acceptance campaign.
// Each child has a fresh process/client/runtime. Only fixed stages/numbers and
// bounded authority categories leave it; no arguments, errors or secrets.
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records");
assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
const root = resolve(".functions/assets"), actor = "native_admission_actor";
const guarded = raw => {
  const config = loadFunctionConfig(JSON.stringify(raw), root);
  assert.equal(config.environment, "test"); assert.equal(config.mcpMode, "mock"); assert.equal(config.mcpTransport, "bridge-v1");
  assert(/^test_[a-f0-9]{32}_native$/.test(config.firestoreWorkspaceId));
  assert(!config.generationBaseURL && !config.governanceURL && !config.governanceSecondaryURL && !config.policyGateURL && !config.governanceFallbackLlmApiKey);
  return config;
};

if (process.argv[2] === "--child") {
  assert(process.send);
  process.send({ type: "ready" });
  process.once("message", async message => {
    try {
      const config = guarded(message.config), events = [], pending = new Set(), started = performance.now();
      const instrument = (target, method, stage) => {
        const original = target[method];
        target[method] = function (...args) {
          const at = performance.now();
          let outcome = "OK";
          const operation = (async () => {
            try { return await original.apply(this, args); }
            catch (error) {
              const authority = error instanceof FirestoreOwnershipFailure ? error : error instanceof Error && error.cause instanceof FirestoreOwnershipFailure ? error.cause : null;
              outcome = authority?.reason ?? "UNCONFIRMED"; throw error;
            } finally { if (events.length < 512) events.push({ stage, atMs: Math.round(at - started), durationMs: Math.round(performance.now() - at), outcome }); }
          })();
          pending.add(operation); operation.then(() => pending.delete(operation), () => pending.delete(operation));
          return operation;
        };
      };
      instrument(RegistryService, "load", "registry");
      instrument(FirestoreRecordPersistence, "open", "persistence-open");
      instrument(FirestoreWriterOwnership.prototype, "acquire", "writer-acquire");
      instrument(FirestoreWriterOwnership.prototype, "close", "writer-close");
      instrument(FirestoreRecordStore.prototype, "load", "image-load");
      instrument(FirestoreRecordStore.prototype, "close", "client-close");
      instrument(Repository, "open", "repository-open");
      instrument(McpConnectionManager, "open", "mcp-runtime-open");
      instrument(Firestore.prototype, "runTransaction", "transaction");
      const input = { config, root, transport: { timeoutMs: 1000, enqueue: async () => { throw new Error("Diagnostic task dispatch refused"); } } };
      const response = await handleFunctionHttp(input, { method: "GET", url: "/api/chat/models", headers: {
        authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: actor, expiresIn: 3600 })}` } });
      const handlerMs = Math.round(performance.now() - started), body = JSON.parse(response.body.toString());
      if (response.statusCode === 200) assert.deepEqual(body.data, { configured: false, binding: null, models: [] });
      else { assert.equal(response.statusCode, 503); assert(["FUNCTIONS_INVOCATION_UNCONFIRMED", "FUNCTIONS_MODEL_CATALOG_UNAVAILABLE"].includes(body.meta.code)); }
      // Observe late cancellation cleanup rather than exiting with an owned
      // acquisition still in flight. No handler work is retried for this wait.
      const drainDeadline = performance.now() + 35_000;
      while (pending.size && performance.now() < drainDeadline) await pause(50);
      const result = { type: "result", status: response.statusCode, handlerMs, totalMs: Math.round(performance.now() - started), pending: pending.size, events };
      process.send(result, () => process.disconnect());
    } catch { process.send({ type: "diagnostic-failure" }, () => { process.exitCode = 1; process.disconnect(); }); }
  });
} else {
  assert.equal(process.argv[2], "--run");
  const options = process.argv.slice(3), tags = options.filter(option => option.startsWith("--report-suffix="));
  assert(options.every(option => option === "--rest" || /^--report-suffix=[a-z0-9-]{1,32}$/.test(option)) && tags.length <= 1);
  const suffix = tags.length ? `-${tags[0].slice("--report-suffix=".length)}` : "";
  assert(!process.env.FIRESTORE_PREFER_REST, "Transport comparison requires an explicit, not inherited SDK setting");
  const rest = options.includes("--rest");
  if (rest) process.env.FIRESTORE_PREFER_REST = "true";
  const session = JSON.parse(await readFile(".functions/qa-session.json", "utf8"));
  assert.equal(session.profile, "lcwe-native-functions-qa/v1");
  const config = guarded(session.config), namespace = { projectId: config.firestoreProjectId, databaseId: config.firestoreDatabaseId, workspaceId: config.firestoreWorkspaceId };
  const repository = await Repository.open(await FirestoreRecordPersistence.open(config.storageEncryptionKey, namespace));
  try { await repository.mutate(state => {
    assert(!state.users[actor], "Diagnostic actor already exists; use a fresh isolated session");
    state.users[actor] = { id: actor, name: "Admission fixture", email: "admission@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active",
      initials: "AF", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
  }); } finally { await repository.close(); }
  const children = [];
  try {
    for (let index = 0; index < 6; index++) {
      const child = fork(fileURLToPath(import.meta.url), ["--child"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let readyResolve, resultResolve, fail;
      const ready = new Promise(resolveReady => { readyResolve = resolveReady; });
      const result = new Promise((resolveResult, reject) => { resultResolve = resolveResult; fail = reject; });
      // Attach rejection handlers immediately, including during barrier setup.
      result.catch(() => {});
      let received = false;
      const timer = setTimeout(() => { readyResolve(); fail(new Error("Bounded diagnostic child did not finish")); }, 80_000);
      child.on("message", message => {
        if (message?.type === "ready") readyResolve();
        else if (message?.type === "result") { received = true; clearTimeout(timer); resultResolve({ worker: index, ...message }); }
        else { clearTimeout(timer); readyResolve(); fail(new Error("Diagnostic child refused")); }
      });
      child.once("error", () => { clearTimeout(timer); fail(new Error("Diagnostic child unavailable")); readyResolve(); });
      child.once("exit", code => { clearTimeout(timer); if (code !== 0 || !received) fail(new Error("Diagnostic child did not close normally")); readyResolve(); });
      children.push({ child, ready, result });
    }
    await Promise.all(children.map(item => item.ready));
    for (const item of children) item.child.send({ config: session.config });
    const results = await Promise.all(children.map(item => item.result));
    const report = { profile: "source-functions-admission-diagnostic/v1", createdAt: new Date().toISOString(), node: process.version, transport: rest ? "preferRest" : "SDK-default",
      scope: "Six fresh source-runtime processes, literal empty model catalog, actual emulator storage; not native export, inference, ERP, deployment or SLO acceptance", results };
    const bytes = JSON.stringify(report, null, 2);
    for (const secret of [config.jwtSecret, config.storageEncryptionKey]) assert(!bytes.includes(secret));
    await writeFile(resolve(`../docs/evidence/2026-10-12/admission-stage-diagnostic${rest ? "-rest" : ""}${suffix}.json`), bytes + "\n", { flag: "wx" });
    for (const result of results) {
      const stages = Object.fromEntries(["registry", "writer-acquire", "client-close", "image-load", "mcp-runtime-open"].map(stage => {
        const values = result.events.filter(event => event.stage === stage);
        return [stage, { calls: values.length, totalMs: values.reduce((sum, event) => sum + event.durationMs, 0), outcomes: [...new Set(values.map(event => event.outcome))] }];
      }));
      console.log(JSON.stringify({ worker: result.worker, status: result.status, handlerMs: result.handlerMs, totalMs: result.totalMs, pending: result.pending, stages }));
    }
    assert(results.every(result => result.pending === 0), "Late acquisition cleanup remains pending; no acceptance claim");
    console.log("Diagnostic complete; inspect stage evidence. HTTP failures remain failures, not a native concurrency acceptance pass.");
  } finally {
    // Only the exact processes created here; never enumerate/kill other Node
    // processes, user servers or emulators. Fixtures cannot dispatch ERP work.
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
