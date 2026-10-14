import assert from "node:assert/strict";
import { stringify } from "yaml";
import { assertConfirmedOperationResults } from "../src/runner/operation-result-evidence.js";

// Normal authenticated publish/run/approval and real encrypted demo Firestore.
// The reviewed MCP client is deliberately injected: no real ERP/email writes.
export async function verifyFirestoreProtectedOperations({ request, repository, persistence, restart, setReadHook, setFixture,
  businessErrorTool, operationTool, calls, models, operations, waitFor, log }) {
  const ref = (nodeId, ...path) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
  const scenarios = ["body-success", "handled", "approved-effect", ...["selection", "handler-result", "group-output", "return"]
    .flatMap(checkpoint => ["pre", "post"].map(phase => `${phase}-${checkpoint}`))];
  try {
    setReadHook(async args => setFixture(String(args.id).startsWith("protected-missing") ? "business-acknowledged" : undefined));
    for (const scenario of scenarios) {
      const workflowId = `protected_operation_${scenario.replaceAll("-", "_")}`, path = `/api/workflows/${workflowId}`;
      const effect = scenario === "approved-effect", missing = scenario !== "body-success", key = `firestore-protected-${scenario}-0001`;
      const input = { id: missing ? `protected-missing-${scenario}` : "protected-body-result" };
      const source = { name: `Protected operation ${scenario}`, description: "Reviewed resource lookup and owned explicit fallback",
        trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } } },
        steps: [{ id: "lookup", action: businessErrorTool.name, parameters: { id: "{{input.id}}" } },
          { id: "fallback", action: businessErrorTool.name, parameters: { id: "{{group.error.code}}" } },
          ...(effect ? [{ id: "send", action: operationTool.name, parameters: { id: "{{group.value}}" } }] : [])],
        metadata: { controlFlow: { schemaVersion: "read-control-flow/v4", root: { kind: "sequence", nodes: [
          { kind: "protect", id: "group", body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup" }] },
            handler: { kind: "sequence", nodes: [{ kind: "action", nodeId: "fallback" }] }, onError: { code: "ERP_RESOURCE_NOT_FOUND" },
            output: { schema: { type: "string" }, success: ref("lookup", "structuredContent", "id"), handled: ref("fallback", "structuredContent", "id") } },
          ...(effect ? [{ kind: "action", nodeId: "send" }] : []),
          { kind: "return", id: "answer", output: { schema: { type: "string" }, value: ref("group", "value") } },
        ] } } } };
      await repository().mutate(state => {
        state.workflows[workflowId] = { ...state.workflows.operation, id: workflowId, name: source.name, yaml: stringify(source),
          publishedVersion: 0, draftVersion: 1, status: "Draft", canRun: false, steps: source.steps.length };
        state.versions[workflowId] = [];
      });
      const before = { calls: calls.length, models: models.length, operations: operations.length };
      await request("POST", `${path}/publish`, {}, 200);
      const publication = (await repository().snapshot()).versions[workflowId].find(version => version.artifactState === "PUBLISHED");
      assert.equal(publication.compiledOperation.receipt.schemaVersion, "workflow-operation-ir/v8");
      assert.deepEqual({ calls: calls.length, models: models.length, operations: operations.length }, before);
      const storage = persistence(), writer = storage.saveExecutionCheckpoint.bind(storage); let lost = false;
      const phase = scenario.startsWith("pre-") ? "pre" : scenario.startsWith("post-") ? "post" : undefined;
      const checkpointName = phase ? scenario.slice(phase.length + 1) : undefined;
      if (phase) storage.saveExecutionCheckpoint = async checkpoint => {
        const run = checkpoint.execution;
        const matches = run?.workflowId === workflowId && (checkpointName === "selection" ? !!run.operationSecret?.protectedScopes?.group?.selection :
          checkpointName === "handler-result" ? run.readProgress?.attempts.fallback?.status === "DONE" :
          checkpointName === "group-output" ? !!run.valueOutputs?.group : run.readProgress?.values?.answer?.status === "DONE");
        if (!lost && matches) { lost = true; if (phase === "post") await writer(checkpoint); throw new Error("Synthetic protected checkpoint acknowledgement loss"); }
        return writer(checkpoint);
      };
      let id;
      try {
        id = (await request("POST", `${path}/run`, { mode: "async-operation", idempotencyKey: key, input }, 202)).data.id;
        if (phase) { await waitFor(() => lost, `${scenario} owned checkpoint`); storage.saveExecutionCheckpoint = writer; await repository().recoverPersistenceState(); }
        else if (effect) {
          await waitFor(async () => (await repository().snapshot()).executions[id].status === "AWAITING_APPROVAL", "protected exact approval wait");
          assert.equal(operations.length, before.operations); await restart();
          const review = (await request("GET", `/api/executions/${id}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
          assert.deepEqual(review.arguments, { id: "ERP_RESOURCE_NOT_FOUND" });
          await request("POST", `/api/executions/${id}/approve`, { approvalId: review.id, baseVersion: review.version,
            reviewHash: review.reviewHash, decisionKey: `firestore-${scenario}-approval-0001` }, 403);
          await request("POST", `/api/executions/${id}/approve`, { approvalId: review.id, baseVersion: review.version,
            reviewHash: review.reviewHash, decisionKey: `firestore-${scenario}-approval-0001` }, 200, "reviewer");
        }
        const unknown = scenario === "pre-selection" || scenario === "pre-handler-result";
        if (phase) await restart();
        try { await waitFor(async () => { const run = (await repository().snapshot()).executions[id];
          if (["FAILED", "CANCELLED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED"].includes(run.status) && run.status !== (unknown ? "RECONCILIATION_REQUIRED" : "DONE"))
            throw new Error(`Protected ${scenario} unexpected terminal: ${JSON.stringify({ status: run.status, failure: run.failure, summary: run.agentSummary,
              pointer: run.readProgress?.nextStepIndex, attempts: Object.fromEntries(Object.entries(run.readProgress?.attempts ?? {}).map(([id, attempt]) => [id, attempt.status])) })}`);
          return run.status === (unknown ? "RECONCILIATION_REQUIRED" : "DONE"); }, `${scenario} final owned outcome`); }
        catch (cause) { const state = await repository().snapshot(), run = state.executions[id];
          throw new Error(`Protected ${scenario} checkpoint failed: ${JSON.stringify({ status: run.status, jobState: run.operationSecret?.state,
            failure: run.failure, summary: run.agentSummary, pointer: run.readProgress?.nextStepIndex, groups: run.operationSecret?.protectedScopes,
            attempts: Object.fromEntries(Object.entries(run.readProgress?.attempts ?? {}).map(([id, attempt]) => [id, attempt.status])),
            events: state.executionEvents[id].map(event => event.type) })}`, { cause }); }
        const state = await repository().snapshot(), run = state.executions[id];
        if (unknown) {
          assert.equal(run.finalOutput, undefined); assert.equal(run.valueOutputs?.group, undefined);
          assert.equal(run.operationSecret.intents[scenario === "pre-selection" ? "lookup" : "fallback"].state, "UNKNOWN");
        } else {
          assert.equal(run.finalOutput, missing ? "ERP_RESOURCE_NOT_FOUND" : "PROTECTED-BODY-RESULT");
          assert.equal(run.operationSecret.protectedScopes.group.completion.outcome, missing ? "HANDLED_ERROR" : "SUCCEEDED");
          assert.equal(run.readProgress.attempts.lookup.status, missing ? "FAILED" : "DONE");
          assert.equal(run.readProgress.attempts.fallback.status, missing ? "DONE" : "SKIPPED");
          if (missing) { assert.equal(run.stepOutputs.lookup, undefined); assert.equal(run.operationSecret.intents.lookup.state, "ACKNOWLEDGED"); }
          assertConfirmedOperationResults(state, run, publication.compiledOperation.plan);
        }
        const readable = (await request("GET", `/api/executions/${id}`, undefined, 200)).data;
        assert.equal(readable.status, run.status); assert(!/operationSecret|protectedScopes|readBusinessFailure|synthetic-error-secret/.test(JSON.stringify(readable)));
        const count = state.executionEvents[id].length;
        const replay = await request("POST", `${path}/run`, { mode: "async-operation", idempotencyKey: key, input }, 202);
        assert.equal(replay.data.id, id); assert.equal(replay.meta.replayed, true);
        await restart(); assert.deepEqual((await repository().snapshot()).executions[id], run);
        assert.equal((await repository().snapshot()).executionEvents[id].length, count);
        assert.equal(calls.length, before.calls + (scenario === "body-success" || scenario === "pre-selection" ? 1 : 2));
        assert.equal(models.length, before.models); assert.equal(operations.length, before.operations + (effect ? 1 : 0));
        log(`actual Firestore protected ${scenario}: normal v8 publication/admission, ${unknown ? "retained unknown without replay" : "exact saved path/result"}, restart/replay and private receipt containment`);
      } finally { storage.saveExecutionCheckpoint = writer; }
    }
  } finally { setReadHook(undefined); setFixture(undefined); }
}
