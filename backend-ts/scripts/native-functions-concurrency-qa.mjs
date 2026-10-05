// Native causal gate: a fixed local model completion is held while a separate
// actual Functions mutation and fresh Firestore owner confirm its saved value.
// No app-only hooks, real inference, business writes, schedules or deployment.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { stringify } from "yaml";
import { completionBarrier } from "./native-functions-cancellation-qa.mjs";
import { nativeModelIds, startNativeModelFixture } from "./native-functions-model-qa.mjs";
import { qaWorkflowBlueprint } from "./erpbridge-workspace-qa.mjs";
import { assertChatTaskOutbox } from "../src/agent/chat-task-outbox.js";

export function concurrencyReportName(label) {
  assert(label === undefined || typeof label === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(label), "Use a bounded report label, never a path");
  return `native-held-model-concurrency${label === undefined ? "" : `-${label}`}.json`;
}

export async function observeHeldMutation(barrier, save, readback) {
  assert.equal(barrier.observation().released, false, "Model must be held before the independent mutation");
  const started = Date.now(), result = await save(), savedAt = Date.now();
  const savedWhileHeld = !barrier.observation().released;
  const visible = await readback(), readAt = Date.now();
  return { savedWhileHeld, visible, readWhileHeld: !barrier.observation().released,
    saveMs: savedAt - started, readbackMs: readAt - savedAt, totalMs: readAt - started, result };
}

export async function qualifyNativeConcurrency({ request, open, config, reportLabel }) {
  const reportName = concurrencyReportName(reportLabel), cases = [];
  const artifactSha256 = createHash("sha256").update(await readFile(resolve(".functions/index.mjs"))).digest("hex");
  let activeBarrier, heldCall;
  const fixture = await startNativeModelFixture(config, { beforeReply: async call => {
    if (activeBarrier && !activeBarrier.observation().entered) { heldCall = structuredClone(call); await activeBarrier.hold(); }
  } });
  const report = { profile: "native-held-model-concurrency/v1", createdAt: new Date().toISOString(), artifactSha256, passed: false,
    scope: "actual local Functions/Admin/encrypted Firestore and guarded Docker bridge; literal HTTP model, no external inference or business effect",
    budgets: { writerAdmissionMs: Number(config.FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS), fixtureHoldMs: 25_000, taskTimeoutMs: 60_000 }, cases,
    limit: "Only these held chat model waits are qualified; setup/policy/tool/runtime waits and load/cold-warm SLOs remain separate gates." };
  try {
    const expect = async (path, method, payload, status = 200) => {
      const result = await request("api", path, method, payload);
      assert.equal(result.status, status, result.body); assert(!result.body.includes(fixture.apiKey), "Provider credential escaped HTTP");
      return result.data.data;
    };
    const provider = await expect("/api/providers", "POST", { name: "LOCAL held concurrency fixture", type: "openai_compatible",
      baseUrl: fixture.baseUrl, apiKey: fixture.apiKey, model: nativeModelIds[0], temperature: 0,
      egressPolicy: { approvedOrigin: new URL(fixture.baseUrl).origin, confirmed: true, interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: ["internal"], runtimeAgentDataClasses: [] } }, 201);
    assert.equal((await expect(`/api/providers/${provider.id}/test`, "POST", {})).ok, true);
    await expect(`/api/providers/${provider.id}/activate`, "POST", {});
    const independent = await expect("/api/workflows", "POST", { yaml: stringify(qaWorkflowBlueprint()) }, 201);
    const chat = await expect("/api/chat/sessions", "POST", { title: "LOCAL held model concurrency", idempotencyKey: "native-concurrency-create-0001" }, 201);
    let generatedId;
    for (const kind of ["query", "generation", "node-proposal"]) {
      const item = { kind, passed: false }; cases.push(item);
      let source, nodeContext;
      if (kind === "node-proposal") {
        assert(generatedId, "Generation must save its original draft before a selected-node proposal");
        source = await expect(`/api/workflows/${generatedId}/yaml`, "GET");
        const readiness = await expect(`/api/workflows/${generatedId}/readiness`, "GET");
        nodeContext = { workflowId: generatedId, nodeId: "departments", baseVersion: readiness.version, baseHash: readiness.contentHash };
      }
      const payload = { content: kind === "query" ? "List the synthetic Departments from ERPBridge." : kind === "generation"
        ? "Create a local workflow to read synthetic Departments and count them with analysis." : "Describe this synthetic Department read more clearly.",
        model: nativeModelIds[0], delivery: "async-chat", idempotencyKey: `native-concurrency-${kind}-0001`, ...(nodeContext ? { nodeContext } : {}) };
      const barrier = completionBarrier(); activeBarrier = barrier; heldCall = undefined;
      try {
        const admitted = await expect(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
        assert.equal(admitted.taskDispatch, "ENQUEUED"); item.operationId = admitted.operation.id;
        const observing = new AbortController();
        try { await Promise.race([barrier.started, pause(20_000, undefined, { signal: observing.signal }).then(() => { throw new Error("Native model did not enter hold"); })]); }
        finally { observing.abort(); }
        item.heldCall = heldCall;
        assert.equal(heldCall?.model, nativeModelIds[0]);
        assert(heldCall.system.includes(kind === "query" ? "TASK: READ-ONLY ERP QUESTION" : kind === "generation" ? "TASK: WORKFLOW DRAFT SYNTHESIS" : "TASK: ONE SELECTED NODE PATCH"),
          "Only the intended chat inference phase, never a policy/preflight, may qualify this hold");
        const description = `Saved independently during ${kind}`;
        item.mutation = await observeHeldMutation(barrier,
          async () => {
            const started = Date.now(), response = await request("api", `/api/workflows/${independent.id}`, "PATCH", { description });
            item.patch = { status: response.status, code: response.data?.meta?.code ?? null, durationMs: Date.now() - started, modelReleased: barrier.observation().released };
            assert.equal(response.status, 200, "Independent native workflow PATCH must acknowledge its committed mutation while inference is held");
            return { description: response.data.data.description };
          },
          async () => { const repository = await open(); try { return await repository.readAuthoritative(state => state.workflows[independent.id]?.description === description); }
            finally { await repository.close(); } });
        item.barrierAtReadback = barrier.observation();
        assert(item.mutation.savedWhileHeld && item.mutation.readWhileHeld && item.mutation.visible && !item.barrierAtReadback.expired,
          "Independent save and fresh persisted readback must finish before releasing the original model");
        barrier.release(); activeBarrier = undefined;
        let operation; const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          operation = (await expect(`/api/chat/operations/${admitted.operation.id}`, "GET")).operation;
          if (!["QUEUED", "RUNNING"].includes(operation.status)) break;
          await pause(500);
        }
        item.terminal = operation?.status; assert.equal(operation?.status, "ANSWERED");
        const savedChat = await expect(`/api/chat/sessions/${chat.id}`, "GET"), message = savedChat.messages.find(value => value.id === operation.assistantMessageId);
        assert(message);
        if (kind === "query") assert.equal(message.artifacts.toolSteps[0].result.structuredContent.data.length, 8);
        if (kind === "generation") { generatedId = message.artifacts.workflowId; assert(generatedId); assert.equal((await expect(`/api/workflows/${generatedId}`, "GET")).publishedVersion, 0); }
        if (kind === "node-proposal") { assert.equal(message.artifacts.proposal.status, "PROPOSED"); assert.equal((await expect(`/api/workflows/${generatedId}/yaml`, "GET")).yaml, source.yaml, "Proposal must not implicitly apply"); }
        assert.equal((await expect(`/api/workflows/${independent.id}`, "GET")).description, description, "Original chat completion overwrote the independent save");
        const repository = await open(); let command;
        try { command = await repository.readAuthoritative(state => ({ profile: "chat-task-delivery/v1", operationId: operation.id, taskId: assertChatTaskOutbox(state.chatOperations[operation.id]).taskId })); }
        finally { await repository.close(); }
        const calls = fixture.calls.length, duplicate = await request("executeChatTask", "", "POST", { data: command }, false);
        assert.equal(duplicate.status, 204, duplicate.body); assert.equal(fixture.calls.length, calls, "Original delivery replayed the model");
        item.duplicate = { status: duplicate.status, additionalModelCalls: fixture.calls.length - calls }; item.passed = true;
        console.log(JSON.stringify({ gate: "native-held-model-save", kind, passed: true, saveMs: item.mutation.saveMs, readbackMs: item.mutation.readbackMs }));
      } finally { item.barrierAtExit = barrier.observation(); barrier.release(); activeBarrier = undefined; }
    }
    report.passed = cases.length === 3 && cases.every(item => item.passed);
  } finally {
    activeBarrier?.release();
    try { await fixture.close(); report.fixtureDisposalConfirmed = true; }
    catch (error) { report.fixtureDisposalConfirmed = false; report.passed = false; throw error; }
    finally { await writeFile(resolve("../docs/evidence/2026-10-12", reportName), JSON.stringify(report, null, 2) + "\n", { flag: "wx" }); }
  }
  assert(report.passed, "Native held-model concurrency is not accepted; inspect the retained report");
}
