import assert from "node:assert/strict";
import { publishProtectedOperation } from "../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";

/** Real emulator/database, original server publication, owned controller and
 * governed SDK fixture. Not normal HTTP v9 dispatch or business ERP evidence. */
export async function verifyFirestoreProtectedWorker({ repository, services, request, restart, calls, models, setReadHook, setFixture, waitFor, log }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const modelsBefore = models.length;
  const create = async name => {
    const workflowId = `protected_worker_${name.replaceAll("-", "_")}`;
    await repository().mutate(state => {
      state.workflows[workflowId] = { ...structuredClone(state.workflows.protected_collection_preparation), id: workflowId, draftVersion: 1, publishedVersion: 0, canRun: false };
      state.versions[workflowId] = [];
    });
    const actor = await repository().effectiveUser("owner"), workflow = (await repository().snapshot()).workflows[workflowId];
    await publishProtectedOperation(services(), workflowId, actor, { baseVersion: 1, baseHash: workflowContentHash(workflow.yaml) });
    return { workflowId, key: `firestore-protected-owned-${name}-0001` };
  };
  const admit = async (scenario, rows) => admitProtectedOperation(services(), scenario.workflowId, await repository().effectiveUser("owner"), { rows }, scenario.key);
  const runId = admitted => admitted.execution.id;
  setReadHook(async args => setFixture(String(args.id).startsWith("worker-missing") ? "business-acknowledged" : undefined));
  try {
    for (const [name, rows, expected] of [["success", ["one", "two"], ["ONE", "TWO"]], ["mixed", ["one", "worker-missing", "three"], ["ONE", "ERP_RESOURCE_NOT_FOUND", "THREE"]], ["empty", [], []]]) {
      const scenario = await create(name), before = calls.length, id = runId(await admit(scenario, rows));
      await restart();
      const result = await runProtectedOperation(services(), id); assert.equal(result.status, "DONE"); assert.deepEqual(result.finalOutput, expected);
      const stored = structuredClone((await repository().snapshot()).executions[id]);
      await restart(); assert.deepEqual((await repository().snapshot()).executions[id], stored);
      assert.equal((await admit(scenario, rows)).execution.id, id); assert.equal((await runProtectedOperation(services(), id)).status, "DONE");
      assert.equal(calls.length - before, name === "mixed" ? 4 : rows.length);
      assert(!JSON.stringify(result).match(/protectedJobSecret|protectedInvocationSecret|admissionSeal|synthetic-remote-secret|ciphertext/));
      const events = await request("GET", `/api/executions/${id}/events?after=0&limit=100`, undefined, 200);
      assert(events.data.events.some(event => event.type === "node.protected_boundary_confirmed"));
      assert(!JSON.stringify(events).match(/intentKey|protectedJobSecret|ciphertext/));
      log(`actual Firestore owned protected ${name} reads committed scoped answers and aggregate; server/repository reopen and original-key replay added no SDK call`);
    }
    const target = (checkpoint, name) => {
      const ledger = checkpoint.execution?.protectedInvocationSecret; if (!ledger) return false;
      if (name === "preparing" || name === "dispatch") return Object.values(ledger.intents).some(item => item.boundary.invocationId === "each/0/lookup" && item.state === (name === "preparing" ? "PREPARING" : "DISPATCH_INTENT"));
      return Object.values(ledger.receipts).some(row => row.boundary.kind === (name === "answer" ? "action" : name === "selection" ? "protected-select" :
        name === "group" ? "protected-complete" : name === "item" ? "collection-item" : name === "aggregate" ? "collection-complete" : "return") &&
        (name !== "answer" || row.boundary.invocationId === "each/0/lookup"));
    };
    for (const name of ["preparing", "dispatch", "answer", "selection", "group", "item", "aggregate", "return"]) for (const phase of ["before", "after"]) {
      const scenario = await create(`${phase}-${name}`), rows = [name === "selection" ? `worker-missing-${phase}` : `one-${phase}-${name}`, "two"];
      const before = calls.length, id = runId(await admit(scenario, rows)), persistence = repository().persistence, writer = persistence.saveExecutionCheckpoint.bind(persistence);
      let injected = false;
      persistence.saveExecutionCheckpoint = async checkpoint => {
        if (!injected && checkpoint.execution?.workflowId === scenario.workflowId && target(checkpoint, name)) {
          injected = true; if (phase === "after") await writer(checkpoint); throw new Error(`Synthetic ${phase}-COMMIT protected ${name} ACK loss`);
        }
        return writer(checkpoint);
      };
      try { await assert.rejects(runProtectedOperation(services(), id)); assert(injected); assert.throws(() => repository().assertAuthority()); }
      finally { persistence.saveExecutionCheckpoint = writer; }
      await repository().recoverPersistenceState(); await restart();
      // A fresh writer does not inherit or erase the old worker's live lease.
      // Wait for actual expiry; do not manufacture recovery by rewriting it.
      await waitFor(async () => {
        const job = (await repository().snapshot()).executions[id].protectedJobSecret;
        return job.state !== "CLAIMED" || job.lease.expiresAt <= Date.now();
      }, `protected ${phase}-${name} worker lease expiry`);
      const result = await runProtectedOperation(services(), id), uncertain = name === "dispatch" && phase === "after" || name === "answer" && phase === "before";
      assert.equal(result.status, uncertain ? "RECOVERY_REQUIRED" : "DONE");
      const dispatched = calls.slice(before);
      assert.equal(dispatched.filter(value => value === rows[0]).length, name === "dispatch" && phase === "after" ? 0 : 1);
      assert.equal(dispatched.filter(value => value === "two").length, uncertain ? 0 : 1);
      if (!uncertain) assert.deepEqual(result.finalOutput, [name === "selection" ? "ERP_RESOURCE_NOT_FOUND" : rows[0].toUpperCase(), "TWO"]);
      const count = calls.length; await runProtectedOperation(services(), id); assert.equal(calls.length, count);
      log(`actual Firestore ${phase}-COMMIT ${name} loss: authoritative reopen produced ${result.status}, preserved exact invocation results and did not repeat a call`);
    }
    for (const phase of ["before", "after"]) {
      const scenario = await create(`admission-${phase}`), rows = ["admission"], persistence = repository().persistence, writer = persistence.save.bind(persistence);
      let injected = false;
      persistence.save = async payload => {
        const matched = Object.values(JSON.parse(Buffer.from(payload).toString()).executions).some(run => run.workflowId === scenario.workflowId && run.protectedJobSecret);
        if (!injected && matched) { injected = true; if (phase === "after") await writer(payload); throw new Error("Synthetic admission ACK loss"); }
        return writer(payload);
      };
      try { await assert.rejects(admit(scenario, rows), error => error.status === 503); assert(injected); }
      finally { persistence.save = writer; }
      await repository().recoverPersistenceState(); await restart();
      const admitted = await admit(scenario, rows), id = runId(admitted); assert.equal(admitted.replayed, phase === "after");
      assert.equal((await runProtectedOperation(services(), id)).status, "DONE");
      assert.equal(Object.values((await repository().snapshot()).executions).filter(run => run.workflowId === scenario.workflowId).length, 1);
      log(`actual Firestore ${phase}-COMMIT admission ACK loss reconciled one original-key protected job`);
    }
    const scenario = await create("yield"), before = calls.length, id = runId(await admit(scenario, ["yield-one", "yield-two"])), cp = await ProtectedJobCheckpoints.claim(services(), id);
    try {
      await cp.initialize();
      for (;;) { const point = await cp.next(); if (point.kind === "action") { await cp.executeRead(); break; } await cp.advanceControl(point); }
      await cp.yield();
    } finally { cp.close(); }
    await restart(); assert.equal((await runProtectedOperation(services(), id)).status, "DONE"); assert.equal(calls.length - before, 2);
    assert.equal(models.length, modelsBefore);
    log("actual Firestore clean boundary yield/fresh worker resume retained original item receipts without repeating reads; no model/effect/normal v9 HTTP qualification is claimed");
  } finally { setReadHook(undefined); setFixture(undefined); }
}
