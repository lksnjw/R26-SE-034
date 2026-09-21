import assert from "node:assert/strict";

// Actual demo Firestore persistence and HTTP/worker lifecycle, with deliberately
// synthetic MCP responses. Never a real ERP capability or external side effect.
export async function verifyFirestoreReadErrors({ request, repository, persistence, restart, setFixture, calls, models, operations, waitFor, log }) {
  await repository().mutate(state => {
    state.roles.read_error_viewer = { id: "read_error_viewer", name: "Own execution viewer", description: "Synthetic scope check", permissions: ["execution:read_own"], createdAt: new Date().toISOString() };
    state.users.read_error_viewer = { ...state.users.owner, id: "read_error_viewer", name: "Read-error viewer", roleId: "read_error_viewer", email: "read-error-viewer@example.test" };
  });
  for (const scenario of ["acknowledged", "pre-commit-loss", "post-commit-loss", "forged-error", "malformed", "transport-error"]) {
    const input = { id: `read-error-${scenario}` }, key = `firestore-read-error-${scenario}-0001`;
    const before = { calls: calls.length, models: models.length, operations: operations.length };
    setFixture(scenario);
    const writer = persistence().saveExecutionCheckpoint.bind(persistence());
    let lost = false;
    if (scenario.endsWith("commit-loss")) persistence().saveExecutionCheckpoint = async checkpoint => {
      if (!lost && checkpoint.execution?.failure?.failureCategory === "MCP_READ_TOOL_ERROR") {
        lost = true;
        if (scenario === "post-commit-loss") await writer(checkpoint);
        throw new Error("Synthetic failure-receipt storage acknowledgement loss");
      }
      return writer(checkpoint);
    };
    const id = (await request("POST", "/api/workflows/operation/run", { mode: "async-operation", idempotencyKey: key, input }, 202)).data.id;
    if (scenario.endsWith("commit-loss")) {
      await waitFor(() => lost, `${scenario} read-error checkpoint`);
      persistence().saveExecutionCheckpoint = writer;
      await repository().recoverPersistenceState();
    } else await waitFor(async () => ["FAILED", "RECONCILIATION_REQUIRED"].includes((await repository().snapshot()).executions[id]?.status), `${scenario} read-error outcome`);
    setFixture(undefined);
    await restart();
    const state = await repository().snapshot(), run = state.executions[id], known = ["acknowledged", "post-commit-loss"].includes(scenario);
    assert.equal(run.status, known ? "FAILED" : "RECONCILIATION_REQUIRED");
    assert.equal(run.failure.failureCategory, known ? "MCP_READ_TOOL_ERROR" : "OPERATION_OUTCOME_UNKNOWN");
    assert.equal(run.readProgress.attempts.lookup.status, known ? "FAILED" : "UNKNOWN");
    assert.equal(run.operationSecret.intents.lookup.state, known ? "ACKNOWLEDGED" : "UNKNOWN");
    assert.equal(run.operationSecret.intents.lookup.evidenceMeaning, known ? "read-tool-error" : undefined);
    assert.equal(run.stepOutputs.lookup, undefined); assert.equal(run.finalOutput, undefined); assert.equal(run.runtimeApprovalSecret, undefined);
    assert.equal(run.readProgress.nextStepIndex, 0);
    const timeline = state.timelines[id].find(entry => entry.nodeId === "lookup");
    assert.equal(timeline.status, known ? "FAILED" : "UNKNOWN");
    assert.equal(timeline.outcome, known ? "MCP_READ_TOOL_ERROR" : "UNKNOWN");
    if (known) assert.equal(timeline.output.isError, true); else assert.equal(timeline.output, undefined);
    assert(!JSON.stringify(timeline).includes("synthetic-error-secret"));
    const visible = (await request("GET", `/api/executions/${id}`, undefined, 200)).data;
    assert.equal(visible.status, run.status); assert(!JSON.stringify(visible).includes("operationSecret"));
    assert(!JSON.stringify(visible).includes("synthetic-error-secret"));
    await request("GET", `/api/executions/${id}`, undefined, 404, "read_error_viewer");
    const eventCount = state.executionEvents[id].length;
    const replay = await request("POST", "/api/workflows/operation/run", { mode: "async-operation", idempotencyKey: key, input }, 202);
    assert.equal(replay.data.id, id); assert.equal(replay.meta.replayed, true);
    await restart();
    assert.deepEqual((await repository().snapshot()).executions[id], run);
    assert.equal((await repository().snapshot()).executionEvents[id].length, eventCount);
    assert.equal(calls.length, before.calls + 1); assert.equal(models.length, before.models); assert.equal(operations.length, before.operations);
    log(`actual Firestore read error ${scenario}: owned ${known ? "failed acknowledged receipt" : "unknown intent"}, restart/replay, ACL and zero downstream/model/effect work`);
  }
}
