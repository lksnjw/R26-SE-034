import assert from "node:assert/strict";
import { stringify } from "yaml";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { publishProtectedOperation } from "../src/workflows/protected-operation-publication.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";

/** Actual encrypted emulator checkpoints/reopen; SDK and model responses are
 * explicitly injected. No live inference, business effect or OS-process proof. */
export async function verifyFirestoreProtectedAgent({ repository, services, request, restart, calls, models, tool, setFixture, setReadFixture, setReadHook, setModelHook, waitFor, log }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671"); assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const provider = await request("POST", "/api/providers", { name: "Protected agent fixture", type: "openai_compatible", baseUrl: "https://provider.fixture.example.test/v1",
    apiKey: "synthetic-protected-agent-secret", model: "fixture-model-a", additionalModels: ["fixture-model-b"], temperature: 0,
    egressPolicy: { approvedOrigin: "https://provider.fixture.example.test", runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: ["restricted"], interactiveDataClasses: [], confirmed: true } }, 201);
  await request("POST", `/api/providers/${provider.data.id}/activate`, {}, 200);
  const create = async name => {
    const workflowId = `protected_agent_${name.replaceAll("-", "_")}`;
    await repository().mutate(state => {
      const source = parseWorkflowYAMLStrict(state.workflows.protected_collection_preparation.yaml), group = source.metadata.controlFlow.root.nodes[0].body.nodes[0];
      source.steps.splice(1, 0, { id: "agent", kind: "agent", instruction: "Use only one reviewed read and return its acknowledged identifier", input: "{{lookup.structuredContent.id}}",
        output_schema: { type: "object", properties: { id: { type: "string" }, complete: { type: "boolean" } }, required: ["id", "complete"], additionalProperties: false },
        data_class: "restricted", model: "fixture-model-b", allowed_actions: [tool.name], completion_predicate: { path: ["complete"], equals: true },
        max_rounds: 2, max_tool_calls: 1, max_wall_time_ms: 120000 });
      group.body.nodes.push({ kind: "action", nodeId: "agent" }); group.output.success = { kind: "ref", source: "nodeOutput", nodeId: "agent", path: ["structuredContent", "id"] };
      state.workflows[workflowId] = { ...structuredClone(state.workflows.protected_collection_preparation), id: workflowId, yaml: stringify(source), steps: 3,
        draftVersion: 1, publishedVersion: 0, canRun: false }; state.versions[workflowId] = [];
    });
    const actor = await repository().effectiveUser("owner"), workflow = (await repository().snapshot()).workflows[workflowId];
    await publishProtectedOperation(services(), workflowId, actor, { baseVersion: 1, baseHash: workflowContentHash(workflow.yaml) });
    return { workflowId, key: `firestore-owned-agent-${name}-0001` };
  };
  const admit = async (scenario, rows = ["one"]) => admitProtectedOperation(services(), scenario.workflowId, await repository().effectiveUser("owner"), { rows }, scenario.key);
  const successResponse = request => {
    const input = JSON.parse(request.messages[1].content).INPUT, answered = request.messages.some(row => row.role === "tool");
    const result = answered ? JSON.parse(request.messages.findLast(row => row.role === "tool").content).data.structuredContent.id : undefined;
    return Response.json({ choices: [{ finish_reason: answered ? "stop" : "tool_calls", message: answered ? { content: JSON.stringify({ id: result, complete: true }) } : {
      content: null, tool_calls: [{ id: `agent-${input}`, type: "function", function: { name: exactBridgeName(tool), arguments: JSON.stringify({ id: `agent-${input.toLowerCase()}` }) } }] } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  };
  setFixture(successResponse);
  try {
    const successful = await create("success"), counts = { calls: calls.length, models: models.length }, id = (await admit(successful, ["one", "two"])).execution.id;
    await restart(); const done = await runProtectedOperation(services(), id);
    assert.equal(done.status, "DONE"); assert.deepEqual(done.finalOutput, ["AGENT-ONE", "AGENT-TWO"]); assert.deepEqual(done.tokens, { input: 44, output: 28, total: 72 });
    assert.deepEqual(calls.slice(counts.calls), ["one", "agent-one", "two", "agent-two"]); assert.equal(models.length - counts.models, 4);
    assert(models.slice(counts.models).every(model => model === "fixture-model-b")); assert.equal(services().providerRuntime.configuration.model, "fixture-model-a");
    const stored = structuredClone((await repository().snapshot()).executions[id]); await restart(); assert.deepEqual((await repository().snapshot()).executions[id], stored);
    assert.equal((await admit(successful, ["one", "two"])).execution.id, id); await runProtectedOperation(services(), id); assert.equal(models.length - counts.models, 4);
    assert(!JSON.stringify(done).match(/synthetic-protected-agent-secret|protectedAgentSecret|admissionSeal/));
    log("actual Firestore agent kept distinct per-item dialogue, two selected-model turns/one governed read, recorded usage and original-key replay across reopen");
    const stages = ["initialize", "model0-preparing", "model0-dispatch", "model0-answer", "tool-preparing", "tool-dispatch", "tool-answer", "model1-preparing", "model1-dispatch", "model1-answer"];
    for (const stage of stages) for (const phase of ["before", "after"]) {
      const scenario = await create(`${phase}-${stage}`), before = { calls: calls.length, models: models.length }, runId = (await admit(scenario)).execution.id;
      const persistence = repository().persistence, writer = persistence.saveExecutionCheckpoint.bind(persistence); let injected = false;
      persistence.saveExecutionCheckpoint = async checkpoint => {
        const run = checkpoint.execution, records = run?.protectedAgentSecret, ledger = run?.protectedInvocationSecret;
        const matched = stage === "initialize" ? records?.invocations["each/0/agent"] && !Object.values(ledger.intents).some(item => item.boundary.nodeId === "agent") :
          stage.endsWith("answer") ? Object.values(stage.startsWith("tool") ? records?.results ?? {} : records?.turns ?? {}).some(row => row.invocationId === "each/0/agent" &&
            (stage.startsWith("tool") || row.round === Number(stage[5]))) :
          Object.values(ledger?.intents ?? {}).some(item => item.boundary.invocationId === "each/0/agent" && item.component.kind === (stage.startsWith("tool") ? "agent-tool" : "agent-model") &&
            (stage.startsWith("tool") || item.component.round === Number(stage[5])) && item.state === (stage.endsWith("preparing") ? "PREPARING" : "DISPATCH_INTENT"));
        if (!injected && run?.workflowId === scenario.workflowId && matched) { injected = true; if (phase === "after") await writer(checkpoint); throw new Error(`Synthetic agent ${phase}-${stage} COMMIT loss`); }
        return writer(checkpoint);
      };
      try { await assert.rejects(runProtectedOperation(services(), runId)); assert(injected); assert.throws(() => repository().assertAuthority()); }
      finally { persistence.saveExecutionCheckpoint = writer; }
      await repository().recoverPersistenceState(); await restart();
      await waitFor(async () => { const job = (await repository().snapshot()).executions[runId].protectedJobSecret; return job.state !== "CLAIMED" || job.lease.expiresAt <= Date.now(); }, "agent worker natural lease expiry");
      const uncertain = stage.endsWith("dispatch") && phase === "after" || stage.endsWith("answer") && phase === "before";
      const resumed = await runProtectedOperation(services(), runId); assert.equal(resumed.status, uncertain ? "RECOVERY_REQUIRED" : "DONE");
      if (!uncertain) { assert.deepEqual(resumed.finalOutput, ["AGENT-ONE"]); assert.equal(calls.length - before.calls, 2); assert.equal(models.length - before.models, 2); }
      else {
        assert.equal(calls.length - before.calls, stage.startsWith("model0") ? 1 : stage.startsWith("tool") ? stage.endsWith("dispatch") ? 1 : 2 : 2);
        assert.equal(models.length - before.models, stage.startsWith("model0") ? stage.endsWith("dispatch") ? 0 : 1 : stage.startsWith("tool") ? 1 : stage.endsWith("dispatch") ? 1 : 2);
      }
      const confirmed = { calls: calls.length, models: models.length }; await runProtectedOperation(services(), runId); assert.equal(calls.length, confirmed.calls); assert.equal(models.length, confirmed.models);
      log(`actual Firestore agent ${phase}-COMMIT ${stage} loss retained ${resumed.status}, original identity and no repeated confirmed sub-call`);
    }
    for (const stage of ["model", "tool"]) {
      const scenario = await create(`yield-${stage}`), before = { calls: calls.length, models: models.length }, runId = (await admit(scenario)).execution.id, cp = await ProtectedJobCheckpoints.claim(services(), runId);
      try {
        await cp.initialize(); for (;;) { const point = await cp.next(); if (point.nodeId === "agent") break; if (point.kind === "action") await cp.executeAction(); else await cp.advanceControl(point); }
        await cp.executeAgentBoundary(); if (stage === "tool") await cp.executeAgentBoundary(); await cp.yield();
      } finally { cp.close(); }
      await restart(); assert.equal((await runProtectedOperation(services(), runId)).status, "DONE"); assert.equal(calls.length - before.calls, 2); assert.equal(models.length - before.models, 2);
      log(`actual Firestore clean dialogue yield after ${stage} resumed at next original sub-call without replay`);
    }
    const missing = await create("business-absence"), missingBefore = { calls: calls.length, models: models.length }, missingId = (await admit(missing)).execution.id;
    setReadHook(async args => setReadFixture(args.id === "agent-one" ? "business-not-found" : undefined));
    const handled = await runProtectedOperation(services(), missingId); assert.equal(handled.status, "DONE"); assert.deepEqual(handled.finalOutput, ["ERP_RESOURCE_NOT_FOUND"]);
    assert.equal(calls.length - missingBefore.calls, 3); assert.equal(models.length - missingBefore.models, 1);
    setReadHook(undefined); setReadFixture(undefined); await restart(); await runProtectedOperation(services(), missingId); assert.equal(models.length - missingBefore.models, 1);
    log("actual Firestore genuine dynamic read absence preserved its exact agent-tool fault/artifact and selected only the authored handler across reopen");
    const malformed = await create("malformed-final"), malformedBefore = { calls: calls.length, models: models.length }, malformedId = (await admit(malformed)).execution.id;
    setFixture(request => request.messages.some(row => row.role === "tool") ? Response.json({ choices: [{ finish_reason: "stop", message: { content: "Invalid JSON" } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 } }) : successResponse(request));
    const stopped = await runProtectedOperation(services(), malformedId); assert.equal(stopped.status, "RECOVERY_REQUIRED"); assert.equal(calls.length - malformedBefore.calls, 2);
    assert.equal(models.length - malformedBefore.models, 2); assert(!stopped.stepOutputs["each/0/agent"]); assert(!stopped.stepOutputs["each/0/fallback"]);
    await restart(); await runProtectedOperation(services(), malformedId); assert.equal(models.length - malformedBefore.models, 2);
    log("actual Firestore malformed final model preserved confirmed read/turn history and unreplayed recovery without entering an ERP handler");
    setFixture(successResponse);
  } finally { setFixture(undefined); setReadFixture(undefined); setReadHook(undefined); setModelHook(undefined); }
}
