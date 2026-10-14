import assert from "node:assert/strict";
import { parse, stringify } from "yaml";

// Actual demo Firestore persistence and HTTP/worker lifecycle, with deliberately
// synthetic MCP responses. Never a real ERP capability or external side effect.
export async function verifyFirestoreReadErrors({ request, repository, persistence, restart, setFixture, businessErrorTool, calls, models, operations, waitFor, log }) {
  await repository().mutate(state => {
    state.roles.read_error_viewer = { id: "read_error_viewer", name: "Own execution viewer", description: "Synthetic scope check", permissions: ["execution:read_own"], createdAt: new Date().toISOString() };
    state.users.read_error_viewer = { ...state.users.owner, id: "read_error_viewer", name: "Read-error viewer", roleId: "read_error_viewer", email: "read-error-viewer@example.test" };
    const original = state.workflows.operation, source = parse(original.yaml);
    source.steps[0].action = businessErrorTool.name;
    state.workflows.business_read_error = { ...original, id: "business_read_error", name: "Reviewed business read-error fixture",
      yaml: stringify(source), publishedVersion: 0, draftVersion: 1, status: "Draft", canRun: false };
    state.versions.business_read_error = [];
  });
  await request("POST", "/api/workflows/business_read_error/publish", {}, 200);
  for (const scenario of ["acknowledged", "pre-commit-loss", "post-commit-loss", "forged-error", "malformed", "transport-error",
    "business-acknowledged", "business-pre-commit-loss", "business-post-commit-loss", "business-permission-denied", "business-contradictory",
    "business-malformed-hint", "business-protocol-error"]) {
    const business = scenario.startsWith("business-"), path = `/api/workflows/${business ? "business_read_error" : "operation"}/run`;
    const input = { id: `read-error-${scenario}` }, key = `firestore-read-error-${scenario}-0001`;
    const before = { calls: calls.length, models: models.length, operations: operations.length };
    setFixture(scenario);
    const writer = persistence().saveExecutionCheckpoint.bind(persistence());
    let lost = false;
    if (scenario.endsWith("commit-loss")) persistence().saveExecutionCheckpoint = async checkpoint => {
      if (!lost && checkpoint.execution?.failure?.failureCategory === "MCP_READ_TOOL_ERROR") {
        lost = true;
        if (scenario.endsWith("post-commit-loss")) await writer(checkpoint);
        throw new Error("Synthetic failure-receipt storage acknowledgement loss");
      }
      return writer(checkpoint);
    };
    const id = (await request("POST", path, { mode: "async-operation", idempotencyKey: key, input }, 202)).data.id;
    if (scenario.endsWith("commit-loss")) {
      await waitFor(() => lost, `${scenario} read-error checkpoint`);
      persistence().saveExecutionCheckpoint = writer;
      await repository().recoverPersistenceState();
    } else await waitFor(async () => ["FAILED", "RECONCILIATION_REQUIRED"].includes((await repository().snapshot()).executions[id]?.status), `${scenario} read-error outcome`);
    setFixture(undefined);
    await restart();
    const state = await repository().snapshot(), run = state.executions[id], known = !["pre-commit-loss", "forged-error", "malformed", "transport-error", "business-pre-commit-loss", "business-protocol-error"].includes(scenario);
    const classified = ["business-acknowledged", "business-post-commit-loss"].includes(scenario);
    assert.equal(run.status, known ? "FAILED" : "RECONCILIATION_REQUIRED");
    assert.equal(run.failure.failureCategory, known ? "MCP_READ_TOOL_ERROR" : "OPERATION_OUTCOME_UNKNOWN");
    assert.equal(run.readProgress.attempts.lookup.status, known ? "FAILED" : "UNKNOWN");
    assert.equal(run.operationSecret.intents.lookup.state, known ? "ACKNOWLEDGED" : "UNKNOWN");
    assert.equal(run.operationSecret.intents.lookup.evidenceMeaning, known ? "read-tool-error" : undefined);
    assert.equal(run.failure.businessErrorCode, classified ? "ERP_RESOURCE_NOT_FOUND" : undefined);
    const fault = run.operationSecret.intents.lookup.readBusinessFailure;
    if (classified) {
      assert.equal(fault.profile, "reviewed-read-business-failure/v1"); assert.equal(fault.code, "ERP_RESOURCE_NOT_FOUND");
      assert.equal(fault.toolId, businessErrorTool.tool_id);
      const revision = state.capabilityRevisions[fault.admissionPin.revisionId];
      assert.deepEqual(revision.definition.read_error_contract, businessErrorTool.read_error_contract);
      assert.equal(fault.contractHash, revision.contractHash); assert.equal(fault.admissionPin.contractHash, revision.contractHash);
      assert(run.failure.reason.includes("does not prove the record is absent"));
    } else assert.equal(fault, undefined);
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
    assert(!JSON.stringify(visible).includes("readBusinessFailure")); assert(!JSON.stringify(visible).includes("admissionPin"));
    assert.equal(visible.failure.businessErrorCode, classified ? "ERP_RESOURCE_NOT_FOUND" : undefined);
    await request("GET", `/api/executions/${id}`, undefined, 404, "read_error_viewer");
    const eventCount = state.executionEvents[id].length;
    const replay = await request("POST", path, { mode: "async-operation", idempotencyKey: key, input }, 202);
    assert.equal(replay.data.id, id); assert.equal(replay.meta.replayed, true);
    await restart();
    assert.deepEqual((await repository().snapshot()).executions[id], run);
    assert.equal((await repository().snapshot()).executionEvents[id].length, eventCount);
    assert.equal(calls.length, before.calls + 1); assert.equal(models.length, before.models); assert.equal(operations.length, before.operations);
    log(`actual Firestore read error ${scenario}: owned ${known ? "failed acknowledged receipt" : "unknown intent"}, restart/replay, ACL and zero downstream/model/effect work`);
  }
}
