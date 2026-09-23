import assert from "node:assert/strict";
import { stringify } from "yaml";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { publishProtectedOperation } from "../src/workflows/protected-operation-publication.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";

/** Actual encrypted emulator persistence and real provider client, with an
 * explicitly injected HTTP response. Not live inference or OS-process restart. */
export async function verifyFirestoreProtectedAnalysis({ repository, services, request, restart, calls, models, setFixture, setModelHook, waitFor, log }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671"); assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const provider = await request("POST", "/api/providers", { name: "Protected analysis fixture", type: "openai_compatible", baseUrl: "https://provider.fixture.example.test/v1",
    apiKey: "synthetic-protected-analysis-secret", model: "fixture-model-a", additionalModels: ["fixture-model-b"], temperature: 0,
    egressPolicy: { approvedOrigin: "https://provider.fixture.example.test", runtimeAnalysisDataClasses: ["restricted"], runtimeAgentDataClasses: [], interactiveDataClasses: [], confirmed: true } }, 201);
  await request("POST", `/api/providers/${provider.data.id}/activate`, {}, 200);
  const create = async name => {
    const workflowId = `protected_analysis_${name.replaceAll("-", "_")}`;
    await repository().mutate(state => {
      const source = parseWorkflowYAMLStrict(state.workflows.protected_collection_preparation.yaml), group = source.metadata.controlFlow.root.nodes[0].body.nodes[0];
      source.steps.splice(1, 0, { id: "analyse", kind: "analysis", instruction: "Analyse only the acknowledged item", input: "{{lookup.structuredContent.id}}",
        output_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, data_class: "restricted", model: "fixture-model-b" });
      group.body.nodes.push({ kind: "action", nodeId: "analyse" }); group.output.success = { kind: "ref", source: "nodeOutput", nodeId: "analyse", path: ["structuredContent", "id"] };
      state.workflows[workflowId] = { ...structuredClone(state.workflows.protected_collection_preparation), id: workflowId, yaml: stringify(source), steps: 3,
        draftVersion: 1, publishedVersion: 0, canRun: false }; state.versions[workflowId] = [];
    });
    const actor = await repository().effectiveUser("owner"), workflow = (await repository().snapshot()).workflows[workflowId];
    await publishProtectedOperation(services(), workflowId, actor, { baseVersion: 1, baseHash: workflowContentHash(workflow.yaml) });
    return { workflowId, key: `firestore-owned-analysis-${name}-0001` };
  };
  const admit = async scenario => admitProtectedOperation(services(), scenario.workflowId, await repository().effectiveUser("owner"), { rows: ["one", "two"] }, scenario.key);
  setFixture("success");
  try {
    const success = await create("success"), before = { calls: calls.length, models: models.length }, id = (await admit(success)).execution.id;
    assert.equal(calls.length, before.calls); assert.equal(models.length, before.models);
    const activeTimeout = services().providerRuntime.configuration.timeoutMs; await restart();
    assert.equal(services().providerRuntime.configuration.timeoutMs, activeTimeout, "Saved-provider startup must preserve the exact administration timeout");
    const result = await runProtectedOperation(services(), id); assert.equal(result.status, "DONE"); assert.deepEqual(result.finalOutput, ["ANALYSED-ONE", "ANALYSED-TWO"]);
    assert.deepEqual(result.tokens, { input: 22, output: 14, total: 36 }); assert.equal(calls.length - before.calls, 2); assert.equal(models.length - before.models, 2);
    const modelEvents = (await repository().snapshot()).executionEvents[id].filter(event => event.type === "node.analysis_completed");
    assert.equal(modelEvents.length, 2); assert(modelEvents.every(event => event.payload.measured === true && event.payload.inputTokens === 11 && event.payload.outputTokens === 7));
    assert.deepEqual(models.slice(before.models), ["fixture-model-b", "fixture-model-b"]); assert.equal(services().providerRuntime.configuration.model, "fixture-model-a");
    const stored = structuredClone((await repository().snapshot()).executions[id]); await restart(); assert.deepEqual((await repository().snapshot()).executions[id], stored);
    assert.equal((await admit(success)).execution.id, id); await runProtectedOperation(services(), id); assert.equal(models.length - before.models, 2);
    assert(!JSON.stringify(result).match(/synthetic-protected-analysis-secret|protectedJobSecret|admissionSeal/));
    log("actual Firestore protected analyses preserved distinct per-item answers, selected model and measured usage across server/repository reopen and original-key replay; administration default stayed unchanged");
    for (const name of ["preparing", "dispatch", "answer"]) for (const phase of ["before", "after"]) {
      const scenario = await create(`${phase}-${name}`), counts = { calls: calls.length, models: models.length }, runId = (await admit(scenario)).execution.id;
      const persistence = repository().persistence, writer = persistence.saveExecutionCheckpoint.bind(persistence); let injected = false;
      persistence.saveExecutionCheckpoint = async checkpoint => {
        const ledger = checkpoint.execution?.protectedInvocationSecret;
        const matched = ledger && (name === "answer" ? Object.values(ledger.receipts).some(row => row.boundary.invocationId === "each/0/analyse") :
          Object.values(ledger.intents).some(intent => intent.boundary.invocationId === "each/0/analyse" && intent.state === (name === "preparing" ? "PREPARING" : "DISPATCH_INTENT")));
        if (!injected && checkpoint.execution?.workflowId === scenario.workflowId && matched) { injected = true; if (phase === "after") await writer(checkpoint); throw new Error(`Synthetic analysis ${phase}-${name} COMMIT loss`); }
        return writer(checkpoint);
      };
      try { await assert.rejects(runProtectedOperation(services(), runId)); assert(injected); assert.throws(() => repository().assertAuthority()); }
      finally { persistence.saveExecutionCheckpoint = writer; }
      await repository().recoverPersistenceState(); await restart();
      await waitFor(async () => { const job = (await repository().snapshot()).executions[runId].protectedJobSecret; return job.state !== "CLAIMED" || job.lease.expiresAt <= Date.now(); }, "analysis worker natural lease expiry");
      const resumed = await runProtectedOperation(services(), runId), uncertain = name === "dispatch" && phase === "after" || name === "answer" && phase === "before";
      assert.equal(resumed.status, uncertain ? "RECOVERY_REQUIRED" : "DONE");
      assert.equal(calls.length - counts.calls, uncertain ? 1 : 2); assert.equal(models.length - counts.models, uncertain ? name === "dispatch" ? 0 : 1 : 2);
      if (!uncertain) assert.deepEqual(resumed.finalOutput, ["ANALYSED-ONE", "ANALYSED-TWO"]);
      const completed = models.length; await runProtectedOperation(services(), runId); assert.equal(models.length, completed);
      log(`actual Firestore analysis ${phase}-COMMIT ${name} loss produced ${resumed.status} without repeating earlier read/model calls`);
    }
    const yielded = await create("yield"), counts = { calls: calls.length, models: models.length }, yieldedId = (await admit(yielded)).execution.id, cp = await ProtectedJobCheckpoints.claim(services(), yieldedId);
    try { await cp.initialize(); for (;;) { const point = await cp.next(); if (point.kind === "action") await cp.executeAction(); else await cp.advanceControl(point); if (models.length > counts.models) break; } await cp.yield(); }
    finally { cp.close(); }
    await restart(); assert.equal((await runProtectedOperation(services(), yieldedId)).status, "DONE"); assert.equal(calls.length - counts.calls, 2); assert.equal(models.length - counts.models, 2);
    const invalid = await create("invalid"), invalidId = (await admit(invalid)).execution.id, modelCount = models.length; setFixture("invalid-json");
    const stopped = await runProtectedOperation(services(), invalidId); assert.equal(stopped.status, "RECOVERY_REQUIRED"); assert.equal(models.length - modelCount, 1);
    assert(!stopped.stepOutputs["each/0/analyse"]); assert(!stopped.stepOutputs["each/0/fallback"]);
    log("actual Firestore confirmed model answer yielded/resumed without replay; malformed model output stopped without selecting an ERP handler or next item");
    const unsafe = await create("unsafe-usage"), unsafeId = (await admit(unsafe)).execution.id, unsafeCount = models.length; setFixture("unsafe-usage");
    const unsafeResult = await runProtectedOperation(services(), unsafeId);
    assert.equal(unsafeResult.status, "RECOVERY_REQUIRED"); assert.equal(models.length - unsafeCount, 1);
    assert(!unsafeResult.stepOutputs["each/0/analyse"]); assert(!unsafeResult.stepOutputs["each/0/fallback"]);
    assert.deepEqual(unsafeResult.tokens, { input: 0, output: 0, total: 0 });
    await restart(); await runProtectedOperation(services(), unsafeId); assert.equal(models.length - unsafeCount, 1);
    log("actual Firestore unsafe measured usage retained no acknowledged model answer or fabricated counters and did not replay after reopen");
    const unmeasured = await create("unmeasured"), unmeasuredId = (await admit(unmeasured)).execution.id; setFixture("unmeasured");
    assert.equal((await runProtectedOperation(services(), unmeasuredId)).status, "DONE"); await restart();
    const unmeasuredEvents = (await repository().snapshot()).executionEvents[unmeasuredId].filter(event => event.type === "node.analysis_completed");
    assert.equal(unmeasuredEvents.length, 2);
    assert(unmeasuredEvents.every(event => event.payload.measured === false && !Object.hasOwn(event.payload, "inputTokens") && !Object.hasOwn(event.payload, "outputTokens")));
    log("actual Firestore unmeasured answers reopened with explicit unmeasured events, not fabricated zero-token measurements");
    const reactivated = await create("reactivated"), reactivatedId = (await admit(reactivated)).execution.id, reactivatedCount = models.length;
    setFixture("success"); let enter, release, signal;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    setModelHook(async (_request, requestSignal) => { signal = requestSignal; enter(); await held; });
    const work = runProtectedOperation(services(), reactivatedId);
    try {
      await entered; await request("POST", `/api/providers/${provider.data.id}/activate`, {}, 200);
      assert.equal(signal.aborted, true, "Administration reactivation must fence the old model wait immediately, without heartbeat or synthetic commit");
      const cancelled = await work; assert.equal(cancelled.status, "RECOVERY_REQUIRED"); assert(!cancelled.stepOutputs["each/0/analyse"]);
      assert.equal(models.length - reactivatedCount, 1);
    } finally { setModelHook(undefined); release(); }
    await restart(); await runProtectedOperation(services(), reactivatedId); assert.equal(models.length - reactivatedCount, 1);
    log("actual Firestore administration reactivation immediately aborted the old model wait and preserved unreplayed recovery across reopen");
  } finally { setFixture(undefined); }
}
