import assert from "node:assert/strict";
import { operationJobQueue } from "../src/runner/operation-jobs.js";
import { assertConfirmedOperationResults } from "../src/runner/operation-result-evidence.js";

// Real demo Firestore/HTTP/restart, deliberately injected MCP/provider clients.
// This verifies queue denial, not public protected-handler availability or ERP.
export async function verifyFirestoreOperationClaims({ request, repository, services, persistence, restart, calls, models, operations, waitFor, log }) {
  const initial = await repository().snapshot();
  const done = Object.values(initial.executions).find(run => run.workflowId === "operation" && run.status === "DONE");
  assert(done); const publication = initial.versions.operation.find(version => version.version === done.workflowSnapshot.version && version.artifactState === "PUBLISHED");
  assertConfirmedOperationResults(initial, done, publication.compiledOperation.plan);
  for (const scenario of ["normal", "pre-commit-loss", "post-commit-loss"]) {
    await operationJobQueue(services()).stop();
    await repository().mutate(state => {
      state.users.queue_subject = { ...state.users.owner, id: "queue_subject", name: "Queue subject", email: "queue-subject@example.test", status: "Active" };
    });
    const before = { calls: calls.length, models: models.length, operations: operations.length };
    const id = (await request("POST", "/api/workflows/operation/run", { mode: "async-operation", idempotencyKey: `firestore-claim-${scenario}-0001`, input: { id: "not-dispatched" } }, 202, "queue_subject")).data.id;
    assert.equal((await repository().snapshot()).executions[id].status, "PENDING");
    await repository().mutate(state => { state.users.queue_subject.status = "Disabled"; });
    const writer = persistence().saveExecutionCheckpoint.bind(persistence()); let lost = false;
    if (scenario !== "normal") persistence().saveExecutionCheckpoint = async checkpoint => {
      if (!lost && checkpoint.execution?.failure?.failureCategory === "OPERATION_CLAIM_AUTHORITY_CHANGED") {
        lost = true;
        if (scenario === "post-commit-loss") await writer(checkpoint);
        throw new Error("Synthetic queued claim-denial acknowledgement loss");
      }
      return writer(checkpoint);
    };
    const queue = operationJobQueue(services());
    try {
      await queue.start();
      if (scenario !== "normal") {
        await waitFor(() => lost, `${scenario} claim refusal checkpoint`);
        persistence().saveExecutionCheckpoint = writer;
        await repository().recoverPersistenceState();
      } else await waitFor(async () => (await repository().snapshot()).executions[id].status === "FAILED", "queued authority refusal");
    } finally { persistence().saveExecutionCheckpoint = writer; await queue.stop(); }
    await restart();
    await waitFor(async () => (await repository().snapshot()).executions[id].status === "FAILED", "restart terminal claim refusal");
    const state = await repository().snapshot(), run = state.executions[id];
    assert.equal(run.failure.failureCategory, "OPERATION_CLAIM_AUTHORITY_CHANGED"); assert.equal(run.operationSecret.state, "FINISHED");
    assert.deepEqual(run.operationSecret.intents, {}); assert.deepEqual(run.readProgress.attempts, {}); assert.deepEqual(run.stepOutputs, {});
    assert.equal(state.executionEvents[id].filter(event => event.type === "run.failed").length, 1);
    assert.equal(state.executionEvents[id].filter(event => event.type === "run.started").length, 0);
    const readable = (await request("GET", `/api/executions/${id}`, undefined, 200)).data;
    assert.equal(readable.status, "FAILED"); assert.equal(readable.operationSecret, undefined);
    assert.deepEqual({ calls: calls.length, models: models.length, operations: operations.length }, before);
    log(`actual Firestore queued authority refusal ${scenario}: one terminal outcome after restart, zero SDK/model/effect entry and no claim retry spin`);
  }
}
