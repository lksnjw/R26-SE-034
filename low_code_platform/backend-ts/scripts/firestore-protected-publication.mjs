import assert from "node:assert/strict";
import { publishProtectedOperation, assertStoredProtectedOperationPublicationCurrent } from "../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../src/parser/workflow.js";

/** Actual encrypted-record persistence through the server-only v9 lifecycle.
 * Runs only inside the already guarded demo/loopback runtime campaign. It does
 * not expose publication over HTTP or qualify protected-loop dispatch. */
export async function verifyFirestoreProtectedPublication({ repository, services, request, restart, sourceId, calls, models, log }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records");
  assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const callsBefore = calls.length, modelsBefore = models.length;
  for (const phase of ["before", "after"]) {
    const id = `protected_publication_${phase}`;
    await repository().mutate(state => {
      state.workflows[id] = { ...structuredClone(state.workflows[sourceId]), id, draftVersion: 1, publishedVersion: 0, canRun: false };
      state.versions[id] = [];
    });
    const actor = await repository().effectiveUser((await repository().snapshot()).workflows[id].owner.id);
    const base = { baseVersion: 1, baseHash: workflowContentHash((await repository().snapshot()).workflows[id].yaml) };
    const persistence = repository().persistence, save = persistence.save.bind(persistence); let injected = false;
    persistence.save = async payload => {
      const versionCommit = JSON.parse(Buffer.from(payload).toString()).versions[id].some(value => value.protectedCompilationSecret);
      if (versionCommit && phase === "before" && !injected) { injected = true; throw new Error("Synthetic v9 pre-COMMIT failure"); }
      await save(payload);
      if (versionCommit && phase === "after" && !injected) { injected = true; throw new Error("Synthetic v9 post-COMMIT ACK loss"); }
    };
    try {
      await assert.rejects(publishProtectedOperation(services(), id, actor, base), error => error.status === 503 && error.meta?.code === "PROTECTED_PUBLICATION_UNCONFIRMED");
      assert(injected); assert.throws(() => repository().assertAuthority());
    } finally { persistence.save = save; }
    await repository().recoverPersistenceState(); await restart();
    assert.equal((await repository().snapshot()).versions[id].length, phase === "after" ? 1 : 0);
    const reopenedActor = await repository().effectiveUser(actor.id);
    const published = await publishProtectedOperation(services(), id, reopenedActor, base);
    const stored = structuredClone((await repository().snapshot()).versions[id]);
    assert.equal(published.executionReadiness, "COMPILED_PROTECTED_RUNTIME_PENDING");
    assert.equal(published.protectedCompilation.runtimeQualified, false); assert(!published.protectedCompilationSecret);
    assert.equal(stored.length, 1); assert.equal((await repository().snapshot()).workflows[id].canRun, false);
    await restart();
    assert.deepEqual((await repository().snapshot()).versions[id], stored);
    const plan = await repository().readAuthoritative(state => assertStoredProtectedOperationPublicationCurrent(state, services(), published.id, id, actor.role));
    assert.equal(plan.semanticHash, published.protectedCompilation.semanticHash);
    assert.deepEqual((await request("GET", `/api/workflows/${id}/versions`, undefined, 200)).data, [published]);
    const replayActor = await repository().effectiveUser(actor.id);
    assert.deepEqual(await publishProtectedOperation(services(), id, replayActor, base), published);
    assert.equal((await repository().snapshot()).versions[id].length, 1);
    await request("POST", `/api/workflows/${id}/publish`, base, 422);
    await request("POST", `/api/workflows/${id}/run`, { mode: "async-operation", input: { rows: ["fixture"] }, idempotencyKey: `protected-publication-never-run-${phase}` }, 422);
    assert.equal(calls.length, callsBefore); assert.equal(models.length, modelsBefore);
    log(`actual Firestore internal v9 publication ${phase}-COMMIT fault reconciled one immutable private receipt/plan after reopen; public versions hid private proof, replay added no version and normal publication/run remained closed with zero SDK/model calls`);
  }
}
